/**
 * As duas Server Actions de Configurações › Personalizar (migration 0261).
 *
 * O que se prende aqui é o que só falha em produção:
 *
 *  - quem pode o quê: qualquer membro grava a PRÓPRIA barra; só admin grava os
 *    nomes (e, sem papel, a função de banco nem é chamada);
 *  - de onde vêm o ator e a organização: da SESSÃO, nunca do input — um input com
 *    `p_actor`, `user_id` ou `organization_id` é recusado pelo schema estrito;
 *  - a forma: chave fora do formato, nome com 41 caracteres, campo extra;
 *  - o desfecho: 0 linhas gravadas NÃO é "salvo" (issue #144), e cada código do
 *    banco vira o erro certo;
 *  - só a ação do admin audita, e a trilha leva a contagem, nunca os nomes.
 *
 * O que NÃO se prova aqui: a função SQL de verdade (papel, filtro por linha,
 * CHECKs). Isso é `tests/invariants/personalizar-barra.test.ts`, no `test:db`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "viewer";
let ehPlatformAdmin = false;
let semSessao = false;
let semOrganizacao = false;
let emSuporte = false;
let mfaPendente = false;
let respostaDoRpc: { data: unknown; error: { code: string; message: string } | null } = {
  data: 1,
  error: null,
};

const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
const auditadas: Array<Record<string, unknown>> = [];
const revalidadas: Array<[string, string | undefined]> = [];

vi.mock("next/headers", () => ({
  headers: async () => new Map<string, string>([["x-request-id", "req-teste"]]),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (caminho: string, tipo?: string) => {
    revalidadas.push([caminho, tipo]);
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
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () =>
    semSessao ? null : { id: USER, is_platform_admin: ehPlatformAdmin, support: null },
  ),
  resolveActiveOrg: vi.fn(async () =>
    semOrganizacao ? null : { orgId: ORG, name: "Org", role: papel },
  ),
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

import { updateMinhaBarra } from "@/app/actions/settings/updateMinhaBarra";
import { updateNomesDaBarra } from "@/app/actions/settings/updateNomesDaBarra";

beforeEach(() => {
  papel = "viewer";
  ehPlatformAdmin = false;
  semSessao = false;
  semOrganizacao = false;
  emSuporte = false;
  mfaPendente = false;
  respostaDoRpc = { data: 1, error: null };
  chamadas.length = 0;
  auditadas.length = 0;
  revalidadas.length = 0;
});

describe("updateMinhaBarra — a barra da PRÓPRIA pessoa", () => {
  const valida = { ocultos: ["/app/leads"], ordem: ["/app/agenda", "/app/inbox"] };

  it("⭐ qualquer papel grava, e o ator e a organização vêm da sessão", async () => {
    for (const p of ["viewer", "agent", "manager", "admin"]) {
      chamadas.length = 0;
      papel = p;
      expect(await updateMinhaBarra(valida)).toEqual({ ok: true });
      expect(chamadas).toEqual([
        {
          fn: "fn_definir_minha_barra",
          args: { p_organization_id: ORG, p_actor: USER, p_preferencias: valida },
        },
      ]);
    }
    expect(revalidadas).toContainEqual(["/app", "layout"]);
  });

  it("recusa input que tente escolher o ator ou a organização", async () => {
    const intruso = {
      ...valida,
      p_actor: "33333333-3333-4333-8333-333333333333",
      organization_id: "x",
    };
    const r = await updateMinhaBarra(intruso as never);
    expect(r).toMatchObject({ ok: false, error: "validation_failed" });
    expect(chamadas).toEqual([]);
  });

  it("recusa chave fora do formato, lista grande demais e forma errada — sem chamar o banco", async () => {
    for (const ruim of [
      { ocultos: ["javascript:alert(1)"], ordem: [] },
      { ocultos: [], ordem: Array.from({ length: 201 }, (_, i) => `/app/t${i}`) },
      { ocultos: "/app/leads", ordem: [] },
      { ocultos: [] },
      "texto",
      [],
    ]) {
      expect(await updateMinhaBarra(ruim as never)).toMatchObject({
        ok: false,
        error: "validation_failed",
      });
    }
    expect(chamadas).toEqual([]);
  });

  it("Configurações não vai para os ocultos e repetida é descartada", async () => {
    await updateMinhaBarra({
      ocultos: ["grupo:organizacao", "/app/leads", "/app/leads"],
      ordem: [],
    });
    expect(chamadas[0]!.args.p_preferencias).toEqual({ ocultos: ["/app/leads"], ordem: [] });
  });

  it("null restaura o padrão: manda a preferência vazia", async () => {
    expect(await updateMinhaBarra(null)).toEqual({ ok: true });
    expect(chamadas[0]!.args.p_preferencias).toEqual({});
  });

  it("sem sessão, em modo suporte e sem organização: nada é gravado", async () => {
    semSessao = true;
    expect(await updateMinhaBarra(valida)).toEqual({ ok: false, error: "unauthenticated" });
    semSessao = false;
    emSuporte = true;
    expect(await updateMinhaBarra(valida)).toEqual({ ok: false, error: "forbidden_role" });
    emSuporte = false;
    semOrganizacao = true;
    expect(await updateMinhaBarra(valida)).toEqual({ ok: false, error: "forbidden_tenant" });
    expect(chamadas).toEqual([]);
  });

  it("⭐ 0 linhas gravadas não é 'salvo'", async () => {
    respostaDoRpc = { data: 0, error: null };
    expect(await updateMinhaBarra(valida)).toEqual({ ok: false, error: "nao_gravou" });
    expect(revalidadas).toEqual([]);
  });

  it("traduz o erro do banco: forma (22023, 23514) vira validation_failed; o resto, db_error", async () => {
    respostaDoRpc = { data: null, error: { code: "22023", message: "forma" } };
    expect(await updateMinhaBarra(valida)).toMatchObject({ ok: false, error: "validation_failed" });
    respostaDoRpc = { data: null, error: { code: "23514", message: "check" } };
    expect(await updateMinhaBarra(valida)).toMatchObject({ ok: false, error: "validation_failed" });
    respostaDoRpc = { data: null, error: { code: "XX000", message: "caiu" } };
    expect(await updateMinhaBarra(valida)).toMatchObject({ ok: false, error: "db_error" });
  });

  it("não audita (preferência individual) e não cobra MFA", async () => {
    mfaPendente = true;
    expect(await updateMinhaBarra(valida)).toEqual({ ok: true });
    expect(auditadas).toEqual([]);
  });
});

describe("updateNomesDaBarra — os nomes da ORGANIZAÇÃO, só admin", () => {
  const nomes = { "/app/inbox": "Atendimento", "grupo:ia": "Robôs" };

  it("⭐ só admin grava: viewer, agent e manager recebem forbidden_role e o banco nem é chamado", async () => {
    for (const p of ["viewer", "agent", "manager"]) {
      papel = p;
      expect(await updateNomesDaBarra(nomes)).toEqual({ ok: false, error: "forbidden_role" });
    }
    expect(chamadas).toEqual([]);
    expect(auditadas).toEqual([]);
  });

  it("admin grava, com ator e organização da sessão, e audita só a contagem", async () => {
    papel = "admin";
    expect(await updateNomesDaBarra(nomes)).toEqual({ ok: true });
    expect(chamadas).toEqual([
      {
        fn: "fn_definir_nomes_da_barra",
        args: { p_organization_id: ORG, p_actor: USER, p_nomes: nomes },
      },
    ]);
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]).toMatchObject({
      action: "org.barra_nomes_updated",
      actorUserId: USER,
      organizationId: ORG,
      resourceType: "organization",
      resourceId: ORG,
      metadata: { linhas_com_nome_proprio: 2 },
    });
    expect(JSON.stringify(auditadas[0])).not.toContain("Atendimento");
    expect(revalidadas).toContainEqual(["/app", "layout"]);
  });

  it("platform admin (fora de suporte) também grava", async () => {
    papel = "viewer";
    ehPlatformAdmin = true;
    expect(await updateNomesDaBarra(nomes)).toEqual({ ok: true });
  });

  it("⭐ 40 caracteres passam, 41 não; espaços sobrando são cortados e nome vazio some", async () => {
    papel = "admin";
    const quarenta = "n".repeat(40);
    expect(await updateNomesDaBarra({ "/app/inbox": quarenta })).toEqual({ ok: true });
    expect(await updateNomesDaBarra({ "/app/inbox": "n".repeat(41) })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    chamadas.length = 0;
    await updateNomesDaBarra({ "/app/inbox": "  Conversas  ", "/app/leads": "   " });
    expect(chamadas[0]!.args.p_nomes).toEqual({ "/app/inbox": "Conversas" });
  });

  it("recusa chave fora do formato e valor que não é texto", async () => {
    papel = "admin";
    expect(await updateNomesDaBarra({ inbox: "Ok" })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(await updateNomesDaBarra({ "/app/inbox": 3 } as never)).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(await updateNomesDaBarra("texto" as never)).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(chamadas).toEqual([]);
  });

  it("null restaura todos os nomes (mapa vazio)", async () => {
    papel = "admin";
    expect(await updateNomesDaBarra(null)).toEqual({ ok: true });
    expect(chamadas[0]!.args.p_nomes).toEqual({});
  });

  it("MFA pendente barra o admin; em modo suporte, sem sessão e sem organização nada é gravado", async () => {
    papel = "admin";
    mfaPendente = true;
    expect(await updateNomesDaBarra(nomes)).toEqual({ ok: false, error: "mfa_required" });
    mfaPendente = false;
    emSuporte = true;
    expect(await updateNomesDaBarra(nomes)).toEqual({ ok: false, error: "forbidden_role" });
    emSuporte = false;
    semSessao = true;
    expect(await updateNomesDaBarra(nomes)).toEqual({ ok: false, error: "unauthenticated" });
    semSessao = false;
    semOrganizacao = true;
    expect(await updateNomesDaBarra(nomes)).toEqual({ ok: false, error: "forbidden_tenant" });
    expect(chamadas).toEqual([]);
  });

  it("⭐ 0 linhas gravadas não é 'salvo' e não audita; 42501 do banco vira forbidden_role", async () => {
    papel = "admin";
    respostaDoRpc = { data: 0, error: null };
    expect(await updateNomesDaBarra(nomes)).toEqual({ ok: false, error: "nao_gravou" });
    respostaDoRpc = { data: null, error: { code: "42501", message: "sem permissão" } };
    expect(await updateNomesDaBarra(nomes)).toEqual({ ok: false, error: "forbidden_role" });
    respostaDoRpc = { data: null, error: { code: "22023", message: "forma" } };
    expect(await updateNomesDaBarra(nomes)).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    respostaDoRpc = { data: null, error: { code: "XX000", message: "caiu" } };
    expect(await updateNomesDaBarra(nomes)).toMatchObject({ ok: false, error: "db_error" });
    expect(auditadas).toEqual([]);
  });
});
