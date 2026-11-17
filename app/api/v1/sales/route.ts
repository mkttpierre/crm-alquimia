/**
 * POST /api/v1/sales — registra uma venda: negócio aberto (ou novo) + linhas de produto + ganho na data informada,
 * numa transação só (`fn_registrar_venda`, migration 0251).
 *
 * Papel agent+. A organização vem da sessão (nunca do corpo) e o cliente é o da SESSÃO, então a RLS vale por baixo.
 * `Idempotency-Key` (OBRIGATÓRIA, UUID; ausente ou inválida = 400): o mesmo pedido repetido (clique duplo, retry) devolve a
 * mesma venda com 200 em vez de lançar outra.
 *
 * Registrar venda NUNCA envia mensagem nem agenda envio ao lead, e não toca `disparo_config`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { registrarVenda } from "@/lib/negocio/registrar-venda";
import { vendaCriarSchema } from "@/lib/negocio/venda";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  // OBRIGATÓRIA e UUID, sem truncar nem normalizar: sem chave o clique duplo lançaria duas vendas, e uma chave cortada em 200
  // caracteres colidiria com outra. O modal gera uma por tentativa de confirmar e reusa a mesma na retentativa.
  const chave = req.headers.get("idempotency-key");
  if (chave === null || !z.string().uuid().safeParse(chave).success) {
    return fail("invalid_request", "Cabeçalho Idempotency-Key obrigatório, com um UUID.", 400, { requestId });
  }

  const parsed = vendaCriarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados da venda inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  try {
    const venda = await registrarVenda(
      await createClient(),
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      parsed.data,
      chave,
    );
    return ok(venda, { requestId, status: venda.ja_registrada ? 200 : 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { details: err.details, requestId });
    }
    return fail("internal_error", "Erro ao registrar a venda.", 500, { requestId });
  }
}
