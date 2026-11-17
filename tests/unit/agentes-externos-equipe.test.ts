// @vitest-environment node
/**
 * Agentes externos na equipe: criar devolve o token UMA vez e grava `external_agents`; revogar corta o
 * MCP na hora (401); mudar o papel regrava o escopo do token.
 *
 * Banco: o dublê das rotas de escrita (`tests/helpers/disparo-db-double.ts`), que aplica os filtros de verdade e não
 * imita a RLS — se a rota esquecer o `organization_id`, a linha da outra organização aparece. A autenticação do MCP é
 * a REAL (`validateBearerToken`), batendo o hash do token contra a mesma tabela.
 */
import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { bancoDuble } from "@/tests/helpers/disparo-db-double";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const RANK = { viewer: 1, agent: 2, manager: 4, admin: 5 } as const;
type Papel = keyof typeof RANK;

function comoPapel(papel: Papel) {
  vi.mocked(requireRole).mockImplementation(async (min) =>
    RANK[papel] >= RANK[min as Papel]
      ? ({ ok: true, user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" }, org: { orgId: ORG, role: papel } } as never)
      : ({ ok: false, response: fail("forbidden_role", "Permissão insuficiente.", 403) } as never),
  );
}

let banco: ReturnType<typeof bancoDuble>;
beforeEach(() => {
  vi.clearAllMocks();
  comoPapel("admin");
  banco = bancoDuble({
    organizations: [{ id: ORG, settings: {} }],
    external_agents: [{ id: "99999999-9999-4999-8999-999999999999", organization_id: OUTRA, nome: "Head", papel: "admin" }],
  });
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
  vi.mocked(createAdminClient).mockReturnValue(banco.cliente as never);
});

const pedido = (url: string, metodo: string, corpo?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: metodo,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }),
  });

async function criarHead(corpo: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/v1/team/agentes/route");
  const res = await POST(pedido("/api/v1/team/agentes", "POST", { nome: "Head", tipo: "openbot", ...corpo }));
  return { res, corpo: (await res.json()) as { data: { agente: { id: string }; token: string; app_url: string } } };
}

describe("criar agente externo", () => {
  it("devolve o token uma vez, grava o agente com o token dele e o banco guarda só o hash", async () => {
    const { res, corpo } = await criarHead();
    expect(res.status).toBe(201);
    const { token, agente } = corpo.data;
    expect(token).toMatch(/^dsk_[0-9a-f]{8}_/);

    const linha = banco.linhas("external_agents").find((l) => l.id === agente.id)!;
    expect(linha).toMatchObject({ organization_id: ORG, nome: "Head", tipo: "openbot", papel: "admin", pode_motor: true });

    const tokenGravado = banco.linhas("api_tokens").find((l) => l.id === linha.api_token_id)!;
    expect(tokenGravado.organization_id).toBe(ORG);
    expect(tokenGravado.scopes).toEqual(["actor:ai_agent", "role:admin", "mcp:read", "mcp:write"]);
    expect(tokenGravado.token_hash).toBe(`\\x${createHash("sha256").update(token).digest("hex")}`);
    expect(JSON.stringify(banco.tabelas)).not.toContain(token);

    // O token não volta mais: nem na lista, nem na auditoria.
    const { GET } = await import("@/app/api/v1/team/agentes/route");
    const lista = await (await GET(pedido("/api/v1/team/agentes", "GET"))).text();
    expect(lista).not.toContain(token);
    expect(lista).not.toContain("99999999-9999");
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(token);
    expect(vi.mocked(audit).mock.calls.at(-1)?.[0]).toMatchObject({ action: "agente_externo.criado", organizationId: ORG });
  });

  it("o nome de um agente de OUTRA organização não colide; o mesmo nome na mesma é 409 sem token solto", async () => {
    expect((await criarHead()).res.status).toBe(201);
    const tokensAntes = banco.linhas("api_tokens").length;
    expect((await criarHead()).res.status).toBe(409);
    expect(banco.linhas("api_tokens")).toHaveLength(tokensAntes);
  });

  it("só admin cria", async () => {
    comoPapel("manager");
    expect((await criarHead()).res.status).toBe(403);
    expect(banco.linhas("external_agents").filter((l) => l.organization_id === ORG)).toHaveLength(0);
  });

  it("a lista de quem não é admin traz a presença e não traz o endereço nem os revogados", async () => {
    const { corpo } = await criarHead();
    const linha = banco.linhas("external_agents").find((l) => l.id === corpo.data.agente.id)!;
    linha.ultimo_uso_em = new Date(Date.now() - 60_000).toISOString();
    linha.ultima_acao = "crm_disparo_estado";
    comoPapel("agent");
    const { GET } = await import("@/app/api/v1/team/agentes/route");
    const lido = (await (await GET(pedido("/api/v1/team/agentes", "GET"))).json()) as {
      data: { agentes: { nome: string; online: boolean; ultima_acao: string }[]; app_url?: string };
    };
    expect(lido.data.agentes).toEqual([expect.objectContaining({ nome: "Head", online: true, ultima_acao: "crm_disparo_estado" })]);
    expect(lido.data.app_url).toBeUndefined();
  });
});

describe("revogar agente externo", () => {
  it("token do agente autentica no MCP; revogado, o MCP responde 401", async () => {
    const { corpo } = await criarHead({ papel: "manager", pode_motor: false });
    const { token, agente } = corpo.data;

    const auth = await validateBearerToken(`Bearer ${token}`);
    expect(auth).toMatchObject({ organizationId: ORG, role: "manager" });
    expect(auth.actor.type).toBe("ai_agent");
    expect(auth.agenteExterno).toEqual({ id: agente.id, nome: "Head", pode_motor: false });

    const { DELETE } = await import("@/app/api/v1/team/agentes/[id]/route");
    const res = await DELETE(pedido(`/api/v1/team/agentes/${agente.id}`, "DELETE"), { params: Promise.resolve({ id: agente.id }) });
    expect(res.status).toBe(200);

    const erro = await validateBearerToken(`Bearer ${token}`).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(McpAuthError);
    expect((erro as McpAuthError).httpStatus).toBe(401);

    // O nome original fica livre para um agente novo; a linha antiga continua, marcada.
    const antigo = banco.linhas("external_agents").find((l) => l.id === agente.id)!;
    expect(antigo.revogado_em).toBeTruthy();
    expect(antigo.nome).not.toBe("Head");
    expect((await criarHead()).res.status).toBe(201);
  });

  it("agente marcado revogado com o token ainda ativo também é 401 (a revogação do agente é a autoridade)", async () => {
    const { corpo } = await criarHead();
    banco.linhas("external_agents").find((l) => l.id === corpo.data.agente.id)!.revogado_em = new Date().toISOString();
    const erro = await validateBearerToken(`Bearer ${corpo.data.token}`).catch((e: unknown) => e);
    expect((erro as McpAuthError).httpStatus).toBe(401);
  });
});

describe("editar agente externo", () => {
  it("mudar o papel regrava o escopo do token", async () => {
    const { corpo } = await criarHead();
    const { PATCH } = await import("@/app/api/v1/team/agentes/[id]/route");
    const id = corpo.data.agente.id;
    const res = await PATCH(pedido(`/api/v1/team/agentes/${id}`, "PATCH", { papel: "agent" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const tokenId = banco.linhas("external_agents").find((l) => l.id === id)!.api_token_id;
    expect(banco.linhas("api_tokens").find((l) => l.id === tokenId)!.scopes).toEqual(["actor:ai_agent", "role:agent", "mcp:read", "mcp:write"]);
    expect((await validateBearerToken(`Bearer ${corpo.data.token}`)).role).toBe("agent");
  });
});
