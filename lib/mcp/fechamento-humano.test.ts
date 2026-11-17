/**
 * A lista de gateways da trava do fechamento humano é recurso de produto: o agente de IA não manda link de pagamento
 * sem humano. Ela só cresce. Os casos usam caminho e primeiro rótulo SEM "checkout"/"pay", para provar que quem
 * reconhece é o domínio da lista, e não a heurística dos trechos.
 */
import { describe, expect, it } from "vitest";

import { DOMINIOS_DE_PAGAMENTO, linkDePagamento } from "./fechamento-humano";

describe("linkDePagamento: gateways públicos comuns no Brasil", () => {
  it.each([
    "https://go.hotmart.com/A1B2C3",
    "https://kiwify.app/abc123",
    "https://sun.eduzz.com/123456",
    "https://app.monetizze.com.br/r/ABC",
    "https://link.mercadopago.com.br/loja",
    "https://pagseguro.uol.com.br/v2/abc",
    "https://www.asaas.com/i/123",
    "https://api.pagar.me/1/abc",
    "https://buy.stripe.com/abc123",
    "https://ev.braip.com/ref?pl=abc",
    "https://go.perfectpay.com.br/PPU38",
    "https://ticto.app/O1234",
    "https://payfast.greenn.com.br/12345",
    "https://app.cakto.com.br/abc",
    "https://lastlink.com/p/C1234/",
    "https://seguro.yampi.com.br/r/ABC",
    "https://appmax.com.br/abc",
    "https://app.vindi.com.br/abc",
    "https://sejaefi.efipay.com.br/abc",
    "https://abacatepay.com/abc",
    "https://loja.digitalmanager.guru/abc",
    "https://ebanx.com/abc",
  ])("reconhece %s", (url) => {
    expect(linkDePagamento(url)).toBe(true);
  });

  it("link comum continua livre", () => {
    expect(linkDePagamento("https://exemplo.com/produto")).toBe(false);
    expect(linkDePagamento("https://youtube.com/watch?v=abc")).toBe(false);
  });

  it("a lista não tem repetido", () => {
    expect(new Set(DOMINIOS_DE_PAGAMENTO).size).toBe(DOMINIOS_DE_PAGAMENTO.length);
  });
});
