import { describe, expect, it } from "vitest";

import { buscarEmLotes, buscarTodasAsPaginas, fatiar } from "@/lib/supabase/em-lotes";

/**
 * O funil (GET /pipelines/:id/board) caía com 500 "URI too long": mandava os
 * 2.100 ids de uma organização num único `.in(...)` e a URL passava de 75 KB. E mesmo sem o
 * 500, o PostgREST corta em 1.000 linhas (`max_rows`), e metade dos leads sumia.
 * Estes testes simulam os dois limites: lote com URL grande demais reprova, e
 * resposta acima de 1.000 linhas é truncada em silêncio, como no PostgREST real.
 */
const MAX_ROWS = 1000;

function postgrestFalso<T>(linhas: T[]) {
  return (de: number, ate: number) =>
    Promise.resolve({ data: linhas.slice(de, Math.min(ate + 1, de + MAX_ROWS)), error: null });
}

describe("fatiar", () => {
  it("divide em pedaços do tamanho pedido, sem perder nem repetir", () => {
    expect(fatiar([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(fatiar([], 2)).toEqual([]);
  });
});

describe("buscarTodasAsPaginas", () => {
  it("traz as 2.100 linhas, mesmo com o servidor cortando em 1.000", async () => {
    const linhas = Array.from({ length: 2100 }, (_, i) => i);
    const { data, error } = await buscarTodasAsPaginas(postgrestFalso(linhas));
    expect(error).toBeNull();
    expect(data).toEqual(linhas);
  });

  it("devolve o erro da página que falhou", async () => {
    const { data, error } = await buscarTodasAsPaginas(() =>
      Promise.resolve({ data: null, error: { message: "boom" } }),
    );
    expect(error).toBe("boom");
    expect(data).toEqual([]);
  });
});

describe("buscarEmLotes", () => {
  it("nunca manda mais ids por chamada do que o lote e junta todos os resultados", async () => {
    const ids = Array.from({ length: 2100 }, (_, i) => `id-${i}`);
    const maiorLote: number[] = [];
    const { data, error } = await buscarEmLotes(ids, (lote, de, ate) => {
      maiorLote.push(lote.length);
      if (lote.length > 150) {
        return Promise.resolve({ data: null, error: { message: "URI too long\n" } });
      }
      return postgrestFalso(lote.map((id) => ({ id })))(de, ate);
    });
    expect(error).toBeNull();
    expect(Math.max(...maiorLote)).toBeLessThanOrEqual(150);
    expect(data.map((r) => r.id)).toEqual(ids);
  });

  it("pagina dentro do lote quando um lote passa de 1.000 linhas", async () => {
    // 1 contato com 1.500 conversas: o lote é pequeno, a resposta não.
    const { data } = await buscarEmLotes(["c1"], (_lote, de, ate) =>
      postgrestFalso(Array.from({ length: 1500 }, (_, i) => i))(de, ate),
    );
    expect(data).toHaveLength(1500);
  });

  it("lista vazia não chama o banco", async () => {
    let chamadas = 0;
    const { data } = await buscarEmLotes([], () => {
      chamadas++;
      return Promise.resolve({ data: [], error: null });
    });
    expect(chamadas).toBe(0);
    expect(data).toEqual([]);
  });

  it("propaga o primeiro erro", async () => {
    const { error } = await buscarEmLotes(["a"], () =>
      Promise.resolve({ data: null, error: { message: "permission denied" } }),
    );
    expect(error).toBe("permission denied");
  });
});
