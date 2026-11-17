/**
 * O cache do quadro paginado, do lado do cliente.
 *
 * Três perguntas que a paginação abriu e que não existiam com o funil inteiro
 * na memória:
 *  - soltar um card no FIM de uma coluna parcial: o vizinho de baixo é o
 *    primeiro lead não carregado, não "ninguém" (senão o card cai no meio dos
 *    ocultos, e reaparece em outro lugar no refetch);
 *  - "Mostrar mais" junta a página sem duplicar card (chave repetida quebra o
 *    arrastar) e atualiza o total;
 *  - o movimento otimista acerta os contadores das duas colunas.
 */
import { describe, expect, it } from "vitest";

import { midpoint } from "@/lib/kanban/fractional-indexing";
import {
  MAX_POR_ETAPA,
  mesclarPaginaDaEtapa,
  moverNoCache,
  urlDaPagina,
  urlDoBoard,
  vizinhosAoSoltar,
} from "@/lib/kanban/board-pagina";
import type { BoardData } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

const lead = (id: string, stage_id: string, pos: number, value_cents = 0) =>
  ({ id, stage_id, position_in_stage: pos, value_cents }) as unknown as Lead;

function board(): BoardData {
  return {
    pipeline: {} as BoardData["pipeline"],
    stages: [],
    leads: [lead("a1", "A", 1000, 10), lead("a2", "A", 2000, 10), lead("b1", "B", 1000)],
    stage_pages: {
      A: { total: 5, value_cents: 50, next_position: 3000 },
      B: { total: 1, value_cents: 0, next_position: null },
    },
  };
}

describe("soltar no fim de uma lista parcial", () => {
  it("usa a posição do primeiro lead não carregado como vizinho de baixo", () => {
    const visiveis = [lead("a1", "A", 1000), lead("a2", "A", 2000)];
    const { antes, depois } = vizinhosAoSoltar(visiveis, 2, 3000);
    expect({ antes, depois }).toEqual({ antes: 2000, depois: 3000 });
    // fica ENTRE o último visível e o primeiro oculto — não em 3000 (empate) nem depois.
    expect(midpoint(antes, depois)).toBe(2500);
  });

  it("lista completa (sem próxima) continua indo para o fim", () => {
    const { antes, depois } = vizinhosAoSoltar([lead("b1", "B", 1000)], 1, null);
    expect(midpoint(antes, depois)).toBe(2000);
  });

  it("no meio da lista, os vizinhos são os visíveis", () => {
    const visiveis = [lead("a1", "A", 1000), lead("a2", "A", 2000)];
    expect(vizinhosAoSoltar(visiveis, 1, 3000)).toEqual({ antes: 1000, depois: 2000 });
    expect(vizinhosAoSoltar(visiveis, 0, 3000)).toEqual({ antes: null, depois: 1000 });
  });
});

describe("Mostrar mais: juntar a página no cache", () => {
  it("acrescenta os leads, atualiza total e próxima posição, sem duplicar", () => {
    const novo = mesclarPaginaDaEtapa(board(), {
      stage_id: "A",
      offset: 2,
      leads: [lead("a2", "A", 2000), lead("a3", "A", 3000), lead("a4", "A", 4000)],
      total: 6,
      value_cents: 60,
      next_position: 5000,
    });
    expect(novo.leads.map((l) => l.id)).toEqual(["a1", "a2", "b1", "a3", "a4"]);
    expect(novo.stage_pages!.A).toEqual({ total: 6, value_cents: 50, next_position: 5000 });
    expect(novo.stage_pages!.B).toEqual(board().stage_pages!.B);
  });
});

describe("movimento otimista", () => {
  it("troca a etapa do card e acerta total e valor das duas colunas", () => {
    const novo = moverNoCache(board(), "a1", "B", 500);
    expect(novo.leads.find((l) => l.id === "a1")).toMatchObject({ stage_id: "B", position_in_stage: 500 });
    expect(novo.stage_pages!.A).toMatchObject({ total: 4, value_cents: 40 });
    expect(novo.stage_pages!.B).toMatchObject({ total: 2, value_cents: 10 });
  });

  it("reordenar na mesma etapa não mexe nos totais", () => {
    const novo = moverNoCache(board(), "a1", "A", 2500);
    expect(novo.stage_pages).toEqual(board().stage_pages);
  });
});

describe("URLs", () => {
  it("refetch leva os filtros e só as etapas com mais que a página padrão abertas", () => {
    const url = urlDoBoard("p1", "tag=vip", new Map([["A", 120], ["B", 50], ["C", 9999]]), "L1");
    const u = new URL(url, "http://x");
    expect(u.pathname).toBe("/api/v1/pipelines/p1/board");
    expect(u.searchParams.get("tag")).toBe("vip");
    expect(u.searchParams.get("limites")).toBe(`A:120,C:${MAX_POR_ETAPA}`);
    expect(u.searchParams.get("lead")).toBe("L1");
  });

  it("primeira carga sem nada aberto não leva parâmetro nenhum", () => {
    expect(urlDoBoard("p1", "", new Map(), null)).toBe("/api/v1/pipelines/p1/board");
  });

  it("página seguinte leva etapa, offset e os mesmos filtros", () => {
    const u = new URL(urlDaPagina("p1", "q=ana&owner=unassigned", "A", 50), "http://x");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q: "ana",
      owner: "unassigned",
      stage_id: "A",
      offset: "50",
    });
  });
});
