/**
 * O primeiro dono de uma instalação nova precisa da tela de
 * atualização, que exige platform admin. O provisionamento do signup pede ao
 * banco a promoção (`fn_promover_primeiro_dono_da_instalacao`), e é o banco que
 * decide, sob trava, se este é mesmo o primeiro. Aqui se prova o lado do app:
 * pede só quando acabou de criar a organização, audita só quando o banco
 * promoveu, e uma falha na promoção não derruba o cadastro.
 * A regra do banco (nenhum platform admin, única organização) está em
 * `tests/unit/primeiro-dono-da-instalacao.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ensureTenantForUser } from "./provision";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "dono@exemplo.test" };
const ORG = "22222222-2222-4222-8222-222222222222";

type Rpc = { data: unknown; error: { message: string } | null };

function admin({ jaTemOrg = false, rpc }: { jaTemOrg?: boolean; rpc?: Rpc | Error }) {
  const rpcFn = vi.fn(async () => {
    if (rpc instanceof Error) throw rpc;
    return rpc ?? { data: false, error: null };
  });
  const from = vi.fn((tabela: string) => {
    if (tabela === "user_organizations") {
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: jaTemOrg ? { organization_id: ORG } : null,
                }),
              }),
            }),
          }),
        }),
        insert: async () => ({ error: null }),
      };
    }
    if (tabela === "organizations") {
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: { id: ORG, slug: "dono" }, error: null }) }),
        }),
      };
    }
    throw new Error(`tabela inesperada: ${tabela}`);
  });
  vi.mocked(createAdminClient).mockReturnValue({ from, rpc: rpcFn } as never);
  return rpcFn;
}

function acoesAuditadas(): string[] {
  return vi.mocked(audit).mock.calls.map((c) => (c[0] as { action: string }).action);
}

describe("ensureTenantForUser: primeiro dono da instalação (N3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("depois de criar a organização, pede ao banco a promoção do primeiro dono e audita quando promoveu", async () => {
    const rpc = admin({ rpc: { data: true, error: null } });
    const r = await ensureTenantForUser(USUARIO);
    expect(r).toEqual({ provisioned: true, organizationId: ORG });
    expect(rpc).toHaveBeenCalledWith("fn_promover_primeiro_dono_da_instalacao", {
      p_user: USUARIO.id,
      p_org: ORG,
    });
    expect(acoesAuditadas()).toContain("platform_admin.granted_to_first_owner");
  });

  it("segundo usuário (o banco recusa): não audita promoção nenhuma", async () => {
    const rpc = admin({ rpc: { data: false, error: null } });
    await ensureTenantForUser(USUARIO);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(acoesAuditadas()).not.toContain("platform_admin.granted_to_first_owner");
  });

  it("quem já tem organização não pede promoção", async () => {
    const rpc = admin({ jaTemOrg: true, rpc: { data: true, error: null } });
    const r = await ensureTenantForUser(USUARIO);
    expect(r.provisioned).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("erro na promoção não derruba o cadastro", async () => {
    admin({ rpc: { data: null, error: { message: "falhou" } } });
    await expect(ensureTenantForUser(USUARIO)).resolves.toEqual({ provisioned: true, organizationId: ORG });
    admin({ rpc: new Error("rede") });
    await expect(ensureTenantForUser(USUARIO)).resolves.toEqual({ provisioned: true, organizationId: ORG });
    expect(acoesAuditadas()).not.toContain("platform_admin.granted_to_first_owner");
  });

  // A falha da promoção não fica muda. O motivo vai para o logger, com o usuário
  // e a organização (ids, nada sensível), para o dono saber por que não tem a tela de atualização.
  it("erro do banco e exceção na promoção vão para o logger", async () => {
    admin({ rpc: { data: null, error: { message: "function does not exist" } } });
    await ensureTenantForUser(USUARIO);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringMatching(/primeiro dono/i),
      expect.objectContaining({ user_id: USUARIO.id, organization_id: ORG, motivo: "function does not exist" }),
    );
    vi.mocked(logger.error).mockClear();
    admin({ rpc: new Error("rede") });
    await ensureTenantForUser(USUARIO);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringMatching(/primeiro dono/i),
      expect.objectContaining({ motivo: "rede" }),
    );
  });

  it("o banco recusar (não é o primeiro) não é erro: nada no logger", async () => {
    admin({ rpc: { data: false, error: null } });
    await ensureTenantForUser(USUARIO);
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });
});
