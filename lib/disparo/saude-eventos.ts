/**
 * O que o webhook da Evolution entrega ao freio de saúde, sem mexer no que a ingestão já faz:
 *
 *   - status de entrega (`messages.update` → envelope `message.ack`): grava o ack em `disparo_envios`,
 *     casando por `external_id` (o `key.id` que o envio devolveu). É o único jeito de saber se uma abertura
 *     ficou em 1 tique. A ingestão do WAHA continua atualizando `messages` por conta própria;
 *   - estado de conexão (`connection.update`, `logout.instance`): grava em `disparo_eventos_conexao`.
 *
 * Limitação conhecida: só chega o que a Evolution manda. Se a instância não assina `MESSAGES_UPDATE`, o
 * `ack` fica NULL e o bloqueio provável cai em "sem dado" (nunca em vermelho) — ver `calcularSaude`.
 * Nunca lança: a mensagem já foi gravada pela ingestão e o webhook responde 200.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export type EnvelopeDeAck = { event?: string | null; payload?: { id?: string | null; ack?: number | null } | null };
export type EstadoDeConexao = { estado: string; codigo: number | null };

/** Os acks do lote, um por mensagem, o maior de cada (a Evolution pode mandar 2 e depois 3 no mesmo lote). */
export function acksDoLote(envelopes: EnvelopeDeAck[]): Map<string, number> {
  const acks = new Map<string, number>();
  for (const e of envelopes) {
    if (e.event !== "message.ack") continue;
    const id = e.payload?.id;
    const ack = e.payload?.ack;
    if (!id || typeof ack !== "number") continue;
    acks.set(id, Math.max(acks.get(id) ?? -1, ack));
  }
  return acks;
}

/** Grava o ack nos envios do motor. Só sobe (um ack atrasado de 1 não rebaixa um 3). */
export async function registrarEntregas(
  db: SupabaseClient,
  org: string,
  envelopes: EnvelopeDeAck[],
  agora = new Date(),
): Promise<number> {
  let gravados = 0;
  try {
    for (const [externalId, ack] of acksDoLote(envelopes)) {
      const linha: Record<string, unknown> = { ack, ack_em: agora.toISOString() };
      if (ack >= 2) linha.entregue_em = agora.toISOString();
      if (ack >= 3) linha.lido_em = agora.toISOString();
      const { data, error } = await db
        .from("disparo_envios")
        .update(linha)
        .eq("organization_id", org)
        .eq("external_id", externalId)
        .or(`ack.is.null,ack.lt.${ack}`)
        .select("id");
      if (error) throw new Error(error.message);
      gravados += (data ?? []).length;
    }
  } catch (e) {
    logger.warn("disparo.saude: ack não gravado", { organization_id: org, erro: (e as Error).message });
  }
  return gravados;
}

/** Grava os estados de conexão vistos na sessão de canal (alimenta o freio de conexão). */
export async function registrarConexoes(
  db: SupabaseClient,
  org: string,
  canalId: string,
  eventos: EstadoDeConexao[],
  agora = new Date(),
): Promise<number> {
  if (!eventos.length) return 0;
  try {
    const { error } = await db.from("disparo_eventos_conexao").insert(
      eventos.map((e) => ({
        organization_id: org,
        channel_session_id: canalId,
        estado: e.estado,
        codigo: e.codigo,
        ocorrido_em: agora.toISOString(),
      })),
    );
    if (error) throw new Error(error.message);
    return eventos.length;
  } catch (e) {
    logger.warn("disparo.saude: conexão não gravada", { organization_id: org, erro: (e as Error).message });
    return 0;
  }
}
