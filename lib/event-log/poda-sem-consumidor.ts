/**
 * Poda dos eventos que NINGUÉM consome.
 *
 * Triggers do banco emitem estes tipos em toda mudança de estado
 * (`fn_emit_message_event`, o vigia de sessão), mas nenhum handler do registry
 * os escuta. O drain só seleciona tipos COM handler, então a linha fica
 * `pending` para sempre: medido em 26/10/2026, 1.488 linhas paradas (a mais
 * velha de 15/10) e crescendo ~1.000/dia só com o `channel_session.status_changed`.
 * O Sistema Vivo chama isso de evento sem consumidor; aqui ele vira `done` com
 * o motivo gravado, e a retenção do histórico o leva depois.
 *
 * ─── Por que uma lista EXPLÍCITA e não "tudo sem handler" ───────────────────
 *
 * Há tipos sem handler no registry que têm dono: `ai_agent.dispatch_requested`
 * (cron agent-dispatcher), `conversation.routing_requested` (routing-worker),
 * `lead.created`… Marcar esses como `done` tiraria o trabalho de quem os drena.
 * Só entra aqui o tipo que alguém conferiu no código e não achou leitor.
 * Handler registrado depois para um destes tipos vence a lista: o tipo sai da
 * poda sozinho, sem ninguém lembrar de editar este arquivo.
 *
 * ─── Por que `done` ─────────────────────────────────────────────────────────
 *
 * `event_log_status_check` só aceita pending/processing/done/dead; `done` +
 * `last_error` com o motivo é o mesmo desfecho que o drain dá a um `skipped`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";

/** Emitidos por trigger, sem leitor no código (conferido em 2026-10-27). */
export const TIPOS_SEM_CONSUMIDOR: readonly string[] = [
  "channel_session.status_changed",
  "message.sent",
  "message.sending",
  "message.outbound",
];

export const MOTIVO_SEM_CONSUMIDOR = "sem_consumidor: nenhum handler lê este tipo";

/** A poda é um UPDATE no `event_log` inteiro; uma vez por hora por processo sobra. */
const INTERVALO_DA_PODA_MS = 60 * 60 * 1000;
let ultimaPoda = 0;

/** Só para teste: o relógio da poda é memória de processo. */
export function reiniciarRelogioDaPodaParaTeste(): void {
  ultimaPoda = 0;
}

/** Tipos da lista que continuam sem handler registrado. */
export function tiposParaPodar(): string[] {
  const comHandler = new Set(getRegisteredHandlers().flatMap((h) => h.events));
  return TIPOS_SEM_CONSUMIDOR.filter((t) => !comHandler.has(t));
}

/**
 * Marca como `done` os `pending` dos tipos sem consumidor. Nunca lança: a poda
 * é higiene, e falhar não pode derrubar o drain que a chamou.
 *
 * @returns quantas linhas foram encerradas (0 quando o relógio não venceu).
 */
export async function podarEventosSemConsumidor(
  admin: SupabaseClient,
  agora: number = Date.now(),
): Promise<number> {
  if (agora - ultimaPoda < INTERVALO_DA_PODA_MS) return 0;
  ultimaPoda = agora;

  const tipos = tiposParaPodar();
  if (!tipos.length) return 0;

  try {
    const { data, error } = await admin
      .from("event_log")
      .update({ status: "done", last_error: MOTIVO_SEM_CONSUMIDOR })
      .eq("status", "pending")
      .in("event_type", tipos)
      .select("id");
    if (error) {
      logger.warn("[event-log.poda] falhou", { error: error.message });
      return 0;
    }
    const n = data?.length ?? 0;
    if (n > 0) logger.info("[event-log.poda] eventos sem consumidor encerrados", { quantidade: n });
    return n;
  } catch (err) {
    logger.warn("[event-log.poda] falhou", { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
