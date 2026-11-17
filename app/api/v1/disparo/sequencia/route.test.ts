// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { agendarSequencia } from "@/lib/disparo/atendimento/sequencia-operador";
import { repositorioSequenciaSupabase } from "@/lib/disparo/atendimento/sequencia-operador-supabase";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/disparo/atendimento/sequencia-operador-supabase", () => ({ repositorioSequenciaSupabase: vi.fn() }));
vi.mock("@/lib/disparo/atendimento/sequencia-operador", async (orig) => ({
  ...(await orig<typeof import("@/lib/disparo/atendimento/sequencia-operador")>()),
  agendarSequencia: vi.fn(),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const FUNIL = "55555555-5555-4555-8555-555555555555";
const TPL = "66666666-6666-4666-8666-666666666666";

/** `conversations` visível (ou não) na sessão. */
const sessao = (visivel: boolean) => ({
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: visivel ? { id: CONV } : null }) }) }) }) }),
});

const repo = { leadDaConversa: vi.fn(), andamento: vi.fn() };

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/disparo/sequencia", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1" }, org: { orgId: ORG, role: "agent" } } as never);
  vi.mocked(createClient).mockResolvedValue(sessao(true) as never);
  vi.mocked(repositorioSequenciaSupabase).mockReturnValue(repo as never);
});

describe("POST /api/v1/disparo/sequencia — funil ou mensagem", () => {
  it("funil e mensagem juntos no mesmo pedido: 422", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ conversation_id: CONV, funnel_id: FUNIL, template_id: TPL }))).status).toBe(422);
    expect(agendarSequencia).not.toHaveBeenCalled();
  });

  it("nenhum dos três: 422", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ conversation_id: CONV }))).status).toBe(422);
  });

  it("mensagem avulsa (template_id) agenda e responde 201 com 1 parte", async () => {
    const agora = new Date();
    vi.mocked(agendarSequencia).mockResolvedValue({ titulo: "Tabela", partes: 1, modo: "real", motivoSimulado: null, chip: "celular-a", primeiraEm: agora, ultimaEm: agora, duracaoSeg: 4 });
    const { POST } = await import("./route");
    const res = await POST(post({ conversation_id: CONV, template_id: TPL }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { partes: number } }).data.partes).toBe(1);
    expect(vi.mocked(agendarSequencia).mock.calls[0]![2]).toMatchObject({ templateId: TPL, conversationId: CONV });
  });
});

describe("GET /api/v1/disparo/sequencia — andamento do funil na conversa", () => {
  const get = () => new NextRequest(`http://localhost/api/v1/disparo/sequencia?conversation_id=${CONV}`);

  it("sem funil em andamento: em_andamento false", async () => {
    repo.leadDaConversa.mockResolvedValue("l1");
    repo.andamento.mockResolvedValue({ enviadas: 0, total: 0, pendentes: 0, proximaEm: null, prefixo: null });
    const { GET } = await import("./route");
    const corpo = (await (await GET(get())).json()) as { data: { em_andamento: boolean } };
    expect(corpo.data.em_andamento).toBe(false);
  });

  it("com partes pendentes: conta enviadas/total e dá a próxima", async () => {
    repo.leadDaConversa.mockResolvedValue("l1");
    repo.andamento.mockResolvedValue({ enviadas: 2, total: 7, pendentes: 5, proximaEm: new Date("2026-11-06T17:32:00Z"), prefixo: "funil_valores" });
    const { GET } = await import("./route");
    const corpo = (await (await GET(get())).json()) as { data: Record<string, unknown> };
    expect(corpo.data).toMatchObject({ em_andamento: true, enviadas: 2, total: 7, proxima_em: "2026-11-06T17:32:00.000Z", tipo: "funil_valores" });
  });

  it("conversa que o usuário não vê (outra organização): 404", async () => {
    vi.mocked(createClient).mockResolvedValue(sessao(false) as never);
    const { GET } = await import("./route");
    expect((await GET(get())).status).toBe(404);
  });
});
