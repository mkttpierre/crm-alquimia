/**
 * Gancho de entrada: depois que a ingestão gravou a mensagem do lead, o
 * atendimento decide o próximo passo. Chamado só pela entrada do canal dos
 * chips do motor de disparo (dentro de `lib/channels/`, que é quem pode nomear
 * provider); as outras entradas de canal não passam por aqui.
 *
 * NUNCA derruba o webhook: qualquer erro vira log e o 200 da ingestão segue (a
 * mensagem já está gravada; reprocessar é rodar de novo a leitura, que é
 * idempotente pela chave). A organização vem da sessão resolvida pelo token do
 * caminho, nunca do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import { atenderMensagem } from "./atendimento";
import { criarJulgar } from "./jev";
import { repositorioAtendimentoSupabase } from "./repositorio-supabase";

type EnvelopeDeEntrada = { event?: string | null; payload?: { id?: string | null; fromMe?: boolean | null } | null };

/** Falha numa etapa do gancho: vira log com contexto (organização, mensagem, etapa), nunca exceção para o webhook. */
function registrarFalha(org: string, etapa: string, externalId: string | null, e: unknown): void {
  const detalhe = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  logger.error("disparo.atendimento: entrada não atendida", {
    organization_id: org,
    etapa,
    ...(externalId ? { external_id: externalId } : {}),
    detail: detalhe.slice(0, 200),
  });
}

export async function atenderEntradas(admin: SupabaseClient, org: string, envelopes: EnvelopeDeEntrada[]): Promise<number> {
  const ids = envelopes
    .filter((e) => (e.event === "message" || e.event === "message.any") && e.payload?.fromMe === false && e.payload.id)
    .map((e) => e.payload!.id!);
  if (!ids.length) return 0;
  let atendidas = 0;
  let etapa = "disparo_config";
  try {
    // Organização sem atendimento ligado: nada a fazer (e nenhuma consulta a mais por mensagem).
    const { data: cfg, error: erroCfg } = await admin.from("disparo_config").select("atendimento").eq("organization_id", org).maybeSingle();
    if (erroCfg) {
      registrarFalha(org, "disparo_config", null, erroCfg);
      return 0;
    }
    if (!(cfg?.atendimento as { ligado?: unknown } | null)?.ligado) return 0;

    etapa = "montagem";
    const deps = {
      repo: repositorioAtendimentoSupabase(admin),
      agora: new Date(),
      ambiente: { DISPARO_REAL_LIBERADO: env.DISPARO_REAL_LIBERADO },
      julgar: criarJulgar({ chave: env.OPENROUTER_API_KEY, modelo: env.JEV_MODELO }),
    };
    for (const externalId of ids) {
      // Cada mensagem tem o próprio try/catch: o erro de uma (consulta ou atendimento) não corta as seguintes do lote,
      // que não seriam reprocessadas (o webhook já devolveu 200 e a leitura não foi reservada).
      etapa = "messages";
      try {
        const { data: msg, error: erroMsg } = await admin
          .from("messages")
          .select("id, contact_id, conversation_id, body")
          .eq("organization_id", org)
          .eq("external_id", externalId)
          .eq("direction", "inbound")
          .maybeSingle();
        if (erroMsg) {
          registrarFalha(org, "messages", externalId, erroMsg);
          continue;
        }
        if (!msg?.contact_id) continue;
        etapa = "crm_leads";
        const { data: lead, error: erroLead } = await admin
          .from("crm_leads")
          .select("id")
          .eq("organization_id", org)
          .eq("contact_id", msg.contact_id)
          .eq("status", "open")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (erroLead) {
          registrarFalha(org, "crm_leads", externalId, erroLead);
          continue;
        }
        if (!lead) continue;
        etapa = "atendimento";
        const texto = (msg.body as string | null)?.trim() || null;
        const r = await atenderMensagem(deps, org, lead.id as string, {
          chave: externalId,
          messageId: msg.id as string,
          texto,
          midia: !texto,
          conversationId: (msg.conversation_id as string | null) ?? null,
        });
        if (r.resultado === "decidida") atendidas++;
      } catch (e) {
        registrarFalha(org, etapa, externalId, e);
      }
    }
  } catch (e) {
    registrarFalha(org, etapa, null, e);
  }
  return atendidas;
}
