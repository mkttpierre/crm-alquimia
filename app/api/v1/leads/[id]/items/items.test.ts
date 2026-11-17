// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { repositorioItensSupabase } from "@/lib/negocio/repositorio-itens";
import { marcarGanhoPorProduto, reabrirSeSemItens } from "@/lib/negocio/ganho-por-itens";
import { acrescentarTagsDeCompra } from "@/lib/negocio/tag-de-compra";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/negocio/repositorio-itens", () => ({ repositorioItensSupabase: vi.fn() }));
vi.mock("@/lib/negocio/ganho-por-itens", () => ({
  marcarGanhoPorProduto: vi.fn(async () => ({ marcado: true })),
  reabrirSeSemItens: vi.fn(async () => true),
}));
vi.mock("@/lib/negocio/tag-de-compra", () => ({ acrescentarTagsDeCompra: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const LEAD = "33333333-3333-4333-8333-333333333333";
const PROD = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";

const repo = {
  buscarNegocio: vi.fn(),
  buscarProduto: vi.fn(),
  listar: vi.fn(),
  criar: vi.fn(),
  atualizar: vi.fn(),
  apagar: vi.fn(),
};

const ctx = { params: Promise.resolve({ id: LEAD }) };
const url = `http://localhost/api/v1/leads/${LEAD}/items`;
const req = (method: string, body?: unknown, qs = "") =>
  new NextRequest(url + qs, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });

const item = (extra: Record<string, unknown> = {}) => ({
  id: ITEM, lead_id: LEAD, product_id: PROD, nome: "Kit A", sku: "KIT-A1", quantidade: 2, preco_unit_cents: 5000,
  desconto_cents: 1000, acrescimo_cents: 0, cupom: null, currency: "BRL", total_cents: 9000, created_at: "2026-11-06T10:00:00Z", updated_at: "2026-11-06T10:00:00Z",
  ...extra,
});

function papel(role: "viewer" | "agent" | "manager") {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER_ID }, org: { orgId: ORG_ID, role } } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  papel("agent");
  vi.mocked(repositorioItensSupabase).mockReturnValue(repo as never);
  repo.buscarNegocio.mockResolvedValue({ id: LEAD, currency: "BRL", value_cents: 9000 });
  repo.listar.mockResolvedValue([item()]);
});

describe("GET /leads/[id]/items", () => {
  it("lista os itens com o total na moeda do negócio, sempre com a org da sessão", async () => {
    papel("viewer");
    const { GET } = await import("./route");
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { total_cents: number; valor_do_negocio_cents: number; itens: unknown[] } };
    expect(corpo.data.total_cents).toBe(9000);
    expect(corpo.data.valor_do_negocio_cents).toBe(9000);
    expect(corpo.data.itens).toHaveLength(1);
    expect(repo.buscarNegocio).toHaveBeenCalledWith(ORG_ID, LEAD);
    expect(repo.listar).toHaveBeenCalledWith(ORG_ID, LEAD);
  });

  it("negócio que a RLS não mostra responde 404", async () => {
    repo.buscarNegocio.mockResolvedValue(null);
    const { GET } = await import("./route");
    expect((await GET(req("GET"), ctx)).status).toBe(404);
  });

  it("id que não é uuid responde 422 sem tocar o banco", async () => {
    const { GET } = await import("./route");
    expect((await GET(req("GET"), { params: Promise.resolve({ id: "abc" }) })).status).toBe(422);
    expect(repo.buscarNegocio).not.toHaveBeenCalled();
  });
});

describe("POST /leads/[id]/items", () => {
  it("produto do catálogo: copia nome, sku e preço (snapshot) e grava com a org da sessão", async () => {
    repo.buscarProduto.mockResolvedValue({ id: PROD, codigo: "KIT-A1", nome: "Kit A", preco_cents: 5000, moeda: "BRL", ativo: true });
    repo.criar.mockImplementation(async (_o: string, _u: string, _l: string, linha: object) => item(linha as Record<string, unknown>));
    const { POST } = await import("./route");
    const res = await POST(req("POST", { product_id: PROD, quantidade: 2, desconto_cents: 1000 }), ctx);
    expect(res.status).toBe(201);
    const [org, usuario, lead, linha] = repo.criar.mock.calls[0] as [string, string, string, Record<string, unknown>];
    expect([org, usuario, lead]).toEqual([ORG_ID, USER_ID, LEAD]);
    expect(linha).toMatchObject({ product_id: PROD, nome: "Kit A", sku: "KIT-A1", preco_unit_cents: 5000, quantidade: 2, desconto_cents: 1000, currency: "BRL" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "lead_item.created", organizationId: ORG_ID }));
  });

  it("produto adicionado acrescenta a tag de compra (org da sessão, lead e nome/produto do item criado)", async () => {
    repo.buscarProduto.mockResolvedValue({ id: PROD, codigo: "OURO-1", nome: "Kit Ouro", preco_cents: 5000, moeda: "BRL", ativo: true });
    repo.criar.mockImplementation(async (_o: string, _u: string, _l: string, linha: object) => item(linha as Record<string, unknown>));
    const { POST } = await import("./route");
    expect((await POST(req("POST", { product_id: PROD }), ctx)).status).toBe(201);
    expect(acrescentarTagsDeCompra).toHaveBeenCalledTimes(1);
    expect(acrescentarTagsDeCompra).toHaveBeenCalledWith(expect.anything(), { organization_id: ORG_ID }, LEAD, [{ product_id: PROD, nome: "Kit Ouro" }]);
  });

  it("com ?venda=1 o produto lançado marca o negócio como ganho e devolve o resultado", async () => {
    repo.buscarProduto.mockResolvedValue({ id: PROD, codigo: "ROSA-1", nome: "Kit Rosa", preco_cents: 5000, moeda: "BRL", ativo: true });
    repo.criar.mockImplementation(async (_o: string, _u: string, _l: string, linha: object) => item(linha as Record<string, unknown>));
    const { POST } = await import("./route");
    const res = await POST(req("POST", { product_id: PROD }, "?venda=1"), ctx);
    expect(res.status).toBe(201);
    expect(marcarGanhoPorProduto).toHaveBeenCalledTimes(1);
    expect(marcarGanhoPorProduto).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organization_id: ORG_ID }), LEAD);
    expect((await res.json()).data.ganho).toEqual({ marcado: true });
  });

  it("sem ?venda=1 (dossiê do Kanban) o negócio NÃO é marcado como ganho", async () => {
    repo.buscarProduto.mockResolvedValue({ id: PROD, codigo: "ROSA-1", nome: "Kit Rosa", preco_cents: 5000, moeda: "BRL", ativo: true });
    repo.criar.mockImplementation(async (_o: string, _u: string, _l: string, linha: object) => item(linha as Record<string, unknown>));
    const { POST } = await import("./route");
    expect((await POST(req("POST", { product_id: PROD }), ctx)).status).toBe(201);
    expect(marcarGanhoPorProduto).not.toHaveBeenCalled();
  });

  it("item recusado (422) não mexe em tag", async () => {
    const { POST } = await import("./route");
    expect((await POST(req("POST", { nome: "Frete" }), ctx)).status).toBe(422);
    expect(acrescentarTagsDeCompra).not.toHaveBeenCalled();
  });

  it("organization_id no corpo é ignorado: vale a org da sessão", async () => {
    repo.criar.mockImplementation(async (_o: string, _u: string, _l: string, linha: object) => item(linha as Record<string, unknown>));
    const { POST } = await import("./route");
    const res = await POST(req("POST", { nome: "Frete", preco_unit_cents: 1500, organization_id: OUTRA_ORG }), ctx);
    expect(res.status).toBe(201);
    expect(repo.criar.mock.calls[0]?.[0]).toBe(ORG_ID);
    expect(repo.criar.mock.calls[0]?.[3]).not.toHaveProperty("organization_id");
  });

  it("item avulso sem preço é recusado com 422", async () => {
    const { POST } = await import("./route");
    expect((await POST(req("POST", { nome: "Frete" }), ctx)).status).toBe(422);
    expect(repo.criar).not.toHaveBeenCalled();
  });

  it("produto em outra moeda que o negócio responde 422 currency_mismatch", async () => {
    repo.buscarProduto.mockResolvedValue({ id: PROD, codigo: "X", nome: "X", preco_cents: 1, moeda: "USD", ativo: true });
    const { POST } = await import("./route");
    const res = await POST(req("POST", { product_id: PROD }), ctx);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("currency_mismatch");
  });

  it("produto de outra organização (a RLS não devolve) responde 404; inativo responde 422", async () => {
    repo.buscarProduto.mockResolvedValueOnce(null);
    const { POST } = await import("./route");
    expect((await POST(req("POST", { product_id: PROD }), ctx)).status).toBe(404);
    repo.buscarProduto.mockResolvedValueOnce({ id: PROD, codigo: "X", nome: "X", preco_cents: 1, moeda: "BRL", ativo: false });
    expect((await POST(req("POST", { product_id: PROD }), ctx)).status).toBe(422);
  });

  it("desconto maior que a linha responde 422", async () => {
    const { POST } = await import("./route");
    expect((await POST(req("POST", { nome: "Frete", preco_unit_cents: 1000, desconto_cents: 1001 }), ctx)).status).toBe(422);
    expect(repo.criar).not.toHaveBeenCalled();
  });

  it("viewer não escreve (a barreira de papel é do requireRole)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const { POST } = await import("./route");
    expect((await POST(req("POST", { nome: "x", preco_unit_cents: 1 }), ctx)).status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
    expect(repo.criar).not.toHaveBeenCalled();
  });

  it("negócio inexistente responde 404", async () => {
    repo.buscarNegocio.mockResolvedValue(null);
    const { POST } = await import("./route");
    expect((await POST(req("POST", { nome: "x", preco_unit_cents: 1 }), ctx)).status).toBe(404);
  });

  it("erro 42501 do banco vira 403", async () => {
    repo.criar.mockRejectedValue(Object.assign(new Error("rls"), { code: "42501" }));
    const { POST } = await import("./route");
    expect((await POST(req("POST", { nome: "x", preco_unit_cents: 1 }), ctx)).status).toBe(403);
  });
});

describe("PATCH /leads/[id]/items", () => {
  it("altera quantidade e devolve o item e a lista", async () => {
    repo.atualizar.mockResolvedValue(item({ quantidade: 3, total_cents: 14000 }));
    const { PATCH } = await import("./route");
    const res = await PATCH(req("PATCH", { item_id: ITEM, quantidade: 3 }), ctx);
    expect(res.status).toBe(200);
    expect(repo.atualizar).toHaveBeenCalledWith(ORG_ID, LEAD, ITEM, { quantidade: 3 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "lead_item.updated" }));
  });

  it("desconto que estoura a linha atual responde 422 sem gravar", async () => {
    const { PATCH } = await import("./route");
    const res = await PATCH(req("PATCH", { item_id: ITEM, desconto_cents: 99999 }), ctx);
    expect(res.status).toBe(422);
    expect(repo.atualizar).not.toHaveBeenCalled();
  });

  it("item que não é deste negócio responde 404", async () => {
    repo.listar.mockResolvedValue([]);
    const { PATCH } = await import("./route");
    expect((await PATCH(req("PATCH", { item_id: ITEM, quantidade: 3 }), ctx)).status).toBe(404);
  });

  it("corpo sem campo nenhum responde 422", async () => {
    const { PATCH } = await import("./route");
    expect((await PATCH(req("PATCH", { item_id: ITEM }), ctx)).status).toBe(422);
  });
});

describe("DELETE /leads/[id]/items", () => {
  it("apaga pelo item_id da query e audita", async () => {
    repo.apagar.mockResolvedValue(true);
    const { DELETE } = await import("./route");
    const res = await DELETE(req("DELETE", undefined, `?item_id=${ITEM}`), ctx);
    expect(res.status).toBe(204);
    expect(repo.apagar).toHaveBeenCalledWith(ORG_ID, LEAD, ITEM);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "lead_item.deleted" }));
  });

  it("com ?venda=1 tirar o produto tenta reabrir o negócio sem produto; sem ela, não", async () => {
    repo.apagar.mockResolvedValue(true);
    const { DELETE } = await import("./route");
    expect((await DELETE(req("DELETE", undefined, `?item_id=${ITEM}`), ctx)).status).toBe(204);
    expect(reabrirSeSemItens).not.toHaveBeenCalled();
    expect((await DELETE(req("DELETE", undefined, `?item_id=${ITEM}&venda=1`), ctx)).status).toBe(204);
    expect(reabrirSeSemItens).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organization_id: ORG_ID }), LEAD);
  });

  it("sem item_id responde 422; item inexistente responde 404", async () => {
    const { DELETE } = await import("./route");
    expect((await DELETE(req("DELETE"), ctx)).status).toBe(422);
    repo.apagar.mockResolvedValue(false);
    expect((await DELETE(req("DELETE", undefined, `?item_id=${ITEM}`), ctx)).status).toBe(404);
  });
});
