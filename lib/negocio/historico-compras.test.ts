import { describe, expect, it } from "vitest";

import { cicloMedioEmDias, montarHistoricoDeCompras } from "./historico-compras";

const ganho = (id: string, closed_at: string, value_cents: number | null, extra = {}) => ({
  lead_id: id, titulo: `Negócio ${id}`, closed_at, value_cents, currency: "BRL", itens: [], ...extra,
});
const pedido = (id: string, ordered_at: string, total_cents: number, extra = {}) => ({
  id, external_id: `NS-${id}`, ordered_at, total_cents, currency: "BRL", status: "paid", ...extra,
});

describe("cicloMedioEmDias", () => {
  it("média dos intervalos entre compras, em dias, com uma casa", () => {
    expect(cicloMedioEmDias(["2026-01-01T12:00:00Z", "2026-01-11T12:00:00Z", "2026-02-10T12:00:00Z"])).toBe(20);
    expect(cicloMedioEmDias(["2026-01-01T00:00:00Z", "2026-01-02T12:00:00Z"])).toBe(1.5);
  });

  it("ordena antes de medir (entrada fora de ordem)", () => {
    expect(cicloMedioEmDias(["2026-02-10T12:00:00Z", "2026-01-01T12:00:00Z", "2026-01-11T12:00:00Z"])).toBe(20);
  });

  it("com menos de duas compras não há ciclo", () => {
    expect(cicloMedioEmDias([])).toBeNull();
    expect(cicloMedioEmDias(["2026-01-01T00:00:00Z"])).toBeNull();
  });
});

describe("montarHistoricoDeCompras", () => {
  it("soma negócios ganhos e pedidos pagos; total, nº de compras, última e ciclo", () => {
    const h = montarHistoricoDeCompras({
      negocios: [ganho("a", "2026-01-01T12:00:00Z", 10000), ganho("b", "2026-01-31T12:00:00Z", 5000)],
      pedidos: [pedido("p1", "2026-01-11T12:00:00Z", 2500)],
    });
    expect(h.numero_de_compras).toBe(3);
    expect(h.total_gasto_cents).toBe(17500);
    expect(h.ultima_compra).toBe("2026-01-31T12:00:00.000Z");
    expect(h.ciclo_medio_dias).toBe(15);
    expect(h.compras.map((c) => c.tipo)).toEqual(["negocio", "pedido", "negocio"]);
    expect(h.compras[0]?.data).toBe("2026-01-31T12:00:00.000Z");
  });

  it("pedido pendente, cancelado ou reembolsado não é compra", () => {
    const h = montarHistoricoDeCompras({
      negocios: [],
      pedidos: [pedido("p1", "2026-01-01T00:00:00Z", 100, { status: "pending" }), pedido("p2", "2026-01-02T00:00:00Z", 100, { status: "cancelled" }), pedido("p3", "2026-01-03T00:00:00Z", 100, { status: "refunded" }), pedido("p4", "2026-01-04T00:00:00Z", 100, { status: "delivered" })],
    });
    expect(h.numero_de_compras).toBe(1);
    expect(h.total_gasto_cents).toBe(100);
  });

  it("negócio ganho sem valor conta como compra de R$ 0 (a venda existiu), sem quebrar o total", () => {
    const h = montarHistoricoDeCompras({ negocios: [ganho("a", "2026-01-01T00:00:00Z", null)], pedidos: [] });
    expect(h.numero_de_compras).toBe(1);
    expect(h.total_gasto_cents).toBe(0);
  });

  it("outra moeda fica fora da soma e é contada à parte", () => {
    const h = montarHistoricoDeCompras({
      negocios: [ganho("a", "2026-01-01T00:00:00Z", 100, { currency: "USD" }), ganho("b", "2026-01-02T00:00:00Z", 300)],
      pedidos: [],
    });
    expect(h.total_gasto_cents).toBe(300);
    expect(h.numero_de_compras).toBe(1);
    expect(h.ignoradas_outra_moeda).toBe(1);
  });

  it("os itens do negócio ganho saem na compra", () => {
    const h = montarHistoricoDeCompras({
      negocios: [ganho("a", "2026-01-01T00:00:00Z", 9000, { itens: [{ nome: "Kit A", quantidade: 2, total_cents: 9000 }] })],
      pedidos: [],
    });
    expect(h.compras[0]?.itens).toEqual([{ nome: "Kit A", quantidade: 2, total_cents: 9000 }]);
  });

  it("sem nada devolve zeros e nulos", () => {
    expect(montarHistoricoDeCompras({ negocios: [], pedidos: [] })).toEqual({
      compras: [], total_gasto_cents: 0, numero_de_compras: 0, ultima_compra: null, ciclo_medio_dias: null, ignoradas_outra_moeda: 0, currency: "BRL",
    });
  });
});
