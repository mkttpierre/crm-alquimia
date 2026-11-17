// Regras extras de leitura achadas na medição do Jev.
// Cada frase abaixo veio do corpus rotulado; a regra dura não depende do Jev.
import { describe, expect, it } from "vitest";

import { dizPessoaErrada, lerMensagem, pedeSaidaDaLista } from "./leitura";

describe("regras extras de leitura (medidas contra o corpus do Jev)", () => {
  it("'não vou querer' é recusa, não fechamento", () => {
    for (const t of ["Não vou querer", "não vou querer, grato", "não vou querer obrigado"]) {
      expect(lerMensagem(t).intencao, t).toBe("nao_quer_mais");
    }
    expect(lerMensagem("vou querer o de 6 meses").intencao).toBe("escolheu_kit");
    expect(lerMensagem("quero comprar").intencao).toBe("quer_fechar");
  });

  it("'não vou querer, tá caro' continua sendo objeção de preço", () => {
    expect(lerMensagem("não vou querer, tá caro").intencao).toBe("objecao_preco");
  });

  it("'pode mandar' sozinho é aceite de explicação, não pedido de link", () => {
    expect(lerMensagem("claro, pode mandar").intencao).not.toBe("quer_fechar");
    expect(lerMensagem("pode mandar o link").intencao).toBe("quer_fechar");
    expect(lerMensagem("pode mandar o pix").intencao).toBe("quer_fechar");
  });

  it("'quem passou meu número' é parada, sem Jev", () => {
    expect(pedeSaidaDaLista("quem passou meu número??")).toBe(true);
    expect(pedeSaidaDaLista("onde você pegou meu telefone")).toBe(true);
    expect(pedeSaidaDaLista("qual o telefone de vocês?")).toBe(false);
    expect(lerMensagem("quem passou meu número??").intencao).toBe("parada");
  });

  it("'pessoa errada' é número errado, sem Jev", () => {
    expect(dizPessoaErrada("você mandou pra pessoa errada")).toBe(true);
    expect(dizPessoaErrada("essa pessoa não trabalha aqui")).toBe(true);
    expect(dizPessoaErrada("a pessoa certa sou eu")).toBe(false);
    expect(lerMensagem("você mandou pra pessoa errada").intencao).toBe("numero_errado");
  });

  it("'fecho por 400' é pedido de desconto (D5)", () => {
    expect(lerMensagem("fecho por 400 agora").intencao).toBe("pede_desconto");
    expect(lerMensagem("fecho agora, manda o pix").intencao).not.toBe("pede_desconto");
  });
});
