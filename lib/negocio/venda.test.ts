import { describe, expect, it } from "vitest";

import { diaCivil } from "./faturamento";
import { instanteDaVenda, itensParaRpc, totalDaVenda, vendaCriarSchema } from "./venda";

const CONTATO = "11111111-1111-4111-8111-111111111111";
const PRODUTO = "22222222-2222-4222-8222-222222222222";
const TZ = "America/Sao_Paulo";

const corpo = (extra: Record<string, unknown> = {}) => ({
  contact_id: CONTATO,
  itens: [{ product_id: PRODUTO, quantidade: 1, preco_unit_cents: 12000 }],
  ...extra,
});

describe("vendaCriarSchema", () => {
  it("aceita uma linha de produto com o preço editado por linha (o do corpo vale, não o do catálogo)", () => {
    const r = vendaCriarSchema.safeParse(corpo({ itens: [{ product_id: PRODUTO, quantidade: 2, preco_unit_cents: 9990, desconto_cents: 500 }] }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.itens[0]).toMatchObject({ preco_unit_cents: 9990, quantidade: 2, desconto_cents: 500 });
  });

  it("negocio_previsto: o id do negócio mostrado ou \"novo\"; qualquer outra coisa é recusada", () => {
    expect(vendaCriarSchema.safeParse(corpo({ negocio_previsto: "novo" })).success).toBe(true);
    expect(vendaCriarSchema.safeParse(corpo({ negocio_previsto: PRODUTO })).success).toBe(true);
    expect(vendaCriarSchema.safeParse(corpo()).success).toBe(true);
    expect(vendaCriarSchema.safeParse(corpo({ negocio_previsto: "qualquer-coisa" })).success).toBe(false);
    expect(vendaCriarSchema.safeParse(corpo({ negocio_previsto: "" })).success).toBe(false);
  });

  it("quantidade e desconto têm padrão (1 e 0)", () => {
    const r = vendaCriarSchema.parse(corpo());
    expect(r.itens[0]).toMatchObject({ quantidade: 1, desconto_cents: 0 });
  });

  it("exige ao menos uma linha, e no máximo 50", () => {
    expect(vendaCriarSchema.safeParse(corpo({ itens: [] })).success).toBe(false);
    const muitas = Array.from({ length: 51 }, () => ({ product_id: PRODUTO, preco_unit_cents: 100 }));
    expect(vendaCriarSchema.safeParse(corpo({ itens: muitas })).success).toBe(false);
  });

  it("item avulso (sem produto) precisa de nome; com produto, o nome vem do catálogo", () => {
    expect(vendaCriarSchema.safeParse(corpo({ itens: [{ preco_unit_cents: 100 }] })).success).toBe(false);
    expect(vendaCriarSchema.safeParse(corpo({ itens: [{ nome: "Brinde", preco_unit_cents: 100 }] })).success).toBe(true);
  });

  it("preço é obrigatório em toda linha e não pode ser negativo", () => {
    expect(vendaCriarSchema.safeParse(corpo({ itens: [{ product_id: PRODUTO }] })).success).toBe(false);
    expect(vendaCriarSchema.safeParse(corpo({ itens: [{ product_id: PRODUTO, preco_unit_cents: -1 }] })).success).toBe(false);
  });

  it("recusa desconto maior que a linha (o banco recusaria o total negativo)", () => {
    const r = vendaCriarSchema.safeParse(corpo({ itens: [{ product_id: PRODUTO, quantidade: 1, preco_unit_cents: 1000, desconto_cents: 1001 }] }));
    expect(r.success).toBe(false);
  });

  it("precisa de contato ou de negócio", () => {
    expect(vendaCriarSchema.safeParse({ itens: corpo().itens }).success).toBe(false);
    expect(vendaCriarSchema.safeParse({ lead_id: PRODUTO, itens: corpo().itens }).success).toBe(true);
  });

  it("organization_id do corpo é descartado: a organização vem da sessão", () => {
    const r = vendaCriarSchema.parse(corpo({ organization_id: "99999999-9999-4999-8999-999999999999" }));
    expect(r).not.toHaveProperty("organization_id");
  });

  it("data da venda só no formato AAAA-MM-DD", () => {
    expect(vendaCriarSchema.safeParse(corpo({ data_venda: "2026-11-05" })).success).toBe(true);
    expect(vendaCriarSchema.safeParse(corpo({ data_venda: "05/11/2026" })).success).toBe(false);
    expect(vendaCriarSchema.safeParse(corpo({ data_venda: "2026-02-30" })).success).toBe(false);
  });
});

describe("instanteDaVenda", () => {
  const agora = new Date("2026-11-08T15:00:00Z"); // 12h em São Paulo, domingo 08/11

  it("sem data, ou com a data de hoje no fuso da organização, a venda é agora", () => {
    expect(instanteDaVenda(undefined, TZ, agora)).toEqual({ ok: true, instante: agora });
    expect(instanteDaVenda("2026-11-08", TZ, agora)).toEqual({ ok: true, instante: agora });
  });

  it("data passada cai no MEIO do dia no fuso da organização, e conta nesse dia no Faturamento", () => {
    const r = instanteDaVenda("2026-11-05", TZ, agora);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(diaCivil(r.instante, TZ)).toBe("2026-11-05");
      expect(r.instante.toISOString()).toBe("2026-11-05T15:00:00.000Z");
    }
  });

  it("data futura é recusada", () => {
    expect(instanteDaVenda("2026-11-09", TZ, agora)).toEqual({ ok: false, motivo: "data_futura" });
  });

  it("o 'hoje' é o do fuso da organização, não o do UTC", () => {
    const noiteEmSP = new Date("2026-11-08T02:00:00Z"); // 23h de 07/11 em São Paulo
    expect(instanteDaVenda("2026-11-08", TZ, noiteEmSP)).toEqual({ ok: false, motivo: "data_futura" });
    expect(instanteDaVenda("2026-11-07", TZ, noiteEmSP)).toEqual({ ok: true, instante: noiteEmSP });
  });

  it("data impossível é recusada", () => {
    expect(instanteDaVenda("2026-02-30", TZ, agora)).toEqual({ ok: false, motivo: "data_invalida" });
  });

  it("fuso desconhecido cai no padrão do produto em vez de quebrar", () => {
    const r = instanteDaVenda("2026-11-05", "Nao/Existe", agora);
    expect(r.ok).toBe(true);
  });
});

describe("totais da venda", () => {
  it("total ao vivo = soma de quantidade × preço − desconto, linha a linha", () => {
    expect(totalDaVenda([
      { quantidade: 1, preco_unit_cents: 12000, desconto_cents: 0 },
      { quantidade: 2, preco_unit_cents: 5000, desconto_cents: 1000 },
    ])).toBe(21000);
  });

  it("itensParaRpc manda só o que a função do banco conhece (nome, sku e product_id)", () => {
    const itens = itensParaRpc(vendaCriarSchema.parse(corpo({ itens: [{ product_id: PRODUTO, preco_unit_cents: 7000, quantidade: 3 }, { nome: " Brinde ", preco_unit_cents: 0 }] })).itens);
    expect(itens).toEqual([
      { product_id: PRODUTO, nome: null, sku: null, quantidade: 3, preco_unit_cents: 7000, desconto_cents: 0 },
      { product_id: null, nome: "Brinde", sku: null, quantidade: 1, preco_unit_cents: 0, desconto_cents: 0 },
    ]);
  });
});
