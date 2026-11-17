"use server";

import { revalidatePath } from "next/cache";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { preferenciasDaBarraSchema, type PreferenciasDaBarra } from "@/lib/navigation/personalizar";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateMinhaBarraResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "nao_gravou"
        | "db_error";
      details?: unknown;
    };

/**
 * Grava a preferência PESSOAL da barra lateral (Configurações › Personalizar,
 * migration 0261): quais linhas a pessoa oculta e em que ordem vê as que ficam.
 * `null` restaura o padrão (preferência vazia).
 *
 * Qualquer membro, de qualquer papel, personaliza a PRÓPRIA barra — por isso não
 * há piso de papel nem MFA aqui, e a ação é a mesma classe de `updateProfile`:
 * apresentação, só da pessoa. O que a protege é o filtro dentro de
 * `fn_definir_minha_barra`: o ator vem de `loadAuthUser()` (sessão validada) e a
 * função só toca a linha `user_id = p_actor` da organização ativa. Nenhum id de
 * usuário ou de organização vem do input.
 *
 * Ocultar NÃO é permissão. A tela ocultada continua abrindo pelo link e pelo ⌘K;
 * esta ação não concede nem retira acesso a nada.
 *
 * Sem `audit()` de propósito (e sem `event_log`): é preferência individual de
 * tela, e uma linha de trilha por clique em "subir" seria ruído — o oposto da
 * ação do admin (`updateNomesDaBarra`), que muda a barra de todos e audita.
 */
export async function updateMinhaBarra(
  input: PreferenciasDaBarra | null,
): Promise<UpdateMinhaBarraResult> {
  // `null` = "Restaurar padrão". Mandamos `{}` (e não `null`) para a função: a
  // forma vazia não depende de como o transporte entrega um jsonb nulo.
  const parsed =
    input === null
      ? ({ success: true, data: null } as const)
      : preferenciasDaBarraSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };

  const { data, error } = await createAdminClient().rpc("fn_definir_minha_barra", {
    p_organization_id: activeOrg.orgId,
    p_actor: authUser.id,
    p_preferencias: parsed.data ?? {},
  });

  if (error) {
    // 22023: a função recusou a forma. 23514: o CHECK da coluna recusou o conteúdo.
    if (error.code === "22023" || error.code === "23514") {
      return { ok: false, error: "validation_failed", details: error.message };
    }
    return { ok: false, error: "db_error", details: error.message };
  }

  // `data` é o `row_count`: 0 = a pessoa não é membro ativa desta organização, e
  // sem esta linha a tela diria "salvo" com nada gravado (issue #144).
  if (data !== 1) return { ok: false, error: "nao_gravou" };

  // `/app` como LAYOUT: a barra é desenhada pelo layout. Revalidar só a página
  // deixaria a pessoa salvando e navegando com a barra velha.
  revalidatePath("/app", "layout");
  return { ok: true };
}
