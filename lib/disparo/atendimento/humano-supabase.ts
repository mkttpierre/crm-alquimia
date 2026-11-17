/**
 * Quem está no comando do lead, lido do banco. UMA consulta para os dois lados
 * que precisam saber: o atendimento (responder à mensagem do lead) e o motor
 * (cadência e envios pendentes). Duas leituras divergiriam na primeira vez que
 * uma ganhasse um campo e a outra não — a regra em si mora em `./humano.ts`.
 *
 * Service role: filtra `organization_id` em toda consulta (anti-pattern nº 10).
 * A conversa é do CONTATO, não do lead; `conversationId` (a conversa da
 * mensagem) entra mesmo encerrada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ConversaHumana, SituacaoHumana } from "./humano";

export async function situacaoHumanaDoLead(db: SupabaseClient, org: string, leadId: string, conversationId: string | null): Promise<SituacaoHumana> {
  const { data: lead, error } = await db.from("crm_leads").select("contact_id").eq("organization_id", org).eq("id", leadId).maybeSingle();
  if (error) throw new Error(`atendimento_humano_lead: ${error.message}`);
  const contatoId = (lead?.contact_id as string | null | undefined) ?? null;
  if (!contatoId) return { forceHuman: false, conversas: [] };
  const { data: contato, error: e2 } = await db.from("contacts").select("force_human").eq("organization_id", org).eq("id", contatoId).maybeSingle();
  if (e2) throw new Error(`atendimento_humano_contato: ${e2.message}`);
  const { data: conversas, error: e3 } = await db
    .from("conversations")
    .select("id, status, bot_silenced_until, assignee_kind, assigned_to_user_id")
    .eq("organization_id", org)
    .eq("contact_id", contatoId)
    .limit(50);
  if (e3) throw new Error(`atendimento_humano_conversas: ${e3.message}`);
  const contam: ConversaHumana[] = (conversas ?? [])
    .filter((c) => c.id === conversationId || !["closed", "archived"].includes(String(c.status)))
    .map((c) => ({
      botSilencedUntil: (c.bot_silenced_until as string | null) ?? null,
      assigneeKind: (c.assignee_kind as string | null) ?? null,
      assignedToUserId: (c.assigned_to_user_id as string | null) ?? null,
    }));
  return { forceHuman: contato?.force_human === true, conversas: contam };
}
