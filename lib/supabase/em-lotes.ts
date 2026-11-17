/**
 * Leitura em lotes e em páginas para o PostgREST.
 *
 * Dois limites do PostgREST que derrubavam o funil (GET /pipelines/:id/board):
 *
 * 1. `.in("coluna", ids)` vira `?coluna=in.(id1,id2,…)` na URL. Com uns 2 mil leads
 *    numa organização a URL passava de 75 KB e o servidor devolvia 500 "URI too long". Lote
 *    de 100 UUIDs dá ~3,7 KB, longe de qualquer limite de proxy.
 * 2. `max_rows` (supabase/config.toml) corta toda resposta em 1.000 linhas EM
 *    SILÊNCIO — sem erro, só menos dados. Ler acima disso exige `.range()` em
 *    laço até vir uma página incompleta.
 *
 * A consulta recebe `(de, ate)` e DEVE aplicar `.range(de, ate)` e uma ordem
 * total (com desempate por `id`); sem ordem estável, páginas podem repetir ou
 * pular linhas.
 */

/** Tamanho da página: igual ao `max_rows` padrão do Supabase. */
export const TAMANHO_PAGINA = 1000;
/** Ids por chamada no `.in(...)`. */
export const TAMANHO_LOTE = 100;
/** Lotes em voo ao mesmo tempo — não inundar o banco com 20 consultas paralelas. */
const LOTES_EM_PARALELO = 4;

interface RespostaPostgrest<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export function fatiar<T>(itens: readonly T[], tamanho: number): T[][] {
  const pedacos: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) pedacos.push(itens.slice(i, i + tamanho));
  return pedacos;
}

export async function buscarTodasAsPaginas<T>(
  consulta: (de: number, ate: number) => PromiseLike<RespostaPostgrest<T>>,
  tamanhoPagina = TAMANHO_PAGINA,
): Promise<{ data: T[]; error: string | null }> {
  const todas: T[] = [];
  for (let de = 0; ; de += tamanhoPagina) {
    const { data, error } = await consulta(de, de + tamanhoPagina - 1);
    if (error) return { data: [], error: error.message };
    const pagina = data ?? [];
    todas.push(...pagina);
    if (pagina.length < tamanhoPagina) return { data: todas, error: null };
  }
}

export async function buscarEmLotes<T, Id = string>(
  ids: readonly Id[],
  consulta: (lote: Id[], de: number, ate: number) => PromiseLike<RespostaPostgrest<T>>,
  tamanhoLote = TAMANHO_LOTE,
): Promise<{ data: T[]; error: string | null }> {
  const lotes = fatiar(ids, tamanhoLote);
  const resultados: T[][] = new Array(lotes.length);
  for (let i = 0; i < lotes.length; i += LOTES_EM_PARALELO) {
    const rodada = await Promise.all(
      lotes
        .slice(i, i + LOTES_EM_PARALELO)
        .map((lote) => buscarTodasAsPaginas<T>((de, ate) => consulta(lote, de, ate))),
    );
    for (let j = 0; j < rodada.length; j++) {
      const r = rodada[j]!;
      if (r.error) return { data: [], error: r.error };
      resultados[i + j] = r.data;
    }
  }
  // Ordem dos lotes preservada: quem chama pode contar com "primeiro visto vence"
  // dentro de cada chave, desde que a chave não atravesse lotes.
  return { data: resultados.flat(), error: null };
}
