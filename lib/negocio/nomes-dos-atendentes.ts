/**
 * Nome (só o nome) de quem atendeu cada venda, para o painel de faturamento.
 *
 * LGPD, como `lib/mcp/tools/_users.ts` e `/api/v1/team/assignable`: expõe SÓ `full_name`, nunca e-mail. Usa o cliente
 * administrador porque o nome mora em `auth.users` (a RLS da sessão não o alcança), então o filtro de organização é
 * MANUAL: só resolve quem é membro da organização da sessão. Sem a chave de serviço, devolve vazio e o painel mostra
 * os atendentes sem nome (degrada, não quebra).
 */
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

export async function nomesDosAtendentes(orgId: string, ids: ReadonlyArray<string>): Promise<Map<string, string | null>> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0 || !isServiceRoleConfigured()) return new Map();
  try {
    const admin = createAdminClient();
    const { data: membros } = await admin.from("user_organizations").select("user_id").eq("organization_id", orgId).in("user_id", unicos);
    const daOrg = ((membros ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
    const pares = await Promise.all(
      daOrg.map(async (id): Promise<readonly [string, string | null]> => {
        try {
          const { data } = await admin.auth.admin.getUserById(id);
          return [id, (data?.user?.user_metadata?.full_name as string | undefined) ?? null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    return new Map(pares);
  } catch {
    return new Map();
  }
}
