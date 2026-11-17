import { describe, expect, it } from "vitest";

import { carregarPaginasEmParalelo } from "./carregar-paginas-em-paralelo";

const itens = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));

function servidor(lista: { id: string }[], tamanho: number) {
  const offsets: number[] = [];
  const buscar = async (offset: number) => {
    offsets.push(offset);
    return { data: lista.slice(offset, offset + tamanho), meta: { has_more: offset + tamanho < lista.length } };
  };
  return { buscar, offsets };
}

describe("carregarPaginasEmParalelo", () => {
  it("pede em ondas de N por deslocamento e para na primeira página sem has_more", async () => {
    const s = servidor(itens(250), 100);
    const r = await carregarPaginasEmParalelo(s.buscar, { tamanho: 100, simultaneas: 4 });
    expect(r.map((i) => i.id)).toEqual(itens(250).map((i) => i.id));
    expect(s.offsets).toEqual([0, 100, 200, 300]);
  });

  it("segue para a onda seguinte quando a onda inteira ainda tem mais", async () => {
    const s = servidor(itens(450), 100);
    const r = await carregarPaginasEmParalelo(s.buscar, { tamanho: 100, simultaneas: 4 });
    expect(r).toHaveLength(450);
    expect(s.offsets).toEqual([0, 100, 200, 300, 400, 500, 600, 700]);
  });

  it("lista vazia: uma onda, nenhum item", async () => {
    const s = servidor([], 100);
    expect(await carregarPaginasEmParalelo(s.buscar, { tamanho: 100, simultaneas: 4 })).toEqual([]);
  });

  it("conversa que escorrega entre páginas no meio da carga não aparece duas vezes", async () => {
    // A página 2 é lida depois de uma conversa nova entrar no topo: tudo desce
    // uma posição, e o último item da página 1 reaparece no começo da página 2.
    const antes = itens(6);
    const depois = [{ id: "nova" }, ...antes];
    const buscar = async (offset: number) => {
      const lista = offset === 0 ? antes : depois;
      return { data: lista.slice(offset, offset + 3), meta: { has_more: offset + 3 < lista.length } };
    };
    const r = await carregarPaginasEmParalelo(buscar, { tamanho: 3, simultaneas: 4 });
    expect(r.map((i) => i.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
  });

  it("servidor que nunca diz 'acabou' esbarra no teto de páginas", async () => {
    const buscar = async () => ({ data: [], meta: { has_more: true } });
    await expect(
      carregarPaginasEmParalelo(buscar, { tamanho: 100, simultaneas: 4, tetoDePaginas: 8 }),
    ).rejects.toThrow(/teto de páginas/);
  });
});
