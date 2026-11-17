import { describe, expect, it } from "vitest";

import { semComissao } from "./sem-comissao";

const VENDA = { id: "l1", title: "Venda — Maria", status: "won", value_cents: 12000, currency: "BRL", valor_sigiloso: true };
const MANUAL = { id: "l2", title: "Negócio comum", status: "open", value_cents: 5000, currency: "BRL", valor_sigiloso: false };

describe("semComissao — o sigilo é da coluna valor_sigiloso", () => {
  it("negócio sigiloso sai com value_cents nulo", () => {
    expect(semComissao(VENDA)).toMatchObject({ id: "l1", value_cents: null });
  });

  it("negócio com valor_sigiloso = true (item interno da aba Produtos, venda registrada) também sai nulo", () => {
    const r = semComissao({ id: "l3", value_cents: 9000, valor_sigiloso: true }) as { value_cents: number | null };
    expect(r.value_cents).toBeNull();
  });

  it("negócio comum (valor_sigiloso = false) passa com o valor, e a marca não sai", () => {
    expect(semComissao(MANUAL)).toMatchObject({ id: "l2", value_cents: 5000 });
    expect(semComissao(MANUAL)).not.toHaveProperty("valor_sigiloso");
  });

  it("a marca nunca sai, nem do negócio sigiloso", () => {
    const r = semComissao(VENDA);
    expect(r).not.toHaveProperty("valor_sigiloso");
  });

  it("FALHA FECHADO: saída de negócio sem a coluna (value_cents sem valor_sigiloso) não mostra o valor", () => {
    const r = semComissao({ id: "l4", title: "x", value_cents: 5000, currency: "BRL" }) as { value_cents: number | null };
    expect(r.value_cents).toBeNull();
    const lista = semComissao({ leads: [{ id: "a", value_cents: 1 }, MANUAL] }) as { leads: Array<{ value_cents: number | null }> };
    expect(lista.leads.map((l) => l.value_cents)).toEqual([null, 5000]);
  });

  it("alcança qualquer profundidade: { lead }, { leads: [...] }, listas dentro de listas", () => {
    const r = semComissao({ lead: VENDA, leads: [MANUAL, VENDA], resto: { aninhado: [{ lead: VENDA }] } }) as {
      lead: typeof VENDA;
      leads: Array<typeof VENDA>;
      resto: { aninhado: Array<{ lead: typeof VENDA }> };
    };
    expect(r.lead.value_cents).toBeNull();
    expect(r.leads.map((l) => l.value_cents)).toEqual([5000, null]);
    expect(r.resto.aninhado[0]!.lead.value_cents).toBeNull();
  });

  it("os FILHOS de um negócio sigiloso perdem os campos de dinheiro (total_cents, amount, preço, desconto…), e o resto fica", () => {
    const r = semComissao({
      ...VENDA,
      itens: [{ nome: "12 MESES", quantidade: 1, preco_unit_cents: 49371, desconto_cents: 0, total_cents: 49371, currency: "BRL" }],
      pagamento: { amount: 49371, amount_cents: 49371, price: 493.71, valor: 493.71, metodo: "pix" },
      tags: ["vip"],
    }) as Record<string, unknown>;
    expect(r.itens).toEqual([{ nome: "12 MESES", quantidade: 1, currency: "BRL" }]);
    expect(r.pagamento).toEqual({ metodo: "pix" });
    expect(r.tags).toEqual(["vip"]);
    expect(JSON.stringify(r)).not.toContain("49371");
  });

  it("os filhos de um negócio comum mantêm o dinheiro deles", () => {
    const r = semComissao({ ...MANUAL, itens: [{ total_cents: 700 }] }) as { itens: Array<{ total_cents: number }> };
    expect(r.itens[0]!.total_cents).toBe(700);
  });

  it("não muta o original (a tela e o audit seguem vendo o valor)", () => {
    const original = { lead: { ...VENDA, itens: [{ total_cents: 5 }] } };
    semComissao(original);
    expect(original.lead.value_cents).toBe(12000);
    expect(original.lead.itens[0]!.total_cents).toBe(5);
  });

  it("valores que não são objeto simples passam intactos", () => {
    expect(semComissao(null)).toBeNull();
    expect(semComissao("texto")).toBe("texto");
    expect(semComissao(3)).toBe(3);
    const data = new Date("2026-11-08T00:00:00Z");
    expect(semComissao({ quando: data })).toEqual({ quando: data });
  });

  it("objeto sem value_cents e sem marca (um contato, um pedido) não é tocado", () => {
    const pedido = { id: "o1", total_cents: 900, status: "paid" };
    expect(semComissao(pedido)).toEqual(pedido);
  });
});
