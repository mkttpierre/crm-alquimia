/**
 * Entrada de webhook do canal Evolution — do corpo cru até a ingestão do WAHA.
 *
 * Chamado por `handleInboundWebhook` (../inbound.ts), que é quem a rota neutra
 * `webhooks/channel/[token]` e a rota `webhooks/evolution/[token]` invocam. A
 * rota não sabe de quem é o payload; aqui sabemos.
 *
 * ─── Autenticação ─────────────────────────────────────────────────────────────
 * A Evolution não assina o corpo. A credencial de entrada é o TOKEN DO CAMINHO
 * (`channel_sessions.webhook_path_token`, 32 hex gerados por nós): quem não o
 * conhece não chega aqui, e a rota já resolveu a sessão e a ORGANIZAÇÃO a partir
 * dele — nunca do corpo. É o mesmo contrato da rota `/waha/[token]`.
 *
 * Em cima do token entra uma conferência de CONSISTÊNCIA: o `instance` do payload
 * tem que ser o da sessão. Evento de outra instância caindo neste token é
 * webhook mal apontado (configuração trocada), e processá-lo gravaria mensagem
 * de um chip na conversa de outro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { randomUUID } from "node:crypto";

import { atenderEntradas } from "@/lib/disparo/atendimento/gancho";
import { registrarConexoes, registrarEntregas } from "@/lib/disparo/saude-eventos";
import { logger } from "@/lib/logger";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

import type { InboundWebhookOutcome } from "../inbound";
import { registrarLigacoes } from "./ligacoes";
import { lerEnvelopeEvolution, traduzirEvento } from "./webhook";

export interface EvolutionInboundInput {
  session: { id: string; organization_id: string };
  rawBody: string;
}

export async function ingestEvolutionInbound(
  admin: SupabaseClient,
  input: EvolutionInboundInput,
): Promise<InboundWebhookOutcome> {
  const leitura = lerEnvelopeEvolution(input.rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, code: "invalid_json", message: "invalid_json" };
    }
    return {
      ok: false,
      code: "contrato_violado",
      message: `payload fora do contrato do canal: ${leitura.campos.join(", ")}`,
    };
  }
  const envelope = leitura.envelope;

  // A sessão é relida AQUI, por id e organização (ambos já confiáveis): a rota
  // não carrega colunas de canal, e o dispatch do WAHA precisa do estado de
  // warm-up para fechar o aquecimento quando a instância volta a `open`.
  const { data: sessao, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, evolution_instance_name, is_warmup_complete, warmup_started_at, phone_number")
    .eq("id", input.session.id)
    .eq("organization_id", input.session.organization_id)
    .maybeSingle();
  if (error) throw new Error(`evolution_session_lookup_failed: ${error.message}`);
  if (!sessao) return { ok: true, body: { status: "ignored", reason: "sessao_inexistente" } };

  if (sessao.evolution_instance_name !== envelope.instance) {
    logger.warn("evolution.webhook: instância do payload diverge da sessão do token", {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
    });
    // 200, não 4xx: o provider reentregaria para sempre um evento que nunca vai
    // servir. O motivo vai no corpo e no arquivo do webhook (campo `erro`).
    return { ok: true, body: { status: "ignored", reason: "instancia_divergente" } };
  }

  const traduzido = traduzirEvento(envelope);
  // Freio de saúde do chip: conexão vista (close, 428, logout, reconexão). Nunca lança.
  await registrarConexoes(admin, sessao.organization_id as string, sessao.id as string, traduzido.conexoes);
  if (traduzido.ignorado) {
    return { ok: true, body: { status: "ignored", reason: "evento_sem_interesse" } };
  }

  const requestId = randomUUID();
  for (const e of [...traduzido.envelopes, ...traduzido.falhas]) {
    await dispatchWahaEvent(
      admin as Parameters<typeof dispatchWahaEvent>[0],
      {
        id: sessao.id as string,
        organization_id: sessao.organization_id as string,
        is_warmup_complete: (sessao.is_warmup_complete as boolean | null) ?? null,
        warmup_started_at: (sessao.warmup_started_at as string | null) ?? null,
      },
      e,
      requestId,
    );
  }

  // Ligação vira NOTA de tela (`type=system`), nunca mensagem — e por isso fica
  // fora dos envelopes que seguem para o motor e para o atendimento. Nunca lança.
  const ligacoes = traduzido.ligacoes.length
    ? await registrarLigacoes(
        admin,
        {
          id: sessao.id as string,
          organization_id: sessao.organization_id as string,
          phone_number: (sessao.phone_number as string | null) ?? null,
        },
        traduzido.ligacoes,
      )
    : 0;

  // Freio de saúde do chip: status de entrega (1 tique, entregue, lido) dos envios do motor. Nunca lança.
  await registrarEntregas(admin, sessao.organization_id as string, traduzido.envelopes);

  // Resposta de lead pelos chips do motor de disparo: o atendimento decide o
  // próximo passo (só grava fila e aviso na Central; nunca fala com o canal).
  // Nunca lança — a mensagem já foi gravada acima e o 200 segue.
  await atenderEntradas(admin, sessao.organization_id as string, traduzido.envelopes);

  return {
    ok: true,
    body: {
      status: "processed",
      eventos: traduzido.envelopes.length,
      // Contado e devolvido, nunca engolido: descarte mudo com carimbo de 200 é
      // o defeito que o contrato do fio existe para evitar.
      descartados: traduzido.descartados,
      // Só quando houve: o corpo do lote normal não muda.
      ...(traduzido.semId > 0 ? { sem_id: traduzido.semId } : {}),
      ...(traduzido.ligacoes.length > 0 ? { ligacoes } : {}),
    },
  };
}
