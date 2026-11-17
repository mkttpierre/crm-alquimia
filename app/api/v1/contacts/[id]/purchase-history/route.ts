/**
 * GET /api/v1/contacts/[id]/purchase-history — histórico de compra do contato (viewer+).
 *
 * Negócios ganhos (com as linhas de produto) + pedidos pagos da loja → total gasto, nº de compras, última compra e
 * ciclo médio entre compras. A leitura é no servidor, com a sessão: o navegador não tem a sessão do Supabase (cookie
 * httpOnly) e uma consulta direta voltaria vazia sem avisar (ver `contacts/[id]/crm-summary`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { montarHistoricoDeCompras } from "@/lib/negocio/historico-compras";
import { repositorioHistoricoSupabase } from "@/lib/negocio/repositorio-historico";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "purchase_history" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("validation_failed", "Id do contato inválido.", 422, { requestId });
  try {
    const { negocios, pedidos } = await repositorioHistoricoSupabase(await createClient()).carregar(authz.org.orgId, id);
    return ok(montarHistoricoDeCompras({ negocios, pedidos }), { requestId });
  } catch {
    return fail("internal_error", "Erro ao carregar o histórico de compra.", 500, { requestId });
  }
}
