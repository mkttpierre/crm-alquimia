/**
 * GET  /api/v1/funnels — funis do operador visíveis (compartilhados da org + os próprios; a RLS filtra).
 * POST /api/v1/funnels — cria um funil (passos inteiros). Compartilhado exige manager+.
 *
 * Um funil é a lista de mensagens prontas (modelos de `message_templates`) que a barra do chat envia em ordem, com o
 * atraso e o "digitando/gravando" de cada passo. Quem envia é `POST /api/v1/disparo/sequencia` (`funnel_id`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { repositorioFunisSupabase } from "@/lib/inbox/atalhos/repositorio-funis";
import { erroDoFunil, paraResposta } from "@/lib/inbox/atalhos/resposta-funil";
import { funilSchema } from "@/lib/inbox/atalhos/schema-funil";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "operator_funnels" });
  if (!authz.ok) return authz.response;
  try {
    const funis = await repositorioFunisSupabase(await createClient()).listar(authz.org.orgId);
    return ok(funis.map(paraResposta), { requestId });
  } catch {
    return fail("internal_error", "Erro ao listar os funis.", 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "operator_funnels" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = funilSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados do funil inválidos.", 422, { requestId, details: parsed.error.flatten().fieldErrors as Record<string, unknown> });
  }
  if (parsed.data.compartilhado && !roleAtLeast(org.role, "manager")) {
    return fail("forbidden", "Só manager+ cria funil para a organização inteira. Desmarque \"compartilhado\" para criar um seu.", 403, { requestId });
  }
  try {
    const criado = await repositorioFunisSupabase(await createClient()).criar(org.orgId, user.id, parsed.data);
    void audit({
      action: "funnel.created",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "operator_funnel",
      resourceId: criado.id,
      requestId,
      metadata: { atalho: criado.atalho, passos: criado.passos.length },
    });
    return ok(paraResposta(criado), { status: 201, requestId });
  } catch (e) {
    return erroDoFunil(e, requestId);
  }
}
