import type { InfiniteData } from "@tanstack/react-query";

import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

/**
 * Atualização INCREMENTAL da lista de conversas a partir de um evento de
 * Realtime — em vez de recarregar todas as páginas a cada mudança.
 *
 * Tudo aqui é puro (sem rede, sem React), para o teste poder exercitar a
 * ordenação e o filtro sem montar tela. Os critérios espelham, linha a linha,
 * `listConversationsHandler` (app/api/v1/conversations/_handler.ts): se a rota
 * mudar a ordem ou um filtro, este arquivo muda junto.
 * O espelhamento é vigiado por tests/unit/inbox-lista-espelha-servidor.test.ts, que roda o
 * handler e estas funções sobre as mesmas conversas e exige o mesmo resultado.
 */

interface Pagina {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}
export type ListaDeConversas = InfiniteData<Pagina>;

/** Mesmo conjunto de `CONVERSATION_TERMINAL_STATUSES` (lib/schemas/messaging.ts). */
const STATUS_TERMINAIS = ["closed", "archived"];

export interface EventoDeConversa {
  id: string;
  tipo: "INSERT" | "UPDATE" | "DELETE";
}

/**
 * O que o payload do `postgres_changes` diz. `null` = não é um evento de linha
 * (o sintético `{tipo:"reassinado"}` da reconexão cai aqui) e quem chama deve
 * recarregar tudo. O id vem do payload, nunca é "confiado" como autorização: a
 * busca que ele dispara passa pela RLS e pelo `organization_id` da sessão.
 */
export function eventoDeConversa(payload: unknown): EventoDeConversa | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { eventType?: unknown; new?: { id?: unknown }; old?: { id?: unknown } };
  const tipo = p.eventType;
  if (tipo !== "INSERT" && tipo !== "UPDATE" && tipo !== "DELETE") return null;
  const id = tipo === "DELETE" ? p.old?.id : (p.new?.id ?? p.old?.id);
  return typeof id === "string" && id ? { id, tipo } : null;
}

/** A visão é a Fila? Mesma regra da rota — muda a coluna e o sentido da ordem. */
export function ehFila(filters: ConversationsFilters): boolean {
  return filters.comando?.includes("aguardando") ?? filters.assigned_to === "unassigned";
}

/**
 * O cliente consegue decidir sozinho se uma conversa casa estes filtros?
 * `search` (casa contato por nome/telefone no servidor) e `assigned_to=me` sem o
 * id de quem olha não — nesses casos o chamador recarrega a lista (agrupado).
 */
export function filtrosAvaliaveisNoCliente(
  filters: ConversationsFilters,
  meuId: string | null,
): boolean {
  if (filters.search) return false;
  if (filters.assigned_to === "me" && !meuId) return false;
  return true;
}

export function casaComFiltros(
  c: ConversationWithContact,
  filters: ConversationsFilters,
  meuId: string | null,
): boolean {
  if (filters.status) {
    const lista = typeof filters.status === "string" ? [filters.status] : filters.status;
    if (lista.length > 0 && !lista.includes(c.status as (typeof lista)[number])) return false;
  }
  if (filters.comando && filters.comando.length > 0) {
    if (!filters.comando.includes(c.comando_da_conversa as (typeof filters.comando)[number])) {
      return false;
    }
  }
  if (filters.exclude_finished && STATUS_TERMINAIS.includes(c.status)) return false;
  if (filters.channel_session_id && c.channel_session_id !== filters.channel_session_id) {
    return false;
  }
  if (filters.tag && !(c.tags ?? []).includes(filters.tag)) return false;
  if (filters.assigned_to === "me") return c.assigned_to_user_id === meuId;
  if (filters.assigned_to === "unassigned") return c.assigned_to_user_id === null;
  if (filters.assigned_to) return c.assigned_to_user_id === filters.assigned_to;
  return true;
}

/**
 * A ordem da rota: coluna desc (Fila: `last_inbound_at` asc), nulos por ÚLTIMO
 * nos dois sentidos, desempate por `id` no mesmo sentido da coluna.
 */
export function comparadorDaLista(fila: boolean) {
  const col = fila ? "last_inbound_at" : "last_message_at";
  const sinal = fila ? 1 : -1;
  return (a: ConversationWithContact, b: ConversationWithContact): number => {
    const x = a[col];
    const y = b[col];
    if (x !== y) {
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return x < y ? -sinal : sinal;
    }
    return a.id < b.id ? -sinal : a.id > b.id ? sinal : 0;
  };
}

/** Tira a conversa de todas as páginas. */
export function removerConversa(lista: ListaDeConversas, id: string): ListaDeConversas {
  if (!lista.pages.some((p) => p.data.some((c) => c.id === id))) return lista;
  return { ...lista, pages: lista.pages.map((p) => ({ ...p, data: p.data.filter((c) => c.id !== id) })) };
}

/**
 * Põe a conversa na posição certa (removendo a versão antiga, se houver).
 *
 * Com mais páginas por vir (`has_more` na última), uma conversa que cairia DEPOIS
 * de tudo o que está carregado fica de fora: o lugar dela é numa página que ainda
 * não veio, e enfiá-la no fim abriria um buraco na ordem.
 */
export function inserirConversa(
  lista: ListaDeConversas,
  nova: ConversationWithContact,
  fila: boolean,
): ListaDeConversas {
  const sem = removerConversa(lista, nova.id);
  const cmp = comparadorDaLista(fila);
  const paginas = sem.pages;
  if (paginas.length === 0) return sem;

  for (let i = 0; i < paginas.length; i++) {
    const pos = paginas[i]!.data.findIndex((c) => cmp(nova, c) < 0);
    if (pos === -1) continue;
    const data = [...paginas[i]!.data];
    data.splice(pos, 0, nova);
    return { ...sem, pages: paginas.map((p, j) => (j === i ? { ...p, data } : p)) };
  }

  const ultima = paginas[paginas.length - 1]!;
  if (ultima.meta?.has_more) return sem;
  return {
    ...sem,
    pages: paginas.map((p, j) => (j === paginas.length - 1 ? { ...p, data: [...p.data, nova] } : p)),
  };
}
