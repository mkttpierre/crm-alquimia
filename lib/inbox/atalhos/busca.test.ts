import { describe, expect, it } from "vitest";

import { buscarAtalhos, normalizarBusca } from "./busca";
import type { ItemDeAtalho } from "./tipos";

const item = (p: Partial<ItemDeAtalho> & Pick<ItemDeAtalho, "id" | "tipo" | "nome">): ItemDeAtalho => ({
  atalho: null,
  palavrasChave: [],
  favorito: false,
  resumo: "",
  ...p,
});

const itens: ItemDeAtalho[] = [
  item({ id: "f1", tipo: "funil", nome: "Funil de valores", atalho: "funil-valores" }),
  item({ id: "m1", tipo: "mensagem", nome: "Tabela", palavrasChave: ["preço"] }),
  item({ id: "a1", tipo: "audio", nome: "Áudio valores" }),
  item({ id: "a2", tipo: "audio", nome: "Áudio valores favorito", favorito: true }),
  item({ id: "d1", tipo: "documento", nome: "Contrato" }),
];

describe("normalizarBusca", () => {
  it("tira acento, maiúscula, espaço e a barra inicial", () => {
    expect(normalizarBusca("  /Valôres ")).toBe("valores");
  });
});

describe("buscarAtalhos", () => {
  it("acha o funil pelo nome com acento e maiúscula diferentes", () => {
    expect(buscarAtalhos(itens, "Valôres").map((i) => i.id)).toContain("f1");
  });

  it("com barra no começo dá o mesmo resultado", () => {
    expect(buscarAtalhos(itens, "/valores")).toEqual(buscarAtalhos(itens, "valores"));
  });

  it("acha pela palavra-chave sem acento", () => {
    expect(buscarAtalhos(itens, "preco").map((i) => i.id)).toEqual(["m1"]);
  });

  it("favorito vem antes, depois a ordem de tipo (funil primeiro)", () => {
    expect(buscarAtalhos(itens, "valores").map((i) => i.id)).toEqual(["a2", "f1", "a1"]);
  });

  it("o filtro de tipo deixa só aquele tipo", () => {
    expect(buscarAtalhos(itens, "valores", ["audio"]).map((i) => i.id)).toEqual(["a2", "a1"]);
  });

  it("texto em branco não lista nada", () => {
    expect(buscarAtalhos(itens, "   ")).toEqual([]);
  });

  it("acha pelo atalho", () => {
    expect(buscarAtalhos(itens, "funil-val").map((i) => i.id)).toEqual(["f1"]);
  });
});
