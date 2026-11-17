// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { repositorioFunisSupabase } from "@/lib/inbox/atalhos/repositorio-funis";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/atalhos/repositorio-funis", () => ({ repositorioFunisSupabase: vi.fn() }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333331";
const T2 = "33333333-3333-4333-8333-333333333332";

const repo = {
  listar: vi.fn(),
  criar: vi.fn(),
  atualizar: vi.fn(),
  apagar: vi.fn(),
};

const corpo = (extra: Record<string, unknown> = {}) => ({
  nome: "Funil de valores",
  atalho: "funil-valores",
  palavras_chave: ["valores"],
  passos: [
    { template_id: T1, atraso_ms: 0, presenca: "digitando", presenca_ms: 2000 },
    { template_id: T2, atraso_ms: 3000, presenca: "nenhuma", presenca_ms: 0 },
    { template_id: T1, atraso_ms: 31000, presenca: "gravando", presenca_ms: 20000 },
  ],
  ...extra,
});

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/funnels", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

function papel(role: "agent" | "manager") {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER_ID }, org: { orgId: ORG_ID, role } } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  papel("manager");
  vi.mocked(repositorioFunisSupabase).mockReturnValue(repo as never);
});

describe("API de funis do operador", () => {
  it("cria funil com 3 passos e a lista devolve a duração somada", async () => {
    repo.criar.mockImplementation(async (_org: string, _u: string, f: { passos: { atraso_ms: number }[] }) => ({ id: "f1", ...f }));
    const { POST, GET } = await import("./route");
    const res = await POST(post(corpo()));
    expect(res.status).toBe(201);
    expect(repo.criar.mock.calls[0]?.[0]).toBe(ORG_ID);

    repo.listar.mockResolvedValue([{ id: "f1", ...corpo(), favorito: false, owner_user_id: null }]);
    const lista = (await (await GET(new NextRequest("http://localhost/api/v1/funnels"))).json()) as { data: { duracao_ms: number; compartilhado: boolean }[] };
    expect(lista.data[0]?.duracao_ms).toBe(34000);
    expect(lista.data[0]?.compartilhado).toBe(true);
  });

  it("atalho repetido na organização responde 409", async () => {
    repo.criar.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "23505" }));
    const { POST } = await import("./route");
    const res = await POST(post(corpo()));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("funnel_atalho_taken");
  });

  it("presença acima de 25 s é recusada com 422", async () => {
    const { POST } = await import("./route");
    const ruim = corpo();
    (ruim.passos as { presenca_ms: number }[])[2]!.presenca_ms = 30000;
    expect((await POST(post(ruim))).status).toBe(422);
    expect(repo.criar).not.toHaveBeenCalled();
  });

  it("agent não cria funil compartilhado (403); pessoal pode", async () => {
    papel("agent");
    repo.criar.mockImplementation(async (_o: string, _u: string, f: object) => ({ id: "f2", ...f }));
    const { POST } = await import("./route");
    expect((await POST(post(corpo({ compartilhado: true })))).status).toBe(403);
    expect((await POST(post(corpo({ compartilhado: false })))).status).toBe(201);
    expect(repo.criar.mock.calls[0]?.[2]).toMatchObject({ compartilhado: false });
  });

  it("atalho fora do padrão é recusado", async () => {
    const { POST } = await import("./route");
    expect((await POST(post(corpo({ atalho: "Funil Valores" })))).status).toBe(422);
  });
});
