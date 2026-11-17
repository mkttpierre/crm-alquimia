import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { lerAlvoDaVenda } from "@/lib/negocio/alvo-da-venda";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ marca: "sessao" })) }));
vi.mock("@/lib/negocio/alvo-da-venda", () => ({ lerAlvoDaVenda: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const get = (qs: string) => new NextRequest(`http://localhost/api/v1/sales/alvo${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u" }, org: { orgId: ORG } } as never);
  vi.mocked(lerAlvoDaVenda).mockResolvedValue({ negocio: null, moeda: "BRL", itens: [], ja_no_negocio_cents: 0, timezone: "America/Sao_Paulo", hoje: "2026-11-08" });
});

describe("GET /api/v1/sales/alvo", () => {
  it("exige agent+ e usa a organização da sessão (nunca uma da consulta)", async () => {
    const { GET } = await import("./route");
    const r = await GET(get(`?contact_id=${CONTATO}&organization_id=${OUTRA}`));
    expect(r.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
    const [db, org, alvo] = vi.mocked(lerAlvoDaVenda).mock.calls[0]!;
    expect(db).toEqual({ marca: "sessao" });
    expect(org).toBe(ORG);
    expect(alvo).toEqual({ contactId: CONTATO, leadId: null });
  });

  it("repassa contato e negócio e devolve o alvo no envelope", async () => {
    const { GET } = await import("./route");
    const r = await GET(get(`?contact_id=${CONTATO}&lead_id=${LEAD}`));
    expect(vi.mocked(lerAlvoDaVenda).mock.calls[0]![2]).toEqual({ contactId: CONTATO, leadId: LEAD });
    expect((await r.json()).data).toMatchObject({ moeda: "BRL", hoje: "2026-11-08", itens: [] });
  });

  it("sem contato nem negócio, ou com id inválido: 422 sem consultar", async () => {
    const { GET } = await import("./route");
    expect((await GET(get(""))).status).toBe(422);
    expect((await GET(get("?contact_id=nao-e-uuid"))).status).toBe(422);
    expect(lerAlvoDaVenda).not.toHaveBeenCalled();
  });

  it("papel de leitura é barrado pelo requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const { GET } = await import("./route");
    expect((await GET(get(`?contact_id=${CONTATO}`))).status).toBe(403);
    expect(lerAlvoDaVenda).not.toHaveBeenCalled();
  });

  it("falha do banco vira 500 sem vazar a mensagem", async () => {
    vi.mocked(lerAlvoDaVenda).mockRejectedValue(new Error('relation "x" does not exist'));
    const { GET } = await import("./route");
    const r = await GET(get(`?contact_id=${CONTATO}`));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("relation");
  });
});
