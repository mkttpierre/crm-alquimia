import type { QueryClient } from "@tanstack/react-query";

import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { ApiError } from "@/lib/api/types";
import { apiClient } from "@/lib/api/client";
import {
  casaComFiltros,
  ehFila,
  filtrosAvaliaveisNoCliente,
  inserirConversa,
  removerConversa,
  type ListaDeConversas,
} from "@/lib/inbox/atualizar-lista-conversas";
import { invalidarConversasAgrupado } from "@/lib/inbox/invalidar-conversas";

/**
 * Atualiza, em TODAS as listas de conversas em cache (`["conversations", filtros, ...]`),
 * só a conversa que mudou — em vez de recarregar todas as páginas.
 *
 * Quem sabe QUAL conversa mudou (evento de Realtime da conversa, evento de
 * mensagem da conversa aberta, ação do próprio usuário) chama daqui:
 * `GET /api/v1/conversations/{id}` (mesmo SELECT da lista) e a conversa é
 * inserida, reordenada ou removida conforme os filtros de cada lista
 * (`atualizar-lista-conversas.ts`). Quem NÃO sabe (ação em lote, ação sobre
 * contato) segue invalidando `["conversations"]`.
 *
 * Fallbacks, por lista, na recarga completa agrupada: filtro que só o servidor
 * avalia (busca; `assigned_to=me` sem o id de quem olha, ver `registrarMeuId`)
 * e falha de rede na busca individual.
 */

/** Janela que junta a rajada de eventos de uma mesma conversa numa única busca. */
export const JANELA_EVENTOS_MS = 250;
/** Passou disto de conversas distintas numa janela, recarregar tudo sai mais barato. */
export const MAX_BUSCAS_POR_JANELA = 8;

interface Estado {
  meuId: string | null;
  sequencia: Map<string, number>;
  pendentes: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}
const estados = new WeakMap<QueryClient, Estado>();
function estadoDe(qc: QueryClient): Estado {
  let e = estados.get(qc);
  if (!e) {
    e = { meuId: null, sequencia: new Map(), pendentes: new Set(), timer: null };
    estados.set(qc, e);
  }
  return e;
}

/** Quem está olhando: necessário para decidir `assigned_to=me` no cliente. */
export function registrarMeuId(qc: QueryClient, meuId: string | null): void {
  if (meuId) estadoDe(qc).meuId = meuId;
}

type Chave = readonly unknown[];

/** As listas carregadas: chave `["conversations", filtros, todasAsPaginas]` com dados. */
function listasEmCache(qc: QueryClient): { chave: Chave; filtros: ConversationsFilters }[] {
  return qc
    .getQueriesData<ListaDeConversas>({ queryKey: ["conversations"] })
    .filter(([chave, data]) => data && chave.length >= 2 && typeof chave[1] === "object" && chave[1] !== null)
    .map(([chave]) => ({ chave, filtros: chave[1] as ConversationsFilters }));
}

/** Escreve na lista SEM carimbá-la como "recém-carregada" (`updatedAt` preservado). */
function escrever(qc: QueryClient, chave: Chave, f: (l: ListaDeConversas) => ListaDeConversas): void {
  const antes = qc.getQueryData<ListaDeConversas>(chave);
  if (!antes) return;
  const depois = f(antes);
  if (depois === antes) return;
  qc.setQueryData<ListaDeConversas>(chave, depois, { updatedAt: qc.getQueryState(chave)?.dataUpdatedAt });
}

export function removerConversaDasListas(qc: QueryClient, id: string): void {
  for (const { chave } of listasEmCache(qc)) escrever(qc, chave, (l) => removerConversa(l, id));
}

/**
 * Busca a conversa agora e a aplica em cada lista. Chamar DEPOIS de a mutação
 * terminar no servidor (onSuccess/onSettled), nunca antes.
 */
export async function atualizarConversaNasListas(qc: QueryClient, id: string): Promise<void> {
  const estado = estadoDe(qc);
  const listas = listasEmCache(qc);
  if (listas.length === 0) return;
  const avaliaveis = listas.filter((l) => filtrosAvaliaveisNoCliente(l.filtros, estado.meuId));
  if (avaliaveis.length < listas.length) invalidarConversasAgrupado(qc);
  if (avaliaveis.length === 0) return;

  const n = (estado.sequencia.get(id) ?? 0) + 1;
  estado.sequencia.set(id, n);
  try {
    const r = await apiClient.get<{ data: ConversationWithContact }>(`/api/v1/conversations/${id}`);
    if (estado.sequencia.get(id) !== n) return; // chegou uma busca mais nova depois
    for (const { chave, filtros } of avaliaveis) {
      const fila = ehFila(filtros);
      escrever(qc, chave, (l) =>
        casaComFiltros(r.data, filtros, estado.meuId) ? inserirConversa(l, r.data, fila) : removerConversa(l, id),
      );
    }
  } catch (err) {
    if (estado.sequencia.get(id) !== n) return;
    // 404 = a RLS tirou a conversa do escopo (ou ela foi apagada): sai das listas.
    if (err instanceof ApiError && err.status === 404) removerConversaDasListas(qc, id);
    else invalidarConversasAgrupado(qc);
  }
}

/** Para eventos (rajadas): junta numa janela curta, uma busca por conversa distinta. */
export function agendarAtualizacaoDaConversa(qc: QueryClient, id: string): void {
  const estado = estadoDe(qc);
  estado.pendentes.add(id);
  if (estado.timer) return;
  estado.timer = setTimeout(() => {
    estado.timer = null;
    const ids = [...estado.pendentes];
    estado.pendentes.clear();
    if (ids.length > MAX_BUSCAS_POR_JANELA) {
      invalidarConversasAgrupado(qc);
      return;
    }
    for (const i of ids) void atualizarConversaNasListas(qc, i);
  }, JANELA_EVENTOS_MS);
}
