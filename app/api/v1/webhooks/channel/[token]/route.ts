/**
 * POST /api/v1/webhooks/channel/[token] — entrada por token, para qualquer canal.
 *
 * ─── Por que o caminho NÃO cita o canal ─────────────────────────────────────
 *
 * A família de rotas do canal por QR carrega o nome do provider na URL, e está
 * na lista de dívida do `lint:channels` por isso — sair de lá exigiria mudar
 * uma URL que já está configurada em instalação de gente. Uma rota NOVA não
 * precisa nascer devendo: o token identifica a sessão, a sessão diz qual é o
 * canal, e o caminho fica neutro. Canal seguinte entra sem uma quarta família
 * de URLs.
 *
 * ─── Por que esta rota é tão curta ──────────────────────────────────────────
 *
 * Ela não sabe de quem é o payload. Resolve o token, decifra o segredo e
 * entrega tudo a `handleInboundWebhook` — a verificação de assinatura e a
 * leitura moram lá porque o esquema é do CANAL (header, algoritmo e formato
 * mudam por provider). A primeira versão desta rota fazia isso aqui e o
 * `lint:channels` reprovou, que é a catraca funcionando: uma rota que verifica
 * assinatura precisa perguntar qual provider é.
 *
 * ─── O 200 que evita a tempestade ──────────────────────────────────────────
 *
 * Evento que não interessa (outro tipo, eco do nosso próprio envio, outra
 * plataforma) responde 200, não 4xx: o provider reentrega o que não recebeu
 * 200, e recusar um payload que nunca vai servir faria a reentrega durar para
 * sempre. 500 fica reservado para falha de ESCRITA — aí a reentrega é o que
 * queremos, porque o evento era bom e nós é que não gravamos.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  abrirArquivoDoWebhook,
  fecharArquivoDoWebhook,
} from "@/lib/channels/arquivo-de-webhook";
import {
  acceptsInboundWebhook,
  corpoParaArquivarEIngerir,
  descartarAntesDeArquivar,
  exigeSegredoDeAssinatura,
  handleInboundWebhook,
} from "@/lib/channels/inbound";
import {
  buscarConexaoDaInstancia,
  ehTokenGlobal,
  instanciaDoCorpo,
} from "@/lib/channels/evolution/webhook-global";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  // Token curto nunca foi emitido por nós. 404 e não 401: quem varre URLs não
  // precisa saber que a rota existe.
  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const corpoRecebido = await req.text();
  const admin = createAdminClient();

  // Token GLOBAL (instalação local): a conexão sai do nome da instância no corpo, não do token. Instância
  // que não é de nenhuma conexão ativa é 200 `ignored`, nunca 4xx: o provider reentregaria para sempre.
  // A regra inteira mora em `lib/channels/evolution/webhook-global.ts`.
  const viaGlobal = ehTokenGlobal(token, env.EVOLUTION_WEBHOOK_TOKEN);
  const instanciaGlobal = viaGlobal ? instanciaDoCorpo(corpoRecebido) : null;
  if (viaGlobal && !instanciaGlobal) {
    return ok({ status: "ignored", reason: "instancia_ausente" }, { requestId });
  }

  const { data, error: erroDaBusca } = instanciaGlobal
    ? await buscarConexaoDaInstancia(admin, instanciaGlobal)
    : await queryTolerantToMissingArchived(
        () =>
          admin
            .from("channel_sessions")
            .select(`id, organization_id, provider, display_name, phone_number, webhook_secret_encrypted, ${ARCHIVED_AT}`)
            .eq("webhook_path_token", token)
            .maybeSingle(),
        () =>
          admin
            .from("channel_sessions")
            .select("id, organization_id, provider, display_name, phone_number, webhook_secret_encrypted")
            .eq("webhook_path_token", token)
            .maybeSingle(),
      );

  // Falha da CONSULTA não é "sessão desconhecida": 500 faz a Evolution reentregar o evento (um 404 ou um
  // 200 o perderia em silêncio), e fica registrada.
  if (erroDaBusca) {
    logger.error("[webhook-canal] consulta da sessão falhou", {
      via: instanciaGlobal ? "token_global" : "token_da_sessao",
      code: erroDaBusca.code ?? null,
      requestId,
    });
    return fail("internal_error", "session_lookup_failed", 500, { requestId });
  }

  const sessao = data as {
    id: string;
    organization_id: string;
    provider: string;
    display_name: string | null;
    phone_number: string | null;
    webhook_secret_encrypted: unknown;
    archived_at?: string | null;
  } | null;

  if (!sessao) {
    if (instanciaGlobal) return ok({ status: "ignored", reason: "instancia_desconhecida" }, { requestId });
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  // Canal arquivado não ingere: o usuário mandou excluí-lo, e aceitar evento em
  // voo ressuscitaria a conversa no inbox com o operador sem poder responder.
  if (sessao.archived_at) {
    return ok({ status: "ignored", reason: "canal_arquivado" }, { requestId });
  }

  if (!acceptsInboundWebhook(sessao.provider)) {
    return fail("invalid_request", "provider_mismatch", 400, { requestId });
  }

  // Grupo, status e canal não viram contato e eram gravados (corpo cru) só para
  // serem descartados depois: 99,96% dos eventos de mensagem de uma instalação
  // real. Respondido aqui, antes de decifrar e de arquivar. 200, não 4xx: o
  // provider reentregaria para sempre algo que nunca vai servir.
  const descarte = descartarAntesDeArquivar(sessao.provider, corpoRecebido);
  if (descarte) {
    return ok({ status: "ignored", reason: descarte }, { requestId });
  }

  // Lote misto (grupo + conversa privada): o grupo sai ANTES de arquivar e de ingerir.
  // REGRA ABSOLUTA: nem conteúdo nem participantes de grupo vão para `webhook_events_log`.
  const rawBody = corpoParaArquivarEIngerir(sessao.provider, corpoRecebido);

  // O segredo só é decifrado para o canal que confere assinatura. Decifrar em
  // todo webhook fazia o log encher de "Wrong key or corrupt data" nos que não
  // usam o segredo.
  const cifrado = sessao.webhook_secret_encrypted;
  const secret =
    cifrado && exigeSegredoDeAssinatura(sessao.provider)
      ? await decryptWebhookSecret(admin, cifrado as string, { contexto: `webhook:${sessao.id}` })
      : null;

  // ─── O corpo cru vai para o arquivo ANTES de qualquer processamento ────────
  //
  // Se o processo morrer no meio — exceção, OOM, deploy no instante errado — o
  // payload continua gravado, que é justamente quando alguém vai querer lê-lo.
  // Este caminho não gravava NADA, enquanto a rota do outro canal grava desde
  // sempre: era o único canal sem instrumento para investigar o que chegou.
  const arquivo = await abrirArquivoDoWebhook(admin, {
    organizationId: sessao.organization_id,
    channelSessionId: sessao.id,
    provider: sessao.provider,
    rawBody,
    headers: req.headers,
  });

  try {
    const r = await handleInboundWebhook(admin, {
      session: sessao,
      rawBody,
      headers: req.headers,
      secret,
    });

    if (r.ok) {
      // Item malformado e item sem identidade (`key.id`) são descartes: o lote
      // segue `processed` (o que era bom foi ingerido), mas a contagem fica no
      // arquivo — onde alguém procura — em vez de sumir com carimbo de normalidade.
      const descartados = Number(r.body.descartados) || 0;
      const semId = Number(r.body.sem_id) || 0;
      const resumoDeDescartes =
        descartados > 0 || semId > 0 ? `itens_descartados: descartados=${descartados} sem_id=${semId}` : null;
      if (resumoDeDescartes) {
        logger.warn("[webhook-canal] lote com itens descartados", {
          channel_session_id: sessao.id,
          descartados,
          sem_id: semId,
          requestId,
        });
      }
      await fecharArquivoDoWebhook(admin, arquivo, {
        status: "processed",
        validSignature: true,
        // O desfecho do seam vai junto: é ele que distingue "ingerido" de
        // "ignorado por falta de identidade" quando alguém for contar depois.
        erro: typeof r.body.reason === "string" ? r.body.reason : resumoDeDescartes,
      });
      return ok(r.body, { requestId });
    }

    const status = r.code === "unauthorized" ? 401 : 400;
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      // `false` SÓ quando a recusa foi por assinatura. Um payload bem assinado
      // que o parser recusou não é problema de segredo, e marcá-lo como se
      // fosse mandaria quem investiga procurar no lugar errado.
      validSignature: r.code === "unauthorized" ? false : null,
      erro: r.message,
    });
    return fail(
      r.code === "unauthorized" ? "unauthorized" : "invalid_request",
      r.message,
      status,
      { requestId },
    );
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "ingest_failed";
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: null,
      erro: detalhe,
    });
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
