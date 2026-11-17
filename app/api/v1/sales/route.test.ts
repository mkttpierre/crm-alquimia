import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { registrarVenda } from "@/lib/negocio/registrar-venda";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ marca: "sessao" })) }));
vi.mock("@/lib/negocio/registrar-venda", () => ({ registrarVenda: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const PRODUTO = "44444444-4444-4444-8444-444444444444";

const VENDA = { lead_id: "55555555-5555-4555-8555-555555555555", contact_id: CONTATO, pipeline_id: "p", criado: true, ja_registrada: false, total_cents: 12000, currency: "BRL", closed_at: "2026-11-08T15:00:00.000Z", title: "Venda — Maria" };

function pedido(corpo: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/sales", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json", ...headers },
  });
}

const CHAVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const comChave = { "Idempotency-Key": CHAVE };

const corpoValido = { contact_id: CONTATO, itens: [{ product_id: PRODUTO, quantidade: 1, preco_unit_cents: 12000 }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG } } as never);
  vi.mocked(registrarVenda).mockResolvedValue(VENDA);
});

describe("POST /api/v1/sales — Idempotency-Key é obrigatória e é UUID", () => {
  it("sem a chave: 400 com o envelope de erro, e nada é gravado (sem chave o clique duplo lançaria duas vendas)", async () => {
    const { POST } = await import("./route");
    const r = await POST(pedido(corpoValido));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatchObject({ code: "invalid_request" });
    expect(registrarVenda).not.toHaveBeenCalled();
  });

  it.each([["vazia", ""], ["não é UUID", "k1"], ["UUID com lixo", `${CHAVE}-x`], ["longa demais (nunca truncar)", `${CHAVE}${"a".repeat(300)}`], ["UUID de outra versão", "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa"]])("chave %s: 400, nada gravado", async (_nome, valor) => {
    const { POST } = await import("./route");
    const r = await POST(pedido(corpoValido, { "Idempotency-Key": valor }));
    expect(r.status).toBe(400);
    expect(registrarVenda).not.toHaveBeenCalled();
  });

  it("a chave válida chega ao serviço exatamente como veio (sem truncar, sem normalizar caixa)", async () => {
    const { POST } = await import("./route");
    await POST(pedido(corpoValido, { "Idempotency-Key": CHAVE.toUpperCase() }));
    expect(vi.mocked(registrarVenda).mock.calls[0]![3]).toBe(CHAVE.toUpperCase());
  });

  it("a validação da chave vem ANTES de qualquer leitura do corpo ou do banco", async () => {
    const { POST } = await import("./route");
    await POST(pedido({ contact_id: "isto-nao-e-uuid", itens: [] }, { "Idempotency-Key": "ruim" }));
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/sales", () => {
  it("exige papel agent ou maior", async () => {
    const { POST } = await import("./route");
    await POST(pedido(corpoValido, comChave));
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
  });

  it("recusa quem não tem o papel (viewer) sem tocar a venda", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) } as never);
    const { POST } = await import("./route");
    const r = await POST(pedido(corpoValido, comChave));
    expect(r.status).toBe(403);
    expect(registrarVenda).not.toHaveBeenCalled();
  });

  it("a organização é a da sessão, nunca a do corpo", async () => {
    const { POST } = await import("./route");
    await POST(pedido({ ...corpoValido, organization_id: OUTRA_ORG }, comChave));
    const [, ctx, input] = vi.mocked(registrarVenda).mock.calls[0]!;
    expect(ctx.organization_id).toBe(ORG);
    expect(ctx.actor).toEqual({ type: "user", id: USER });
    expect(JSON.stringify(input)).not.toContain(OUTRA_ORG);
  });

  it("usa o cliente da SESSÃO (a RLS vale), não o administrador", async () => {
    const { POST } = await import("./route");
    await POST(pedido(corpoValido, comChave));
    expect(createClient).toHaveBeenCalled();
    expect(vi.mocked(registrarVenda).mock.calls[0]![0]).toEqual({ marca: "sessao" });
  });

  it("repassa a Idempotency-Key ao serviço", async () => {
    const { POST } = await import("./route");
    await POST(pedido(corpoValido, comChave));
    expect(vi.mocked(registrarVenda).mock.calls[0]![3]).toBe(CHAVE);
  });

  it("201 na venda nova; 200 quando a mesma chave repete (clique duplo não lança duas vendas)", async () => {
    const { POST } = await import("./route");
    expect((await POST(pedido(corpoValido, comChave))).status).toBe(201);
    vi.mocked(registrarVenda).mockResolvedValue({ ...VENDA, ja_registrada: true, criado: false });
    const repetida = await POST(pedido(corpoValido, comChave));
    expect(repetida.status).toBe(200);
    expect((await repetida.json()).data).toMatchObject({ ja_registrada: true });
  });

  it("corpo inválido (sem produtos, desconto maior que a linha) = 422 e nada é gravado", async () => {
    const { POST } = await import("./route");
    expect((await POST(pedido({ contact_id: CONTATO, itens: [] }, comChave))).status).toBe(422);
    expect((await POST(pedido({ contact_id: CONTATO, itens: [{ product_id: PRODUTO, preco_unit_cents: 100, desconto_cents: 500 }] }, comChave))).status).toBe(422);
    expect((await POST(new NextRequest("http://localhost/api/v1/sales", { method: "POST", body: "isto não é json", headers: comChave }))).status).toBe(422);
    expect(registrarVenda).not.toHaveBeenCalled();
  });

  it("erro de negócio do serviço (data futura) volta como 422 com o código", async () => {
    vi.mocked(registrarVenda).mockRejectedValue(new ApiError(422, "validation_failed", { motivo: "data_futura" }, "req", "A data da venda não pode ser futura."));
    const { POST } = await import("./route");
    const r = await POST(pedido(corpoValido, comChave));
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatchObject({ code: "validation_failed", details: { motivo: "data_futura" } });
  });

  it("o alvo mudou (409 state_conflict) volta como 409 com o motivo, para o quadro recarregar a prévia", async () => {
    vi.mocked(registrarVenda).mockRejectedValue(new ApiError(409, "state_conflict", { motivo: "alvo_mudou" }, "req", "O negócio desta venda mudou"));
    const { POST } = await import("./route");
    const r = await POST(pedido({ ...corpoValido, negocio_previsto: "novo" }, comChave));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatchObject({ code: "state_conflict", details: { motivo: "alvo_mudou" } });
    expect(vi.mocked(registrarVenda).mock.calls[0]![2]).toMatchObject({ negocio_previsto: "novo" });
  });

  it("negocio_previsto que não é id nem 'novo' = 422 e nada é gravado", async () => {
    const { POST } = await import("./route");
    expect((await POST(pedido({ ...corpoValido, negocio_previsto: "qualquer-coisa" }, comChave))).status).toBe(422);
    expect(registrarVenda).not.toHaveBeenCalled();
  });

  it("falha inesperada vira 500 sem vazar a mensagem", async () => {
    vi.mocked(registrarVenda).mockRejectedValue(new Error('relation "x" does not exist'));
    const { POST } = await import("./route");
    const r = await POST(pedido(corpoValido, comChave));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("relation");
  });
});
