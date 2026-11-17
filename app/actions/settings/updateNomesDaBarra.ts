"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { nomesDaBarraSchema, type NomesDaBarra } from "@/lib/navigation/personalizar";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateNomesDaBarraResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "nao_gravou"
        | "db_error";
      details?: unknown;
    };

/**
 * Grava os NOMES que o admin deu às linhas de topo da barra lateral
 * (Configurações › Personalizar, migration 0261). Vale para todos da
 * organização. `null` (ou mapa vazio) devolve todos ao nome padrão; nome vazio
 * volta ao padrão só aquela linha; cada nome tem no máximo 40 caracteres, com
 * os espaços das pontas cortados.
 *
 * Mesmo desenho de `updateMarcaDaOrganizacao` (leia o cabeçalho dele): Server
 * Action não passa por `requireRole`, então o papel do snapshot é conferido aqui
 * E de novo dentro de `fn_definir_nomes_da_barra`, que o re-resolve do banco e
 * levanta 42501; a MFA (propriedade da sessão, invisível ao Postgres) só é
 * cobrada aqui; e a escrita é UMA instrução numa coluna própria
 * (`organizations.nomes_da_barra`), sem read-modify-write em `settings`.
 *
 * Audita (`org.barra_nomes_updated`): muda a barra de todos. A trilha leva só a
 * CONTAGEM de linhas com nome próprio — nunca os nomes, que são texto livre.
 * Sem `event_log`: nenhum handler consumiria o evento (anti-pattern nº 3).
 *
 * O ÚLTIMO A SALVAR VENCE: a gravação substitui o mapa inteiro, sem conferir versão.
 * Dois admins salvando ao mesmo tempo se sobrescrevem; é decisão registrada (os nomes
 * mudam raramente) e não um esquecimento.
 */
export async function updateNomesDaBarra(
  input: NomesDaBarra | null,
): Promise<UpdateNomesDaBarraResult> {
  const parsed =
    input === null ? ({ success: true, data: {} } as const) : nomesDaBarraSchema.safeParse(input);
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

  const { data, error } = await createAdminClient().rpc("fn_definir_nomes_da_barra", {
    p_organization_id: activeOrg.orgId,
    p_actor: authUser.id,
    p_nomes: parsed.data,
  });

  if (error) {
    // 42501: o snapshot de papel do gate de cima estava velho — o caso que a
    // duplicação no banco existe para pegar.
    if (error.code === "42501") return { ok: false, error: "forbidden_role" };
    if (error.code === "22023" || error.code === "23514") {
      return { ok: false, error: "validation_failed", details: error.message };
    }
    return { ok: false, error: "db_error", details: error.message };
  }

  // A catraca da issue #144: `data` é o `row_count`; 0 = a organização não casou.
  if (data !== 1) return { ok: false, error: "nao_gravou" };

  await audit({
    action: "org.barra_nomes_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    ip,
    userAgent,
    metadata: { linhas_com_nome_proprio: Object.keys(parsed.data).length },
  });

  revalidatePath("/app", "layout");
  return { ok: true };
}
