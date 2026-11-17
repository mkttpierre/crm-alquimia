/**
 * PATCH  /api/v1/funnels/[id] — regrava o funil inteiro (dados + passos).
 * DELETE /api/v1/funnels/[id] — apaga o funil (os passos vão junto).
 * A RLS de `operator_funnels` barra quem não é dono (agent) nem manager (compartilhado).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, noContent, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { repositorioFunisSupabase } from "@/lib/inbox/atalhos/repositorio-funis";
import { erroDoFunil, paraResposta } from "@/lib/inbox/atalhos/resposta-funil";
import { funilSchema } from "@/lib/inbox/atalhos/schema-funil";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const idDoFunil = z.string().uuid();

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "operator_funnels" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;
  if (!idDoFunil.safeParse(id).success) return fail("validation_failed", "Id de funil inválido.", 422, { requestId });

  const parsed = funilSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados do funil inválidos.", 422, { requestId, details: parsed.error.flatten().fieldErrors as Record<string, unknown> });
  }
  if (parsed.data.compartilhado && !roleAtLeast(org.role, "manager")) {
    return fail("forbidden", "Só manager+ altera funil da organização inteira.", 403, { requestId });
  }
  try {
    const salvo = await repositorioFunisSupabase(await createClient()).atualizar(org.orgId, user.id, id, parsed.data);
    if (!salvo) return fail("not_found", "Funil não encontrado.", 404, { requestId });
    void audit({
      action: "funnel.updated",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "operator_funnel",
      resourceId: id,
      requestId,
      metadata: { atalho: salvo.atalho, passos: salvo.passos.length },
    });
    return ok(paraResposta(salvo), { requestId });
  } catch (e) {
    return erroDoFunil(e, requestId);
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "operator_funnels" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;
  if (!idDoFunil.safeParse(id).success) return fail("validation_failed", "Id de funil inválido.", 422, { requestId });
  try {
    const apagou = await repositorioFunisSupabase(await createClient()).apagar(org.orgId, id);
    if (!apagou) return fail("not_found", "Funil não encontrado.", 404, { requestId });
    void audit({ action: "funnel.deleted", actorUserId: user.id, organizationId: org.orgId, resourceType: "operator_funnel", resourceId: id, requestId });
    return noContent(requestId);
  } catch (e) {
    return erroDoFunil(e, requestId);
  }
}
