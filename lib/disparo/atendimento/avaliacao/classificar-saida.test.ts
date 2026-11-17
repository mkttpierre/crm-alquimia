import { describe, it, expect } from "vitest";
import { classificarSaida } from "./classificar-saida";

describe("classificar saída", () => {
  it("reconhece explicação junto com tabela e não confunde follow-up com resposta", () => {
    expect(classificarSaida({ tipos: ["pitch:seq", "tabela:seq", "followup_kit"], explicacao: "pitch", tabela: "tabela" })).toBe("explicacao_e_valores");
    expect(classificarSaida({ tipos: ["followup_kit"] })).toBe("nada");
  });
  it("prioriza parada e retorno sobre texto", () => {
    expect(classificarSaida({ tipos: ["tabela"], etapa: "nao_contatar" })).toBe("encerrar");
    expect(classificarSaida({ tipos: ["obj_preco"], retornoEm: "2026-11-01T00:00:00Z" })).toBe("retorno_data");
  });
  it("distingue transferência de venda e objeção", () => {
    expect(classificarSaida({ tipos: [], avisos: ["compra"] })).toBe("operador_venda");
    expect(classificarSaida({ tipos: [], precisaOperador: true })).toBe("operador");
    expect(classificarSaida({ tipos: ["obj_preco:seq"], objecoes: ["obj_preco"] })).toBe("objecao_modelo");
  });
});

it("classifica negociação sem escolha como operador", () => {
  expect(classificarSaida({ tipos: [], precisaOperador: true, parada: true, motivo: "pediu desconto" })).toBe("operador");
});

it("considera silêncio e encaminhamento equivalentes nos dois sentidos", async () => {
  const { acoesEquivalentes } = await import("./classificar-saida");
  expect(acoesEquivalentes("nada", "operador")).toBe(true);
  expect(acoesEquivalentes("operador", "nada")).toBe(true);
  expect(acoesEquivalentes("operador_venda", "nada")).toBe(false);
});
