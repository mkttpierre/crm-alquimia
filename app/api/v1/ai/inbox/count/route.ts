/**
 * GET /api/v1/ai/inbox/count — quantos avisos abertos a org tem, e só isso.
 *
 * Existe para o selo do sino da Central (AlertsBell), que está em TODA tela do
 * app. Ele usava `GET /api/v1/ai/inbox?status=open` — a lista inteira, ~23 KB e
 * 470–1.755 ms medidos na auditoria de 26/10/2026 — só para ler `open_count`.
 * Aqui a resposta é `{ open_count }` (poucos bytes) e o banco faz um `count`
 * com cabeça, sem trazer linha nenhuma.
 *
 * Mesmo piso e mesmo escopo da lista: `agent` e org ativa do cookie, nunca do
 * corpo. Itens de plataforma (organization_id null) não entram, como na lista.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  // Service role bypassa RLS: o filtro por organização é EXPLÍCITO e vem da org
  // ativa resolvida do cookie.
  const { count, error } = await createAdminClient()
    .from("agent_inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.orgId)
    .eq("status", "open");
  if (error) {
    return fail("internal_error", t("Falha ao carregar os avisos."), 500, { requestId });
  }

  return ok({ open_count: count ?? 0 }, { requestId });
}
