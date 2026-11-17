import { describe, expect, it } from "vitest";

import { somaDoNegocio, totalDoItem } from "./totais";

describe("totalDoItem", () => {
  it("quantidade × preço − desconto + acréscimo", () => {
    expect(totalDoItem({ quantidade: 3, preco_unit_cents: 5000, desconto_cents: 1000, acrescimo_cents: 250 })).toBe(14250);
  });

  it("sem desconto nem acréscimo é só quantidade × preço", () => {
    expect(totalDoItem({ quantidade: 2, preco_unit_cents: 1990, desconto_cents: 0, acrescimo_cents: 0 })).toBe(3980);
  });

  it("desconto maior que o bruto é recusado (o banco também recusa total negativo)", () => {
    expect(() => totalDoItem({ quantidade: 1, preco_unit_cents: 1000, desconto_cents: 1001, acrescimo_cents: 0 })).toThrow(/negativo/i);
  });
});

describe("somaDoNegocio", () => {
  const itens = [
    { total_cents: 14250, currency: "BRL" },
    { total_cents: 750, currency: "BRL" },
    { total_cents: 99999, currency: "USD" },
  ];

  it("soma só a moeda do negócio e conta os ignorados", () => {
    expect(somaDoNegocio(itens, "BRL")).toEqual({ total_cents: 15000, itens: 2, ignorados_outra_moeda: 1 });
  });

  it("sem item na moeda devolve itens 0 (o valor manual do negócio segue valendo)", () => {
    expect(somaDoNegocio(itens, "EUR")).toEqual({ total_cents: 0, itens: 0, ignorados_outra_moeda: 3 });
  });

  it("lista vazia", () => {
    expect(somaDoNegocio([], "BRL")).toEqual({ total_cents: 0, itens: 0, ignorados_outra_moeda: 0 });
  });
});
