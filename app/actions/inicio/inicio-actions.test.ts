/**
 * As duas Server Actions do painel de vendas do Início.
 *
 *  - `definirMetaMensal`: só admin; o papel é conferido aqui e, de novo, no banco (42501); a organização e o ator vêm da
 *    SESSÃO, nunca do input; 0 linhas gravadas NÃO é "salvo" (issue #144); audita sem o valor.
 *  - `escolherPainelDoInicio`: grava o cookie da PESSOA; "vendas" só com `manager`+; valor desconhecido é ignorado.
 *
 * O que NÃO se prova aqui: a função SQL de verdade (papel, faixa, CHECK). Isso é `tests/invariants/meta-mensal-de-vendas.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "admin";
let ehPlatformAdmin = false;
let semSessao = false;
let semOrganizacao = false;
let emSuporte = false;
let mfaPendente = false;
let respostaDoRpc: { data: unknown; error: { code: string; message: string } | null } = { data: 1, error: null };

const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
const auditadas: Array<Record<string, unknown>> = [];
const revalidadas: string[] = [];
const cookiesGravados: Array<{ nome: string; valor: string; opcoes: Record<string, unknown> }> = [];
const logsDeErro: Array<{ mensagem: string; contexto: Record<string, unknown> }> = [];

vi.mock("@/lib/logger", () => ({
  logger: {
    error: (mensagem: string, contexto: Record<string, unknown>) => {
      logsDeErro.push({ mensagem, contexto });
    },
    warn: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Map<string, string>([["x-request-id", "req-teste"]]),
  cookies: async () => ({
    set: (nome: string, valor: string, opcoes: Record<string, unknown>) => {
      cookiesGravados.push({ nome, valor, opcoes });
    },
  }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (caminho: string) => {
    revalidadas.push(caminho);
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({
  supportWriteError: () => (emSuporte ? "support_read_only" : null),
}));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () =>
    semSessao ? null : { id: USER, is_platform_admin: ehPlatformAdmin, support: emSuporte ? { id: "s" } : null },
  ),
  resolveActiveOrg: vi.fn(async () => (semOrganizacao ? null : { orgId: ORG, name: "Org", role: papel })),
  mfaEmDivida: vi.fn(async () => mfaPendente),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      chamadas.push({ fn, args });
      return respostaDoRpc;
    },
  }),
}));

import { definirMetaMensal } from "@/app/actions/inicio/definirMetaMensal";
import { escolherPainelDoInicio } from "@/app/actions/inicio/escolherPainel";

beforeEach(() => {
  papel = "admin";
  ehPlatformAdmin = false;
  semSessao = false;
  semOrganizacao = false;
  emSuporte = false;
  mfaPendente = false;
  respostaDoRpc = { data: 1, error: null };
  chamadas.length = 0;
  auditadas.length = 0;
  revalidadas.length = 0;
  cookiesGravados.length = 0;
  logsDeErro.length = 0;
});

describe("definirMetaMensal", () => {
  it("⭐ admin grava; a organização e o ator vêm da sessão; audita sem o valor", async () => {
    expect(await definirMetaMensal({ metaCents: 5_000_000 })).toEqual({ ok: true });
    expect(chamadas).toEqual([{ fn: "fn_definir_meta_mensal", args: { p_organization_id: ORG, p_actor: USER, p_meta_cents: 5_000_000 } }]);
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]).toMatchObject({ action: "org.meta_mensal_updated", actorUserId: USER, organizationId: ORG, metadata: { definida: true } });
    expect(JSON.stringify(auditadas)).not.toContain("5000000");
    expect(revalidadas).toContain("/app/inicio");
  });

  it("null apaga a meta e a trilha diz 'não definida'", async () => {
    expect(await definirMetaMensal({ metaCents: null })).toEqual({ ok: true });
    expect(chamadas[0]?.args.p_meta_cents).toBeNull();
    expect(auditadas[0]).toMatchObject({ metadata: { definida: false } });
  });

  it("⭐ manager, agent e viewer recebem forbidden_role, e o banco nem é chamado", async () => {
    for (const p of ["manager", "agent", "viewer"]) {
      papel = p;
      expect(await definirMetaMensal({ metaCents: 100 })).toEqual({ ok: false, error: "forbidden_role" });
    }
    expect(chamadas).toEqual([]);
    expect(auditadas).toEqual([]);
  });

  it("platform admin grava; modo suporte não", async () => {
    papel = "viewer";
    ehPlatformAdmin = true;
    expect(await definirMetaMensal({ metaCents: 100 })).toEqual({ ok: true });
    emSuporte = true;
    expect(await definirMetaMensal({ metaCents: 100 })).toEqual({ ok: false, error: "forbidden_role" });
  });

  it("⭐ valida: zero, negativo, fracionário, texto, acima do teto, campo extra — sem chamar o banco", async () => {
    for (const ruim of [{ metaCents: 0 }, { metaCents: -5 }, { metaCents: 1.5 }, { metaCents: "100" }, { metaCents: 1e15 }, {}, { metaCents: 100, organization_id: "x" }, { metaCents: 100, p_actor: "y" }]) {
      expect(await definirMetaMensal(ruim as never)).toMatchObject({ ok: false, error: "validation_failed" });
    }
    expect(chamadas).toEqual([]);
  });

  it("sem sessão, sem organização e MFA pendente", async () => {
    semSessao = true;
    expect(await definirMetaMensal({ metaCents: 100 })).toEqual({ ok: false, error: "unauthenticated" });
    semSessao = false;
    semOrganizacao = true;
    expect(await definirMetaMensal({ metaCents: 100 })).toEqual({ ok: false, error: "forbidden_tenant" });
    semOrganizacao = false;
    mfaPendente = true;
    expect(await definirMetaMensal({ metaCents: 100 })).toEqual({ ok: false, error: "mfa_required" });
    expect(chamadas).toEqual([]);
  });

  it("⭐ o banco recusa por papel (snapshot velho): 42501 vira forbidden_role e nada é auditado", async () => {
    respostaDoRpc = { data: null, error: { code: "42501", message: "meta_mensal_sem_permissao" } };
    expect(await definirMetaMensal({ metaCents: 100 })).toEqual({ ok: false, error: "forbidden_role" });
    expect(auditadas).toEqual([]);
  });

  it("⭐ achado 11: a mensagem do banco NÃO vai para o navegador; o resultado é só o código, e o detalhe vai para o log do servidor", async () => {
    respostaDoRpc = { data: null, error: { code: "XX000", message: 'relation "organizations" segredo-interno does not exist' } };
    const r = await definirMetaMensal({ metaCents: 100 });
    expect(r).toEqual({ ok: false, error: "db_error" });
    expect(JSON.stringify(r)).not.toContain("segredo-interno");
    expect(logsDeErro).toHaveLength(1);
    expect(logsDeErro[0]?.contexto).toEqual({ org_id: ORG, code: "XX000", message: 'relation "organizations" segredo-interno does not exist' });
    expect(JSON.stringify(logsDeErro)).not.toMatch(/p_meta_cents|metaCents|100/);
  });

  it("⭐ achado 11: 22023 e 23514 também não devolvem a mensagem do banco, e também ficam no log", async () => {
    for (const code of ["22023", "23514"]) {
      logsDeErro.length = 0;
      respostaDoRpc = { data: null, error: { code, message: "violates check organizations_meta_mensal_cents_faixa" } };
      const r = await definirMetaMensal({ metaCents: 100 });
      expect(r).toEqual({ ok: false, error: "validation_failed" });
      expect(logsDeErro).toHaveLength(1);
    }
  });

  it("22023 e 23514 viram validation_failed; outro erro, db_error", async () => {
    respostaDoRpc = { data: null, error: { code: "22023", message: "meta_mensal_fora_da_faixa" } };
    expect(await definirMetaMensal({ metaCents: 100 })).toMatchObject({ ok: false, error: "validation_failed" });
    respostaDoRpc = { data: null, error: { code: "23514", message: "check" } };
    expect(await definirMetaMensal({ metaCents: 100 })).toMatchObject({ ok: false, error: "validation_failed" });
    respostaDoRpc = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await definirMetaMensal({ metaCents: 100 })).toMatchObject({ ok: false, error: "db_error" });
  });

  it("⭐ 0 linhas gravadas NÃO é 'salvo'", async () => {
    respostaDoRpc = { data: 0, error: null };
    expect(await definirMetaMensal({ metaCents: 100 })).toEqual({ ok: false, error: "nao_gravou" });
    expect(auditadas).toEqual([]);
  });
});

function form(painel: unknown): FormData {
  const f = new FormData();
  if (painel !== undefined) f.set("painel", painel as string);
  return f;
}

describe("escolherPainelDoInicio", () => {
  it("⭐ manager+ grava o cookie DA PESSOA, só no caminho do app e sem acesso do JavaScript", async () => {
    for (const p of ["manager", "admin"]) {
      cookiesGravados.length = 0;
      papel = p;
      await escolherPainelDoInicio(form("vendas"));
      expect(cookiesGravados).toHaveLength(1);
      expect(cookiesGravados[0]).toMatchObject({
        nome: `inicio_painel_${USER}`,
        valor: "vendas",
        opcoes: { httpOnly: true, sameSite: "strict", path: "/app" },
      });
    }
    expect(revalidadas).toContain("/app/inicio");
  });

  it("voltar para o painel de atendimento vale para qualquer papel", async () => {
    papel = "viewer";
    await escolherPainelDoInicio(form("atendimento"));
    expect(cookiesGravados[0]).toMatchObject({ nome: `inicio_painel_${USER}`, valor: "atendimento" });
  });

  it("⭐ viewer e agent NÃO conseguem escolher 'vendas' (campo forjado é ignorado, nada é gravado)", async () => {
    for (const p of ["viewer", "agent"]) {
      papel = p;
      await escolherPainelDoInicio(form("vendas"));
    }
    expect(cookiesGravados).toEqual([]);
  });

  it("modo suporte também não escolhe vendas", async () => {
    ehPlatformAdmin = true;
    emSuporte = true;
    papel = "viewer";
    await escolherPainelDoInicio(form("vendas"));
    expect(cookiesGravados).toEqual([]);
  });

  it("valor desconhecido, ausente ou sem sessão: nada é gravado", async () => {
    await escolherPainelDoInicio(form("financeiro"));
    await escolherPainelDoInicio(form(undefined));
    await escolherPainelDoInicio(form("__proto__"));
    semSessao = true;
    await escolherPainelDoInicio(form("vendas"));
    expect(cookiesGravados).toEqual([]);
  });
});
