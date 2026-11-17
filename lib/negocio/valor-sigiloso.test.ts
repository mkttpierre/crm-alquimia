// @vitest-environment node
import { describe, expect, it } from "vitest";

import { semDinheiro } from "@/lib/mcp/sem-comissao";

import { CAMPO_DE_DINHEIRO, semCamposDeDinheiro } from "./valor-sigiloso";

describe("CAMPO_DE_DINHEIRO — a regra canônica de nome de campo que carrega dinheiro", () => {
  it.each([
    "value_cents",
    "total",
    "amount_paid",
    "price",
    "Preco_Final",
    "valor_proposta",
    // D1: o que a comissão costuma ser chamada em campo personalizado ou de integração.
    "comissao",
    "comissão",
    "COMISSÃO",
    "comissao_pct",
    "desconto",
    "desconto_acordado",
    "custo",
    "Custo_Unitario",
    "custos",
    "receita",
    "receita_prevista",
    "lucro",
    "lucro_liquido",
    "margem",
    "margem_de_contribuicao",
  ])("%s é campo de dinheiro", (chave) => {
    expect(CAMPO_DE_DINHEIRO.test(chave)).toBe(true);
  });

  it.each(["cidade", "nome", "tags", "custom_fields", "customer_id", "customizacao", "origem", "title", "notas"])(
    "%s NÃO é campo de dinheiro (campo legítimo de negócio)",
    (chave) => {
      expect(CAMPO_DE_DINHEIRO.test(chave)).toBe(false);
    },
  );
});

describe("a regra ampliada vale em todas as saídas que a usam", () => {
  const original = {
    cidade: "Recife",
    custom_fields: { a: 1 },
    comissao: 10,
    comissão: 11,
    desconto: 5,
    custo: 3,
    receita: 9,
    lucro: 2,
    margem: 1,
  };
  const esperado = { cidade: "Recife", custom_fields: { a: 1 } };

  it("payload de webhook/automação (semCamposDeDinheiro)", () => {
    expect(semCamposDeDinheiro(original)).toEqual(esperado);
  });

  it("filhos de negócio sigiloso para a IA e o CSV (semDinheiro), em qualquer profundidade", () => {
    expect(semDinheiro({ itens: [original] })).toEqual({ itens: [esperado] });
  });
});
