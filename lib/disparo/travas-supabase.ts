/**
 * Travas com prazo (`disparo_travas`, migration 0246) — auditoria 3:
 *  - `lead:<id>`: uma leitura do atendimento por lead de cada vez (A3);
 *  - `chip:<id>`: uma volta do motor por chip de cada vez (A5: voltas do cron sobrepostas liam a contagem do chip
 *    cada uma por si e furavam o intervalo mínimo e o máximo por hora).
 *
 * Por que tabela e não `pg_advisory_lock`: o PostgREST não guarda sessão entre chamadas, e a trava precisa durar a
 * volta inteira (até ~2 min). Cada trava tem dono e prazo (`ate`): quem a tomou e morreu não a segura para sempre.
 * Tomar é atômico: o INSERT ignora a linha existente (ON CONFLICT DO NOTHING) e o UPDATE só pega trava VENCIDA — com
 * duas voltas disputando, o Postgres reavalia o `ate < agora` depois do lock de linha e só uma ganha.
 *
 * Service role: tudo filtra `organization_id`, que vem da config da organização ou do token do webhook.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A tabela ainda não existe (código novo no ar antes da migration 0246): a trava fica LIVRE, que é o comportamento de
 * antes dela — nunca para o motor nem o atendimento por causa da ordem do deploy. Qualquer outro erro lança.
 */
export const semTabela = (erro: { code?: string; message: string } | null) =>
  Boolean(erro && (erro.code === "42P01" || erro.code === "PGRST205" || /disparo_(travas|voltas).*(does not exist|schema cache)/i.test(erro.message)));

function lancar(contexto: string, erro: { message: string } | null): void {
  if (erro) throw new Error(`disparo_trava_${contexto}: ${erro.message}`);
}

export async function tomarTrava(db: SupabaseClient, org: string, chave: string, dono: string, prazoMs: number, agora = new Date(), exigirTabela = false): Promise<boolean> {
  const ate = new Date(agora.getTime() + prazoMs).toISOString();
  const { data: nova, error } = await db
    .from("disparo_travas")
    .upsert({ organization_id: org, chave, dono, ate }, { onConflict: "organization_id,chave", ignoreDuplicates: true })
    .select("dono");
  if (semTabela(error) && !exigirTabela) return true;
  lancar("tomar", error);
  if ((nova ?? []).length) return true;
  const { data: vencida, error: e2 } = await db
    .from("disparo_travas")
    .update({ dono, ate })
    .eq("organization_id", org)
    .eq("chave", chave)
    .lt("ate", agora.toISOString())
    .select("dono");
  lancar("tomar_vencida", e2);
  return (vencida ?? []).length > 0;
}

/** Solta a trava, só se ainda for de `dono` (se venceu e outro a tomou, não é mais nossa). */
export async function soltarTrava(db: SupabaseClient, org: string, chave: string, dono: string): Promise<void> {
  const { error } = await db.from("disparo_travas").delete().eq("organization_id", org).eq("chave", chave).eq("dono", dono);
  if (semTabela(error)) return;
  lancar("soltar", error);
}
