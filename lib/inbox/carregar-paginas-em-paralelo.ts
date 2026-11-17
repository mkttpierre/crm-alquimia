/**
 * CARGA COMPLETA DA LISTA EM PARALELO — páginas por deslocamento, em ondas.
 *
 * A carga completa do inbox (abas do multiatendimento) seguia o cursor: cada
 * página só podia ser pedida depois de a anterior voltar. Com ~800 conversas
 * eram 8 voltas inteiras de rede e banco antes de a lista aparecer.
 *
 * Aqui as páginas são pedidas por `offset`, em ondas de `simultaneas` pedidos
 * ao mesmo tempo (Promise.all). A primeira página da onda que disser
 * `has_more: false` encerra a carga; as seguintes da mesma onda vêm vazias e
 * são descartadas.
 *
 * Deslocamento não é cursor: se uma conversa sobe para o topo no meio da carga,
 * as linhas escorregam uma posição e a mesma conversa pode vir em duas páginas.
 * Por isso o resultado é deduplicado por `id` (fica a primeira ocorrência). A
 * conversa que sobe DEPOIS de a página dela ter sido lida fica de fora até o
 * evento do Realtime chegar — o mesmo buraco que a carga pelo cursor já tinha.
 */

export interface PaginaDaLista<T> {
  data: T[];
  meta?: { has_more?: boolean };
}

export interface OpcoesDaCarga {
  /** Itens por página (o `limit` pedido ao servidor). */
  tamanho: number;
  /** Teto de pedidos em voo ao mesmo tempo. */
  simultaneas: number;
  /** Teto de páginas: servidor que nunca diz "acabou" não prende a tela. */
  tetoDePaginas?: number;
}

export async function carregarPaginasEmParalelo<T extends { id: string }>(
  buscar: (offset: number) => Promise<PaginaDaLista<T>>,
  { tamanho, simultaneas, tetoDePaginas = 200 }: OpcoesDaCarga,
): Promise<T[]> {
  const vistos = new Set<string>();
  const itens: T[] = [];
  for (let pagina = 0; pagina < tetoDePaginas; pagina += simultaneas) {
    const naOnda = Math.min(simultaneas, tetoDePaginas - pagina);
    const onda = await Promise.all(
      Array.from({ length: naOnda }, (_, i) => buscar((pagina + i) * tamanho)),
    );
    for (const resposta of onda) {
      for (const item of resposta.data) {
        if (vistos.has(item.id)) continue;
        vistos.add(item.id);
        itens.push(item);
      }
      if (!resposta.meta?.has_more) return itens;
    }
  }
  throw new Error("Lista de conversas maior que o teto de páginas da carga completa");
}
