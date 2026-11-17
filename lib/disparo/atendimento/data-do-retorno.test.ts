import { describe, expect, it } from "vitest";
import { dataDoRetorno } from "./data-do-retorno";
import { compraComData } from "./venda";

describe("data prometida em São Paulo, às 9h", () => {
  const agora = new Date("2026-10-28T18:00:00Z"); // quarta, 15h
  it.each([
    ["recebo dia 5", "2026-11-05T12:00:00.000Z"],
    ["no dia 30 eu pego", "2026-10-30T12:00:00.000Z"],
    ["dia 10 eu pego", "2026-11-10T12:00:00.000Z"],
    ["5 do mês que vem", "2026-11-05T12:00:00.000Z"],
    ["dia 30 do próximo mês", "2026-11-30T12:00:00.000Z"],
    ["sexta", "2026-10-30T12:00:00.000Z"],
    ["sexta que vem", "2026-10-30T12:00:00.000Z"],
    ["sexta da semana que vem", "2026-11-06T12:00:00.000Z"],
    ["segunda-feira", "2026-11-02T12:00:00.000Z"],
    ["domingo", "2026-11-01T12:00:00.000Z"],
    ["semana que vem", "2026-11-04T12:00:00.000Z"],
    ["mês que vem", "2026-11-05T12:00:00.000Z"],
    ["depois do pagamento dia 6", "2026-11-06T12:00:00.000Z"],
    ["depois do dia 15", "2026-11-15T12:00:00.000Z"],
    ["amanhã", "2026-10-29T12:00:00.000Z"],
    ["depois de amanhã", "2026-10-30T12:00:00.000Z"],
    ["não tenho dinheiro", null], ["quando puder eu chamo", null],
    ["dia 0", null], ["dia 32", null], ["tenho 5 reais", null],
  ])("%s → %s", (texto, esperado) => {
    expect(dataDoRetorno(texto, agora)?.toISOString() ?? null).toBe(esperado);
    expect(agora.toISOString()).toBe("2026-10-28T18:00:00.000Z");
  });
  it.each([
    ["dia 5", "2026-12-31T18:00:00Z", "2027-01-05T12:00:00.000Z"],
    ["mês que vem", "2026-12-10T18:00:00Z", "2027-01-05T12:00:00.000Z"],
    ["amanhã", "2026-12-31T18:00:00Z", "2027-01-01T12:00:00.000Z"],
    ["depois de amanhã", "2026-01-31T18:00:00Z", "2026-02-02T12:00:00.000Z"],
    ["amanhã", "2026-11-01T01:00:00Z", "2026-11-01T12:00:00.000Z"], // ainda sábado em SP
    ["amanhã", "2028-02-28T18:00:00Z", "2028-02-29T12:00:00.000Z"],
    ["dia 31", "2026-02-01T18:00:00Z", null],
    ["domingo", "2026-11-01T18:00:00Z", "2026-11-08T12:00:00.000Z"],
  ])("%s a partir de %s", (texto, base, esperado) => {
    expect(dataDoRetorno(texto, new Date(base))?.toISOString() ?? null).toBe(esperado);
  });
});

describe("compro dia X: verbo de compra mais data", () => {
  const agora = new Date("2026-10-28T18:00:00Z"); // quarta, 15h
  it.each([
    ["vou comprar dia 20", "2026-11-20T12:00:00.000Z"],
    ["Compro sexta", "2026-10-30T12:00:00.000Z"],
    ["fecho dia 10", "2026-11-10T12:00:00.000Z"],
    ["faço o pedido amanhã", "2026-10-29T12:00:00.000Z"],
    ["pego dia 5", "2026-11-05T12:00:00.000Z"],
    ["pago mês que vem", "2026-11-05T12:00:00.000Z"],
  ])("%s → %s", (texto, esperado) => {
    expect(compraComData(texto, agora)?.toISOString() ?? null).toBe(esperado);
  });
  it.each(["vou comprar", "dia 20", "já paguei", "comprei dia 10", "vou trabalhar sexta", "não compro nada"])("'%s' não é compra com data", (texto) => {
    expect(compraComData(texto, agora)).toBeNull();
  });
});
