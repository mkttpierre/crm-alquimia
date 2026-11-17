import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O selo do sino da Central aparece em TODA tela. Ele baixava a lista inteira
 * (`/api/v1/ai/inbox?status=open`, ~23 KB) só para ler `open_count`; agora usa
 * `/api/v1/ai/inbox/count`, que devolve só o número.
 */
const deps = vi.hoisted(() => ({ role: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));

import { GET } from "@/app/api/v1/ai/inbox/count/route";

/** Cadeia do supabase-js: select -> eq -> eq (thenable com o resultado). */
function cadeia(resultado: { count: number | null; error: unknown }) {
  const chamadas: Array<[string, ...unknown[]]> = [];
  const q: Record<string, unknown> = {};
  q.select = (...a: unknown[]) => (chamadas.push(["select", ...a]), q);
  q.eq = (...a: unknown[]) => (chamadas.push(["eq", ...a]), q);
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve(resultado).then(ok);
  const from = vi.fn(() => q);
  return { from, chamadas };
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "u", idioma: "pt-BR" },
    org: { orgId: "org-do-cookie", role: "agent" },
  });
});

describe("GET /api/v1/ai/inbox/count", () => {
  it("devolve só o número, contado na org do cookie e só os abertos, sem trazer linhas", async () => {
    const c = cadeia({ count: 7, error: null });
    deps.admin.mockReturnValue({ from: c.from });

    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ open_count: 7 });

    expect(deps.role).toHaveBeenCalledWith("agent", expect.anything());
    expect(c.from).toHaveBeenCalledWith("agent_inbox_items");
    expect(c.chamadas).toContainEqual(["select", "id", { count: "exact", head: true }]);
    expect(c.chamadas).toContainEqual(["eq", "organization_id", "org-do-cookie"]);
    expect(c.chamadas).toContainEqual(["eq", "status", "open"]);
  });

  it("sem permissão, devolve a resposta do requireRole e não toca no banco", async () => {
    deps.role.mockResolvedValue({ ok: false, response: new Response("no", { status: 403 }) });
    expect((await GET()).status).toBe(403);
    expect(deps.admin).not.toHaveBeenCalled();
  });

  it("erro do banco vira 500, não zero silencioso", async () => {
    deps.admin.mockReturnValue({ from: cadeia({ count: null, error: { message: "x" } }).from });
    expect((await GET()).status).toBe(500);
  });
});

describe("o sino não baixa mais a lista", () => {
  it("AlertsBell usa a contagem leve, não useAgentInbox", () => {
    const fonte = readFileSync("components/shell/AlertsBell.tsx", "utf8");
    expect(fonte).toMatch(/useAgentInboxCount\(\)/);
    expect(fonte).not.toMatch(/useAgentInbox\(/);
  });
});
