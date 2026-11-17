/**
 * Relógio do pipeline webhook → automação → follow-up → 1º envio.
 *
 * NÃO usa cron da Vercel. O Hobby só agenda 1×/dia e event-log-drain nem
 * entra na lista. Por isso este código corre a partir do POST (captação ou
 * inbound), e não espera worker nem cron.
 *
 * ─── O dreno global da ENTRADA corre FORA da resposta ───────────────────────
 *
 * Na mensagem de entrada, só o que é DESTE contato roda dentro do POST (texto
 * nos follow-ups, acordar a espera, tick dos nós ativos). O `drainEventLog` é
 * global — até 50 eventos de qualquer organização, com handlers de IA — e
 * rodava uma vez por mensagem dentro da requisição. Medido em produção
 * (10/11/2026): mediana de 1 a 21 s por `messages.upsert`, p95 de 213 s; a
 * Evolution estourava o tempo do webhook e reentregava a mesma mensagem 6 a 9
 * vezes, o que realimentava a carga. Agora ele vai para `after()` (depois da
 * resposta; fora de request, em segundo plano) com execução ÚNICA por
 * processo: se já há um dreno rodando, quem chega só pede uma rodada a mais.
 * Sem worker (Hobby) o produto continua andando sozinho; com worker, os dois
 * drenos convivem porque o claim de `drainEventLog` é otimista por linha.
 *
 * A captação (`kickLocalPipeline`, sem `inbound`) segue drenando dentro do
 * POST: o 1º envio do lead depende do dreno, e o volume ali é outro.
 *
 * O crontab da VPS continua existindo como rede de segurança; não é requisito
 * desta jornada. Falha aqui nunca vira 5xx do webhook.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import { drainEventLog } from "@/lib/event-log/drain";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";
import { aplicarTextoNosFollowups } from "@/lib/followup/aplicar-inbound";
import {
  avancarEnrollmentAtivo,
  createSupabaseAdminClient,
  type TickDeps,
} from "@/lib/followup/engine";
import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { applyReactivityEvent, createSupabaseReactivityClient } from "@/lib/followup/reactivity";
import { logger } from "@/lib/logger";

export { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";

export type SinalDeInbound = {
  organizationId: string;
  contactId: string;
  messageId?: string | null;
  texto?: string | null;
};

export type ContatoDoPipeline = {
  organizationId: string;
  contactId: string;
};

function tickDepsDe(admin: SupabaseClient): TickDeps {
  return {
    db: createSupabaseAdminClient(admin),
    clock: () => new Date(),
    enqueueJob: async (job) => {
      const { error } = await admin.from("job_queue").insert({
        organization_id: job.organization_id,
        contact_id: job.contact_id,
        kind: "followup_turn",
        payload: job.payload,
      });
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * Arranca só o fluxo DESTE contato, e só nós `active`.
 * `waiting_reply` avança com a mensagem do WhatsApp (`aplicarTextoNosFollowups`),
 * não com um POST de captação — o claim global tratava a espera vencida como
 * timeout no mesmo request do webhook de contato.
 */
async function tickAtivosDoContato(
  admin: SupabaseClient,
  contato: ContatoDoPipeline,
  statuses: ReadonlyArray<"active" | "waiting_reply"> = ["active"],
  opts?: { mesmoAntesDoPrazo?: boolean },
): Promise<number> {
  const ids = await idsDoContatoEGemeos(admin, contato.organizationId, contato.contactId);
  let q = admin
    .from("followup_enrollments")
    .select("*")
    .eq("organization_id", contato.organizationId)
    .in("contact_id", ids)
    .in("status", [...statuses]);
  if (!opts?.mesmoAntesDoPrazo) {
    q = q.lte("next_eval_at", new Date().toISOString());
  }
  const { data, error } = await q.limit(8);
  if (error) throw new Error(error.message);
  const agora = new Date().toISOString();
  const rows = (
    opts?.mesmoAntesDoPrazo
      ? (data ?? []).filter(
          (r) => r.status === "waiting_reply" || (typeof r.next_eval_at === "string" && r.next_eval_at <= agora),
        )
      : (data ?? [])
  ) as EnrollmentRow[];
  const deps = tickDepsDe(admin);
  for (const row of rows) {
    await avancarEnrollmentAtivo(deps, row);
  }
  return rows.length;
}

async function acordarFollowupPorInbound(admin: SupabaseClient, sinal: SinalDeInbound): Promise<void> {
  const db = createSupabaseReactivityClient(admin);
  await applyReactivityEvent(db, () => new Date(), {
    id: sinal.messageId ?? `inbound:${sinal.contactId}`,
    organization_id: sinal.organizationId,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: sinal.messageId ?? null,
    payload: { contact_id: sinal.contactId },
    metadata: { source: "kick-local-pipeline" },
    consumed_by: [],
    attempts: 0,
  });
}

async function acelerarDesteContato(
  admin: SupabaseClient,
  contato: ContatoDoPipeline,
  opts?: { incluirEsperaDeResposta?: boolean },
): Promise<void> {
  const ids = await idsDoContatoEGemeos(admin, contato.organizationId, contato.contactId);
  const statuses: ReadonlyArray<"active" | "waiting_reply"> = opts?.incluirEsperaDeResposta
    ? ["active", "waiting_reply"]
    : ["active"];
  for (let i = 0; i < 6; i++) {
    const claimed = await tickAtivosDoContato(admin, contato, statuses, {
      mesmoAntesDoPrazo: Boolean(opts?.incluirEsperaDeResposta),
    });
    const enviados = await enviarTextoFixoPendente(admin, ids);
    if (!claimed && !enviados) break;
  }
}

async function drenarAgora(admin: SupabaseClient): Promise<void> {
  ensureHandlersRegistered();
  try {
    const drain = await drainEventLog(admin);
    logger.info("[dev.pipeline] event-log-drain", { ...drain });
  } catch (err) {
    logger.warn("[dev.pipeline] drain falhou; tick do follow-up segue", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** O dreno global em curso NESTE processo (execução única). */
let drenoEmCurso: Promise<void> | null = null;
/** Alguém pediu dreno enquanto o atual rodava: os eventos dele vieram depois do SELECT. */
let drenarDeNovo = false;
/** Contatos cujo follow-up anda de novo depois do dreno (ele pode tê-los matriculado). */
const contatosDepoisDoDreno = new Map<string, ContatoDoPipeline>();

function drenarUmaVezNoProcesso(admin: SupabaseClient, contato: ContatoDoPipeline): Promise<void> {
  contatosDepoisDoDreno.set(`${contato.organizationId}:${contato.contactId}`, contato);
  if (drenoEmCurso) {
    drenarDeNovo = true;
    return drenoEmCurso;
  }
  drenoEmCurso = (async () => {
    try {
      do {
        drenarDeNovo = false;
        await drenarAgora(admin);
        const contatos = [...contatosDepoisDoDreno.values()];
        contatosDepoisDoDreno.clear();
        for (const c of contatos) {
          try {
            await acelerarDesteContato(admin, c);
          } catch (err) {
            logger.warn("[dev.pipeline] tick do contato depois do dreno falhou", {
              organization_id: c.organizationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } while (drenarDeNovo);
    } finally {
      drenoEmCurso = null;
    }
  })();
  return drenoEmCurso;
}

/**
 * Agenda o dreno para depois da resposta. `after()` só existe dentro de uma
 * request do Next (e é o que segura o trabalho vivo numa hospedagem serverless);
 * fora dela lança, e o dreno roda em segundo plano no próprio processo.
 * `drenarUmaVezNoProcesso` nunca rejeita.
 */
function drenarForaDaResposta(admin: SupabaseClient, contato: ContatoDoPipeline): void {
  const tarefa = () => drenarUmaVezNoProcesso(admin, contato);
  try {
    after(tarefa);
  } catch {
    void tarefa();
  }
}

export async function acelerarPipelineDeEventos(
  admin: SupabaseClient,
  inbound?: SinalDeInbound,
  opts?: {
    /**
     * `false` = não agenda o dreno global. É o caso da reentrega (23505): a 1ª
     * entrega já o agendou, e a reentrega 6 a 9 vezes por mensagem era o que
     * realimentava a carga.
     */
    drenar?: boolean;
  },
): Promise<void> {
  try {
    if (!inbound) {
      await drenarAgora(admin);
      return;
    }
    try {
      await aplicarTextoNosFollowups(admin, inbound);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn("[dev.pipeline] aplicar texto do inbound falhou", { error: detail });
    }
    try {
      await acordarFollowupPorInbound(admin, inbound);
    } catch (err) {
      logger.warn("[dev.pipeline] acordar follow-up falhou", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const contato = { organizationId: inbound.organizationId, contactId: inbound.contactId };
    await acelerarDesteContato(admin, contato);
    if (opts?.drenar !== false) drenarForaDaResposta(admin, contato);
  } catch (err) {
    logger.warn("[dev.pipeline] acelerar falhou (lead/mensagem já gravados)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function kickLocalPipeline(
  admin: SupabaseClient,
  contato?: ContatoDoPipeline,
): Promise<void> {
  // acelerarPipelineDeEventos já é fail-soft; o tick do contato NÃO era —
  // uma query incompleta (mock de teste ou PostgREST momentâneo) derrubava o
  // 200 da captação depois do lead já gravado. O contrato do cabeçalho vale
  // para o POST inteiro.
  try {
    await acelerarPipelineDeEventos(admin);
    if (contato) await acelerarDesteContato(admin, contato);
  } catch (err) {
    logger.warn("[dev.pipeline] kick falhou (lead/mensagem já gravados)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
