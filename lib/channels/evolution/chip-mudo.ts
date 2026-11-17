import type { SupabaseClient } from "@supabase/supabase-js";

/** Avalia sinais já coletados, sem consultar ou alterar serviços. */
export function chipMudo(input: {
  estado: string;
  ultimoRecebimento: string | null;
  inicioObservacao?: string | null;
  enviouNasUltimas24h: boolean;
  unknownNasUltimas24h: boolean;
  agora: Date;
}): boolean {
  if (input.estado !== "open") return false;
  if (input.unknownNasUltimas24h) return true;
  const referencia = input.ultimoRecebimento ?? input.inicioObservacao;
  const ultimo = referencia ? Date.parse(referencia) : NaN;
  return input.enviouNasUltimas24h && Number.isFinite(ultimo) && input.agora.getTime() - ultimo > 24 * 60 * 60 * 1000;
}

/** Só timestamps, limitados por tenant/canal. null distingue falha de ausência de sinal. */
export async function coletarChipMudo(
  db: SupabaseClient,
  organizationId: string,
  canal: { id: string; status: string; created_at: string },
  agora = new Date(),
): Promise<boolean | null> {
  if (canal.status !== "WORKING") return false;
  const base = () => db.from("messages").select("created_at")
    .eq("organization_id", organizationId).eq("channel_session_id", canal.id).neq("type", "system");
  const [entrada, saida] = await Promise.all([
    base().eq("direction", "inbound").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    base().eq("direction", "outbound").in("status", ["sent", "delivered", "read"])
      .gte("sent_at", new Date(agora.getTime() - 86_400_000).toISOString())
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (entrada.error || saida.error) return null;
  return chipMudo({ estado: "open", ultimoRecebimento: entrada.data?.created_at ?? null,
    inicioObservacao: canal.created_at, enviouNasUltimas24h: Boolean(saida.data),
    unknownNasUltimas24h: false, agora });
}
