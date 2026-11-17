/**
 * GET /api/v1/sales/alvo?contact_id=…&lead_id=… — o que "Registrar venda" vai usar, ANTES de confirmar (agent+).
 *
 * Devolve o negócio aberto que a venda usará (a mesma escolha da operação), o que já está nele, a moeda em que tudo se lança
 * e o "hoje" no fuso da organização. É só leitura: não grava, não trava, não emite nada. Cliente da SESSÃO e organização da
 * sessão (nunca da consulta).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerAlvoDaVenda } from "@/lib/negocio/alvo-da-venda";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const consultaSchema = z
  .object({ contact_id: z.string().uuid().optional(), lead_id: z.string().uuid().optional() })
  .refine((v) => v.contact_id || v.lead_id, { message: "Informe o contato ou o negócio." });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  const sp = new URL(req.url).searchParams;
  const parsed = consultaSchema.safeParse({ contact_id: sp.get("contact_id") ?? undefined, lead_id: sp.get("lead_id") ?? undefined });
  if (!parsed.success) {
    return fail("validation_failed", "Informe o contato ou o negócio da venda.", 422, { requestId, details: parsed.error.flatten().fieldErrors as Record<string, unknown> });
  }

  try {
    const alvo = await lerAlvoDaVenda(await createClient(), authz.org.orgId, { contactId: parsed.data.contact_id ?? null, leadId: parsed.data.lead_id ?? null });
    return ok(alvo, { requestId });
  } catch {
    return fail("internal_error", "Erro ao ler o negócio da venda.", 500, { requestId });
  }
}
