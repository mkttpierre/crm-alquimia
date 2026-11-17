import { describe, expect, it } from "vitest";

import { produtosParaSeletor, type ProdutoDoSeletor } from "./seletor-produtos";

const p = (extra: Partial<ProdutoDoSeletor> & { id: string; nome: string }): ProdutoDoSeletor => ({
  codigo: extra.id,
  marca: null,
  preco_cents: 1000,
  moeda: "BRL",
  ativo: true,
  so_interno: false,
  ...extra,
});

const LOJA = p({ id: "l1", nome: "Perfume Árabe", marca: "Loja" });
const R1 = p({ id: "r1", nome: "1 MÊS (BETA)", marca: "Marca Beta", so_interno: true, preco_cents: 12000 });
const R12 = p({ id: "r12", nome: "12 MESES (BETA)", marca: "Marca Beta", so_interno: true, preco_cents: 49371 });
const R3 = p({ id: "r3", nome: "3 MESES (BETA)", marca: "Marca Beta", so_interno: true });
const G1 = p({ id: "g1", nome: "1 MÊS (ALFA)", marca: "Marca Alfa", so_interno: true });
const SEM_MARCA = p({ id: "s1", nome: "Brinde", so_interno: true, marca: null });

describe("produtosParaSeletor", () => {
  it("com produto interno ativo, mostra SÓ os internos (o catálogo da loja some)", () => {
    const r = produtosParaSeletor([LOJA, R1, G1], "", "BRL");
    expect(r.modo).toBe("internos");
    expect(r.grupos.flatMap((g) => g.produtos.map((x) => x.id)).sort()).toEqual(["g1", "r1"]);
  });

  it("sem produto interno ativo, mostra o catálogo como hoje, sem agrupar por marca", () => {
    const r = produtosParaSeletor([LOJA, p({ id: "l2", nome: "Outro", marca: "Outra" })], "", "BRL");
    expect(r.modo).toBe("catalogo");
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0]!.marca).toBeNull();
    expect(r.grupos[0]!.produtos).toHaveLength(2);
  });

  it("interno INATIVO não conta: a organização volta ao catálogo", () => {
    const r = produtosParaSeletor([LOJA, { ...R1, ativo: false }], "", "BRL");
    expect(r.modo).toBe("catalogo");
    expect(r.grupos[0]!.produtos.map((x) => x.id)).toEqual(["l1"]);
  });

  it("agrupa por marca (ordem alfabética, sem marca por último) e ordena os planos pelo número no nome", () => {
    const r = produtosParaSeletor([R12, SEM_MARCA, R3, G1, R1], "", "BRL");
    expect(r.grupos.map((g) => g.marca)).toEqual(["Marca Alfa", "Marca Beta", null]);
    expect(r.grupos[1]!.produtos.map((x) => x.id)).toEqual(["r1", "r3", "r12"]);
  });

  it("busca sem acento e sem caixa, em nome, código e marca; todas as palavras têm de casar", () => {
    const todos = [R1, R3, R12, G1];
    expect(produtosParaSeletor(todos, "mes beta", "BRL").grupos.flatMap((g) => g.produtos).length).toBe(3);
    expect(produtosParaSeletor(todos, "1 mes alfa", "BRL").grupos.flatMap((g) => g.produtos.map((x) => x.id))).toEqual(["g1"]);
    expect(produtosParaSeletor(todos, "ALFA", "BRL").grupos.flatMap((g) => g.produtos.map((x) => x.id))).toEqual(["g1"]);
    expect(produtosParaSeletor(todos, "inexistente", "BRL").grupos).toEqual([]);
  });

  it("só produtos na moeda do negócio", () => {
    const r = produtosParaSeletor([R1, { ...G1, moeda: "USD" }], "", "BRL");
    expect(r.grupos.flatMap((g) => g.produtos.map((x) => x.id))).toEqual(["r1"]);
  });

  it("a busca não faz o modo mudar: buscar por algo da loja não traz o catálogo público", () => {
    const r = produtosParaSeletor([LOJA, R1], "perfume", "BRL");
    expect(r.modo).toBe("internos");
    expect(r.grupos).toEqual([]);
  });
});
