/**
 * Paginação do quadro por etapa — a parte pura (sem rede, sem React).
 *
 * O quadro de uma organização com milhares de leads baixava TODOS num JSON de alguns MB para
 * mostrar 50 por coluna. Agora a rota devolve, por etapa, só os primeiros N (na
 * ordem da coluna: `position_in_stage`, desempate por `id`) mais o total real da
 * etapa; "Mostrar mais" pede a página seguinte daquela etapa.
 *
 * Os filtros da tela (responsável, status, tag, busca, atrasados) passam a valer
 * NO SERVIDOR: com página parcial, filtrar no cliente esconderia os leads que
 * casam e ainda não vieram, e o contador mentiria.
 */
import { z } from "zod";

import { filtersFromParams, parseAgentOwnerFilter, type LeadFilters } from "@/lib/kanban/filters";
import type { BoardData, StagePage, StagePageData } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

/** Cards por etapa na primeira carga e em cada "Mostrar mais". */
export const POR_ETAPA_PADRAO = 50;
/**
 * Teto por etapa num pedido. Pedimos `limite + 1` linhas (a extra diz onde a
 * próxima página começa) e o PostgREST corta em 1.000 (`max_rows`) em silêncio;
 * 500 fica longe disso e ainda limita o tamanho do refetch de quem abriu muito.
 */
export const MAX_POR_ETAPA = 500;

const uuid = z.string().uuid();

export interface PedidoDoBoard {
  filtros: LeadFilters;
  porEtapa: number;
  /** Quantos cards cada etapa já tem aberta na tela (refetch mantém as páginas extras). */
  limites: Map<string, number>;
  /** Presente = pedido da página seguinte de UMA etapa. */
  etapa: { id: string; offset: number } | null;
  leadEmFoco: string | null;
}

type Resultado = { ok: true; pedido: PedidoDoBoard } | { ok: false; erro: string };

function inteiro(valor: string | null, min: number, max: number): number | null | undefined {
  if (valor === null || valor === "") return undefined;
  if (!/^\d+$/.test(valor)) return null;
  const n = Number(valor);
  return n >= min && n <= max ? n : null;
}

/** Lê e valida a query string do board. Erro = 400, nunca consulta com lixo. */
export function lerPedidoDoBoard(sp: URLSearchParams): Resultado {
  const porEtapa = inteiro(sp.get("por_etapa"), 1, MAX_POR_ETAPA);
  if (porEtapa === null) return { ok: false, erro: `por_etapa deve ser inteiro de 1 a ${MAX_POR_ETAPA}.` };

  const limites = new Map<string, number>();
  const rawLimites = sp.get("limites");
  if (rawLimites) {
    for (const par of rawLimites.split(",")) {
      const [id, n] = par.split(":");
      const lim = inteiro(n ?? null, 1, MAX_POR_ETAPA);
      if (!id || !uuid.safeParse(id).success || typeof lim !== "number") {
        return { ok: false, erro: "limites deve ser uma lista etapa:quantidade." };
      }
      limites.set(id, lim);
    }
  }

  let etapa: PedidoDoBoard["etapa"] = null;
  const stageId = sp.get("stage_id");
  if (stageId !== null) {
    if (!uuid.safeParse(stageId).success) return { ok: false, erro: "stage_id inválido." };
    const offset = inteiro(sp.get("offset"), 0, 1_000_000);
    if (offset === null) return { ok: false, erro: "offset deve ser inteiro >= 0." };
    etapa = { id: stageId, offset: offset ?? 0 };
  }

  const leadEmFoco = sp.get("lead");
  if (leadEmFoco !== null && !uuid.safeParse(leadEmFoco).success) {
    return { ok: false, erro: "lead inválido." };
  }

  const filtros = filtersFromParams(sp);
  const owner = filtros.owner;
  if (owner && owner !== "any" && owner !== "unassigned") {
    const agente = parseAgentOwnerFilter(owner);
    if (!uuid.safeParse(agente ?? owner).success) return { ok: false, erro: "owner inválido." };
  }
  if ((filtros.tag?.length ?? 0) > 200 || (filtros.search?.length ?? 0) > 200) {
    return { ok: false, erro: "Filtro longo demais." };
  }

  return {
    ok: true,
    pedido: { filtros, porEtapa: porEtapa ?? POR_ETAPA_PADRAO, limites, etapa, leadEmFoco },
  };
}

/**
 * O `or=` da busca, no formato do PostgREST: título OU descrição contém o termo,
 * sem diferenciar maiúsculas (o mesmo que o `applyFilters` do cliente fazia).
 *
 * Duas camadas de escape, nesta ordem:
 *  1. LIKE: `%`, `_` e `\` do usuário são literais (buscar "100%" não pode virar
 *     curinga). `*` vira `_`: o PostgREST troca todo `*` por `%` e não há como
 *     escapá-lo — `_` casa o próprio `*` e erra só para mais, nunca esconde lead.
 *  2. PostgREST: o valor vai entre aspas (vírgula e parênteses do termo não
 *     quebram a árvore do `or`), com `\` e `"` escapados.
 */
export function filtroDeBusca(termo: string | undefined): string | null {
  const t = termo?.trim();
  if (!t) return null;
  const like = t.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "_");
  const valor = `"*${like.replace(/[\\"]/g, (c) => `\\${c}`)}*"`;
  return `title.ilike.${valor},description.ilike.${valor}`;
}

/** Literal de array do Postgres com UM elemento, entre aspas (tag com vírgula não quebra). */
export function literalDeTag(tag: string): string {
  return `{"${tag.replace(/[\\"]/g, (c) => `\\${c}`)}"}`;
}

/** O pedaço do builder do PostgREST que os filtros usam. */
export interface ConsultaFiltravel {
  eq(coluna: string, valor: unknown): ConsultaFiltravel;
  is(coluna: string, valor: null): ConsultaFiltravel;
  lt(coluna: string, valor: unknown): ConsultaFiltravel;
  contains(coluna: string, valor: string): ConsultaFiltravel;
  or(filtros: string): ConsultaFiltravel;
}

/**
 * Aplica os filtros da tela a uma consulta de `crm_leads`. Mesma semântica de
 * `applyFilters` (lib/kanban/filters.ts) — que o cliente continua aplicando por
 * cima, para o card que uma edição otimista tirou do filtro sumir na hora.
 */
export function aplicarFiltrosDoBoard<Q>(consulta: Q, f: LeadFilters, hoje: string): Q {
  let q = consulta as unknown as ConsultaFiltravel;
  if (f.owner === "unassigned") {
    q = q.is("owner_user_id", null).is("owner_agent_id", null);
  } else if (f.owner && f.owner !== "any") {
    const agente = parseAgentOwnerFilter(f.owner);
    q = agente ? q.eq("owner_agent_id", agente) : q.eq("owner_user_id", f.owner);
  }
  if (f.status && f.status !== "all") q = q.eq("status", f.status);
  if (f.tag) q = q.contains("tags", literalDeTag(f.tag));
  const busca = filtroDeBusca(f.search);
  if (busca) q = q.or(busca);
  if (f.overdueOnly) q = q.eq("status", "open").lt("expected_close_date", hoje);
  return q as unknown as Q;
}

/**
 * Corta as `limite + 1` linhas pedidas: a extra não vai para a tela, só diz
 * onde a próxima página começa.
 */
export function cortarPagina<T extends { position_in_stage: number | string }>(
  linhas: T[],
  limite: number,
): { leads: T[]; next_position: number | null } {
  if (linhas.length <= limite) return { leads: linhas, next_position: null };
  return { leads: linhas.slice(0, limite), next_position: Number(linhas[limite]!.position_in_stage) };
}

// ─── Lado do cliente: o cache do board ──────────────────────────────────────

/** URL da primeira carga (ou do refetch), com os filtros e as páginas abertas. */
export function urlDoBoard(
  pipelineId: string,
  filtrosQs: string,
  limites: ReadonlyMap<string, number>,
  leadEmFoco: string | null,
): string {
  const p = new URLSearchParams(filtrosQs);
  const abertos = [...limites]
    .filter(([, n]) => n > POR_ETAPA_PADRAO)
    .map(([id, n]) => `${id}:${Math.min(n, MAX_POR_ETAPA)}`);
  if (abertos.length > 0) p.set("limites", abertos.join(","));
  if (leadEmFoco) p.set("lead", leadEmFoco);
  const qs = p.toString();
  return `/api/v1/pipelines/${pipelineId}/board${qs ? `?${qs}` : ""}`;
}

/** URL da página seguinte de uma etapa. */
export function urlDaPagina(pipelineId: string, filtrosQs: string, stageId: string, offset: number): string {
  const p = new URLSearchParams(filtrosQs);
  p.set("stage_id", stageId);
  p.set("offset", String(offset));
  return `/api/v1/pipelines/${pipelineId}/board?${p.toString()}`;
}

export function carregadosNaEtapa(board: BoardData, stageId: string): number {
  let n = 0;
  for (const l of board.leads) if (l.stage_id === stageId) n++;
  return n;
}

/**
 * Junta a página seguinte de uma etapa ao cache. Lead que já está no cache (um
 * movimento concorrente o fez aparecer de novo no offset) é substituído pela
 * versão nova, nunca duplicado — chave do React repetida quebra o arrastar.
 */
export function mesclarPaginaDaEtapa(board: BoardData, pagina: StagePageData): BoardData {
  const novos = new Map(pagina.leads.map((l) => [l.id, l]));
  const leads: Lead[] = board.leads.map((l) => novos.get(l.id) ?? l);
  const ja = new Set(board.leads.map((l) => l.id));
  for (const l of pagina.leads) if (!ja.has(l.id)) leads.push(l);
  return {
    ...board,
    leads,
    stage_pages: {
      ...board.stage_pages,
      [pagina.stage_id]: {
        total: pagina.total,
        value_cents: board.stage_pages?.[pagina.stage_id]?.value_cents ?? pagina.value_cents,
        next_position: pagina.next_position,
      },
    },
  };
}

/**
 * Movimento otimista no cache: o lead troca de etapa/posição e os totais das
 * duas colunas acompanham (senão o contador fica errado até o refetch).
 */
export function moverNoCache(
  board: BoardData,
  leadId: string,
  stageId: string,
  posicao: number,
): BoardData {
  const lead = board.leads.find((l) => l.id === leadId);
  if (!lead) return board;
  let stage_pages = board.stage_pages;
  if (stage_pages && lead.stage_id !== stageId) {
    const valor = lead.value_cents ?? 0;
    const ajusta = (id: string, delta: number): Record<string, StagePage> => {
      const atual = stage_pages![id];
      if (!atual) return stage_pages!;
      return {
        ...stage_pages,
        [id]: {
          ...atual,
          total: Math.max(0, atual.total + delta),
          value_cents: atual.value_cents + delta * valor,
        },
      };
    };
    stage_pages = ajusta(lead.stage_id, -1);
    stage_pages = ajusta(stageId, +1);
  }
  return {
    ...board,
    stage_pages,
    leads: board.leads.map((l) =>
      l.id === leadId ? { ...l, stage_id: stageId, position_in_stage: posicao } : l,
    ),
  };
}

/**
 * Os vizinhos de um card solto na posição `indice` da lista VISÍVEL de destino
 * (já sem o próprio card).
 *
 * Soltar no fim de uma lista parcial: o vizinho de baixo NÃO é "ninguém" — é o
 * primeiro lead que a tela não carregou (`proximaPosicao`). Com "ninguém", o
 * `midpoint` daria último+1000, que cai no meio (ou em cima) dos leads ocultos.
 */
export function vizinhosAoSoltar(
  lista: ReadonlyArray<{ position_in_stage: number }>,
  indice: number,
  proximaPosicao: number | null,
): { antes: number | null; depois: number | null } {
  const antes = indice > 0 ? (lista[indice - 1]?.position_in_stage ?? null) : null;
  const depois = indice < lista.length ? lista[indice]!.position_in_stage : proximaPosicao;
  return { antes, depois };
}
