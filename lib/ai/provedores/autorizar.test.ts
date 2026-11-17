import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A API de provedores para agentes fica fora do proxy de sessão (agente não tem
 * cookie), então a autenticação inteira é desta função. Os casos prendem que
 * ela FALHA FECHADA: bearer sem papel admin, sem escopo ou inválido é recusado,
 * e sem bearer quem decide é a sessão.
 */

const validar = vi.fn();
const requireRole = vi.fn();

vi.mock("@/lib/mcp/auth", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@/lib/mcp/auth");
  return { ...real, validateBearerToken: (h: string) => validar(h) };
});
vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
const permitido = { valor: true };
const baldes: string[] = [];
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (balde: string) => {
    baldes.push(balde);
    return { allowed: permitido.valor };
  },
}));
const logado = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { error: (...a: unknown[]) => logado(...a), warn: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ quem: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ quem: "sessao" }) }));

const { autorizarGestaoDeIa } = await import("@/lib/ai/provedores/autorizar");
const { McpAuthError } = await import("@/lib/mcp/auth");
const { isPublicPath } = await import("@/lib/auth/public-paths");

const ORG = "00000000-0000-4000-8000-00000000000a";

function req(authorization?: string, extra: Record<string, string> = {}) {
  return new Request("http://x/api/v1/ai/connected-providers", {
    headers: { ...(authorization ? { authorization } : {}), ...extra },
  });
}

function token(role: string, scopes: string[]) {
  return { organizationId: ORG, role, scopes, apiTokenId: "tok-1", actor: { type: "user" } };
}

beforeEach(() => {
  permitido.valor = true;
  baldes.length = 0;
  logado.mockReset();
  validar.mockReset();
  requireRole.mockReset();
});

describe("autorizarGestaoDeIa", () => {
  it("bearer admin com escopo de leitura passa, com a organização DO TOKEN e o admin client", async () => {
    validar.mockResolvedValue(token("admin", ["mcp:read"]));
    const r = await autorizarGestaoDeIa(req("Bearer dsk_x"), { escrita: false, requestId: "r" });
    expect(r).toMatchObject({ ok: true, orgId: ORG, actorApiTokenId: "tok-1", actorUserId: null });
    expect(r.ok && (r.db as unknown as { quem: string }).quem).toBe("admin");
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("bearer sem papel admin é 403", async () => {
    validar.mockResolvedValue(token("manager", ["mcp:read", "mcp:write"]));
    const r = await autorizarGestaoDeIa(req("Bearer dsk_x"), { escrita: false, requestId: "r" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.response.status).toBe(403);
  });

  it("escrita exige o escopo de escrita", async () => {
    validar.mockResolvedValue(token("admin", ["mcp:read"]));
    const r = await autorizarGestaoDeIa(req("Bearer dsk_x"), { escrita: true, requestId: "r" });
    expect(!r.ok && r.response.status).toBe(403);
  });

  it("bearer inválido é 401 e não cai para a sessão", async () => {
    validar.mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    const r = await autorizarGestaoDeIa(req("Bearer dsk_falso"), { escrita: false, requestId: "r" });
    expect(!r.ok && r.response.status).toBe(401);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("bearer acima do teto por minuto é 429 antes de consultar o token", async () => {
    permitido.valor = false;
    const r = await autorizarGestaoDeIa(req("Bearer dsk_x"), { escrita: false, requestId: "r" });
    expect(!r.ok && r.response.status).toBe(429);
    expect(validar).not.toHaveBeenCalled();
  });

  it("o teto é por token (hash), não um balde global, e nunca leva o token em claro", async () => {
    validar.mockResolvedValue(token("admin", ["mcp:read"]));
    await autorizarGestaoDeIa(req("Bearer dsk_token_a"), { escrita: false, requestId: "r" });
    await autorizarGestaoDeIa(req("Bearer dsk_token_b"), { escrita: false, requestId: "r" });
    await autorizarGestaoDeIa(req("Bearer dsk_token_a"), { escrita: false, requestId: "r" });
    expect(baldes[0]).not.toBe(baldes[1]);
    expect(baldes[0]).toBe(baldes[2]);
    expect(baldes.join(" ")).not.toContain("dsk_token");
  });

  it("cabeçalho sem token reconhecível conta pelo IP", async () => {
    validar.mockRejectedValue(new McpAuthError(-32001, 401, "Missing or malformed Authorization header."));
    await autorizarGestaoDeIa(req("Basic abc", { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), {
      escrita: false,
      requestId: "r",
    });
    await autorizarGestaoDeIa(req("Basic abc", { "x-forwarded-for": "198.51.100.9" }), {
      escrita: false,
      requestId: "r",
    });
    expect(baldes[0]).toContain("203.0.113.7");
    expect(baldes[0]).not.toBe(baldes[1]);
  });

  it("erro interno na validação do token devolve mensagem genérica; o detalhe vai só para o log", async () => {
    validar.mockRejectedValue(new McpAuthError(-32603, 500, "Token lookup failed: relation api_tokens xyz"));
    const r = await autorizarGestaoDeIa(req("Bearer dsk_x"), { escrita: false, requestId: "req-42" });
    expect(!r.ok && r.response.status).toBe(500);
    if (r.ok) return;
    const corpo = (await r.response.json()) as { error: { message: string } };
    expect(corpo.error.message).not.toContain("api_tokens");
    expect(r.response.headers.get("X-Request-Id")).toBe("req-42");
    expect(logado).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logado.mock.calls[0])).toContain("api_tokens");
  });

  it("sem bearer, quem decide é a sessão com papel admin", async () => {
    requireRole.mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    });
    const r = await autorizarGestaoDeIa(req(), { escrita: true, requestId: "r" });
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(r).toMatchObject({ ok: true, orgId: ORG, actorUserId: "u-1", actorApiTokenId: null });
    expect(r.ok && (r.db as unknown as { quem: string }).quem).toBe("sessao");
  });
});

describe("as rotas para agentes estão fora do proxy de sessão — e só elas", () => {
  it.each([
    "/api/v1/ai/connected-providers",
    "/api/v1/ai/connected-providers/openrouter/models",
    "/api/v1/ai/purpose-bindings",
  ])("%s é público (a auth mora na rota)", (p) => {
    expect(isPublicPath(p)).toBe(true);
  });

  it.each([
    "/api/v1/ai/providers",
    "/api/v1/ai/credentials",
    "/api/v1/ai/connected-providers/openrouter/models/extra",
    "/api/v1/ai/purpose-bindings/x",
  ])("%s continua exigindo sessão no proxy", (p) => {
    expect(isPublicPath(p)).toBe(false);
  });
});
