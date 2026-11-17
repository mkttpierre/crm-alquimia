// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { repositorioHistoricoSupabase } from "@/lib/negocio/repositorio-historico";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/negocio/repositorio-historico", () => ({ repositorioHistoricoSupabase: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const repo = { carregar: vi.fn() };
const ctx = { params: Promise.resolve({ id: CONTATO }) };
const req = new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/purchase-history`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u" }, org: { orgId: ORG_ID, role: "viewer" } } as never);
  vi.mocked(repositorioHistoricoSupabase).mockReturnValue(repo as never);
});

describe("GET /contacts/[id]/purchase-history", () => {
  it("calcula total, compras, última e ciclo com a org da sessão", async () => {
    repo.carregar.mockResolvedValue({
      negocios: [{ lead_id: "a", titulo: "Kit", closed_at: "2026-01-01T12:00:00Z", value_cents: 10000, currency: "BRL", itens: [] }],
      pedidos: [{ id: "p", external_id: "1", ordered_at: "2026-01-11T12:00:00Z", total_cents: 4000, currency: "BRL", status: "paid" }],
    });
    const { GET } = await import("./route");
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { total_gasto_cents: number; numero_de_compras: number; ciclo_medio_dias: number } };
    expect(data).toMatchObject({ total_gasto_cents: 14000, numero_de_compras: 2, ciclo_medio_dias: 10 });
    expect(repo.carregar).toHaveBeenCalledWith(ORG_ID, CONTATO);
  });

  it("id inválido responde 422; falha do banco responde 500", async () => {
    const { GET } = await import("./route");
    expect((await GET(req, { params: Promise.resolve({ id: "x" }) })).status).toBe(422);
    repo.carregar.mockRejectedValue(new Error("boom"));
    expect((await GET(req, ctx)).status).toBe(500);
  });
});
