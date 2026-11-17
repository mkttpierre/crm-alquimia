/**
 * Por qual chip do motor a lead conversa: a sessão de canal da conversa (`conversations.channel_session_id`) aponta
 * para o chip (`disparo_chips.channel_session_id`). É a fonte certa para RESPONDER — a resposta sai pelo número em
 * que a lead escreveu —, e a única para a lead que nunca recebeu nada do motor (entrou por anúncio ou checkout e
 * escreveu primeiro), que não tem "último envio" (auditoria 3, C2 e M3).
 *
 * Service role: tudo filtra `organization_id`, que vem de quem chama (config da organização ou token do webhook).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

function lancar(contexto: string, erro: { message: string } | null): void {
  if (erro) throw new Error(`chip_da_conversa_${contexto}: ${erro.message}`);
}

/** Chip da sessão de canal, ou null. Mais de um chip na mesma sessão não é o esperado: vale o primeiro pelo nome. */
async function chipDaSessao(db: SupabaseClient, org: string, sessoes: string[]): Promise<string | null> {
  if (!sessoes.length) return null;
  const { data, error } = await db
    .from("disparo_chips")
    .select("id, channel_session_id")
    .eq("organization_id", org)
    .in("channel_session_id", sessoes)
    .order("nome");
  lancar("chip", error);
  // Na ordem das sessões (a conversa mais recente primeiro).
  for (const s of sessoes) {
    const achado = (data ?? []).find((c) => c.channel_session_id === s);
    if (achado) return achado.id as string;
  }
  return null;
}

/** Chip da conversa `conversationId` (a da mensagem). */
export async function chipDaConversaId(db: SupabaseClient, org: string, conversationId: string): Promise<string | null> {
  const { data: conv, error } = await db.from("conversations").select("channel_session_id").eq("organization_id", org).eq("id", conversationId).maybeSingle();
  lancar("conversa", error);
  const sessao = (conv?.channel_session_id as string | null | undefined) ?? null;
  return sessao ? chipDaSessao(db, org, [sessao]) : null;
}

/** Chip da conversa mais recente do contato do lead que passa por um chip do motor. */
export async function chipDasConversasDoLead(db: SupabaseClient, org: string, leadId: string): Promise<string | null> {
  const { data: lead, error } = await db.from("crm_leads").select("contact_id").eq("organization_id", org).eq("id", leadId).maybeSingle();
  lancar("lead", error);
  const contato = (lead?.contact_id as string | null | undefined) ?? null;
  if (!contato) return null;
  const { data: convs, error: e2 } = await db
    .from("conversations")
    .select("channel_session_id")
    .eq("organization_id", org)
    .eq("contact_id", contato)
    .not("channel_session_id", "is", null)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(10);
  lancar("conversas", e2);
  const sessoes = [...new Set((convs ?? []).map((c) => c.channel_session_id as string))];
  return chipDaSessao(db, org, sessoes);
}
