import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { buscarTodasAsPaginas } from "@/lib/supabase/em-lotes";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const org = await resolveActiveOrg(user);
  if (!org) return fail("not_found", "Organization not found.", 404, { requestId });
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return fail("validation_failed", "Id de contato inválido.", 422, { requestId });
  const supabase = await createClient();
  const contact = await supabase.from("contacts").select("id").eq("organization_id", org.orgId).eq("id", id).maybeSingle();
  if (contact.error) return fail("internal_error", contact.error.message, 500, { requestId });
  if (!contact.data) return fail("not_found", "Contact not found.", 404, { requestId });
  const [leads, conversations] = await Promise.all([
    buscarTodasAsPaginas((de, ate) => supabase.from("crm_leads").select("id, title, pipeline_id").eq("organization_id", org.orgId).eq("contact_id", id).order("updated_at", { ascending: false }).order("id").range(de, ate)),
    buscarTodasAsPaginas((de, ate) => supabase.from("conversations").select("id, last_message_preview, last_message_at").eq("organization_id", org.orgId).eq("contact_id", id).order("last_message_at", { ascending: false, nullsFirst: false }).order("id").range(de, ate)),
  ]);
  const error = leads.error ?? conversations.error;
  if (error) return fail("internal_error", error, 500, { requestId });
  return ok({ leads: leads.data ?? [], conversations: conversations.data ?? [] }, { requestId });
}
