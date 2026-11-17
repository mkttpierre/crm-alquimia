"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { metaMensalSchema, type EntradaDaMeta } from "@/lib/negocio/meta-mensal";
import { createAdminClient } from "@/lib/supabase/admin";

export type DefinirMetaMensalResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_role"
        | "forbidden_tenant"
        | "mfa_required"
        | "nao_gravou"
        | "db_error";
      /** Só o que o Zod diz do INPUT (que veio do navegador). Mensagem do banco nunca vai para cá. */
      details?: unknown;
    };

/**
 * Grava a META MENSAL de faturamento do painel "Vendas e faturamento" do Início (migration 0262). Só o admin da empresa.
 * `{ metaCents: null }` apaga a meta. O valor é em centavos, na moeda da organização.
 *
 * Mesmo desenho de `updateNomesDaBarra`: Server Action não passa por `requireRole`, então o papel do snapshot é conferido
 * aqui E de novo dentro de `fn_definir_meta_mensal`, que o re-resolve do banco e levanta 42501; a MFA (propriedade da sessão,
 * invisível ao Postgres) só é cobrada aqui. A organização e o ator vêm da SESSÃO, nunca do input (o schema é estrito).
 *
 * Audita (`org.meta_mensal_updated`): é número do negócio e muda o painel de todos os gestores. A trilha diz só se a meta foi
 * definida ou apagada, nunca o valor.
 */
export async function definirMetaMensal(input: EntradaDaMeta): Promise<DefinirMetaMensalResult> {
  const parsed = metaMensalSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  // Depois do papel, de propósito: quem nem tem o papel recebe `forbidden_role`.
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const { data, error } = await createAdminClient().rpc("fn_definir_meta_mensal", {
    p_organization_id: activeOrg.orgId,
    p_actor: authUser.id,
    // O tipo gerado não conhece NULL em argumento; a função aceita (NULL apaga).
    p_meta_cents: parsed.data.metaCents as number,
  });

  if (error) {
    // 42501: o snapshot de papel do gate de cima estava velho — o caso que a duplicação no banco existe para pegar.
    if (error.code === "42501") return { ok: false, error: "forbidden_role" };
    // A mensagem do banco (nome de tabela, de constraint, de coluna) fica no log do servidor e NÃO volta ao navegador: quem
    // recebe é só o código genérico. O log leva a organização, o código e a mensagem; o valor da meta não.
    logger.error("[inicio] meta mensal: o banco recusou a gravação", { org_id: activeOrg.orgId, code: error.code, message: error.message });
    if (error.code === "22023" || error.code === "23514") return { ok: false, error: "validation_failed" };
    return { ok: false, error: "db_error" };
  }

  // A catraca da issue #144: `data` é o `row_count`; 0 = a organização não casou.
  if (data !== 1) return { ok: false, error: "nao_gravou" };

  await audit({
    action: "org.meta_mensal_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    ip,
    userAgent,
    metadata: { definida: parsed.data.metaCents !== null },
  });

  revalidatePath("/app/inicio");
  return { ok: true };
}
