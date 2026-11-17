import { describe, expect, it } from "vitest";

/**
 * O CLIENTE ESPELHA O SERVIDOR: mesma ordem, mesmo filtro.
 *
 * `lib/inbox/atualizar-lista-conversas.ts` decide no navegador o que
 * `listConversationsHandler` (app/api/v1/conversations/_handler.ts) decide no
 * banco. Se a rota mudar uma ordem ou um filtro e o cliente não, a lista fica
 * errada só depois de um evento de Realtime ou de uma ação, sem erro nenhum.
 *
 * Aqui o MESMO conjunto de conversas passa pelas duas regras. A do servidor é
 * o handler de verdade, rodando contra um supabase de mentira que avalia em
 * memória, com a semântica do Postgres, as chamadas que ele faz (`eq`, `in`,
 * `not in`, `is null`, `contains`, `order` com nulos por último, `limit`).
 * Uma chamada que o handler passe a fazer e o fake não conheça derruba o teste
 * (não é ignorada). Se o filtro ou a ordem de um lado mudar, mude o outro e a
 * tabela de combinações abaixo.
 */

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { tabToFilter } from "@/components/inbox/InboxLayout";
import type { ConversationsFilters, ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import {
  casaComFiltros,
  ehFila,
  inserirConversa,
  type ListaDeConversas,
} from "@/lib/inbox/atualizar-lista-conversas";

type Linha = Record<string, unknown>;

function fakeSupabase(linhas: Linha[]) {
  const filtros: ((r: Linha) => boolean)[] = [];
  const ordens: { col: string; asc: boolean }[] = [];
  let limite = Infinity;
  const proxy: Record<string, unknown> = {};
  const metodos: Record<string, (...a: unknown[]) => void> = {
    select: () => {},
    eq: (c, v) => void filtros.push((r) => r[c as string] === v),
    in: (c, vs) => void filtros.push((r) => (vs as unknown[]).includes(r[c as string])),
    not: (c, op, v) => {
      if (op !== "in") throw new Error(`not.${String(op)} desconhecido no fake`);
      const lista = String(v).replace(/[()]/g, "").split(",");
      filtros.push((r) => !lista.includes(String(r[c as string])));
    },
    is: (c, v) => {
      if (v !== null) throw new Error("is só com null no fake");
      filtros.push((r) => r[c as string] === null || r[c as string] === undefined);
    },
    contains: (c, vs) =>
      void filtros.push((r) => (vs as unknown[]).every((v) => ((r[c as string] as unknown[]) ?? []).includes(v))),
    order: (col, o) => {
      const opc = o as { ascending: boolean; nullsFirst?: boolean };
      // Postgres: nullsFirst:false = nulos por último nos dois sentidos.
      if (col !== "id" && opc.nullsFirst !== false) throw new Error("fake só conhece nullsFirst:false");
      ordens.push({ col: col as string, asc: opc.ascending });
    },
    limit: (n) => void (limite = n as number),
  };
  for (const [nome, f] of Object.entries(metodos)) {
    proxy[nome] = (...a: unknown[]) => {
      f(...a);
      return proxy;
    };
  }
  proxy.then = (ok: (v: unknown) => unknown) => {
    const ordenado = linhas
      .filter((r) => filtros.every((f) => f(r)))
      .sort((a, b) => {
        for (const { col, asc } of ordens) {
          const x = a[col] as string | null | undefined;
          const y = b[col] as string | null | undefined;
          if (x === y) continue;
          if (x == null) return 1;
          if (y == null) return -1;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
    return ok({ data: ordenado.slice(0, limite), error: null });
  };
  return { from: () => proxy } as never;
}

const ME = "00000000-0000-4000-8000-0000000000aa";
const OUTRO = "00000000-0000-4000-8000-0000000000bb";
const CANAL = "00000000-0000-4000-8000-0000000000cc";

function c(id: string, o: Partial<ConversationWithContact>): ConversationWithContact {
  return {
    id,
    organization_id: "org-1",
    status: "open",
    channel_session_id: CANAL,
    assigned_to_user_id: null,
    tags: [],
    comando_da_conversa: "humano",
    last_message_at: "2026-11-01T10:00:00Z",
    last_inbound_at: "2026-11-01T10:00:00Z",
    ...o,
  } as ConversationWithContact;
}

// Empates de data (desempate por id), nulos nas duas colunas e todos os estados.
const CONVERSAS: ConversationWithContact[] = [
  c("c01", { last_message_at: "2026-11-01T12:00:00Z", last_inbound_at: "2026-11-01T09:00:00Z", status: "open", comando_da_conversa: "aguardando" }),
  c("c02", { last_message_at: "2026-11-01T12:00:00Z", last_inbound_at: "2026-11-01T09:00:00Z", status: "pending", comando_da_conversa: "aguardando" }),
  c("c03", { last_message_at: "2026-11-01T11:00:00Z", last_inbound_at: null, status: "claimed", assigned_to_user_id: ME }),
  c("c04", { last_message_at: null, last_inbound_at: "2026-11-01T08:00:00Z", status: "open", comando_da_conversa: "automatico" }),
  c("c05", { last_message_at: "2026-11-01T10:30:00Z", last_inbound_at: "2026-11-01T10:30:00Z", status: "ai_handling", comando_da_conversa: "automatico", tags: ["vip"] }),
  c("c06", { last_message_at: "2026-11-01T10:30:00Z", last_inbound_at: null, status: "closed", assigned_to_user_id: ME, tags: ["vip", "x"] }),
  c("c07", { last_message_at: null, last_inbound_at: null, status: "archived", assigned_to_user_id: OUTRO }),
  c("c08", { last_message_at: "2026-11-01T09:00:00Z", last_inbound_at: "2026-11-01T09:00:00Z", status: "resolved", channel_session_id: "outro-canal", assigned_to_user_id: OUTRO, tags: ["vip"] }),
  c("c09", { last_message_at: "2026-11-01T09:00:00Z", last_inbound_at: "2026-11-01T09:00:00Z", status: "open", assigned_to_user_id: OUTRO, tags: ["vip"] }),
  c("c10", { last_message_at: "2026-11-01T13:00:00Z", last_inbound_at: "2026-11-01T07:00:00Z", status: "pending", comando_da_conversa: "aguardando", tags: ["x"] }),
];

const ctx = { organization_id: "org-1", requestId: "r", actor: { type: "user" as const, id: ME } } as never;

async function doServidor(f: ConversationsFilters): Promise<string[]> {
  const q = {
    limit: 100,
    ...f,
    status: f.status === undefined ? undefined : typeof f.status === "string" ? [f.status] : [...f.status],
  };
  const r = await listConversationsHandler(fakeSupabase(CONVERSAS.map((x) => ({ ...x }))), ctx, q as never);
  return r.conversations.map((x) => x.id);
}

/** Como o cliente monta a lista: cada conversa entra pelo filtro e pela inserção, em ordem embaralhada. */
function doCliente(f: ConversationsFilters): string[] {
  let lista: ListaDeConversas = { pages: [{ data: [], meta: { has_more: false } }], pageParams: [undefined] };
  const fila = ehFila(f);
  for (const conv of [...CONVERSAS].reverse()) {
    if (casaComFiltros(conv, f, ME)) lista = inserirConversa(lista, conv, fila);
  }
  return lista.pages.flatMap((p) => p.data).map((x) => x.id);
}

const COMBINACOES: [string, ConversationsFilters][] = [
  ["sem filtro (Todas)", {}],
  ["Minhas", { assigned_to: "me" }],
  ["Minhas sem as fechadas", { assigned_to: "me", exclude_finished: true }],
  ["dono específico", { assigned_to: OUTRO }],
  ["sem dono", { assigned_to: "unassigned" }],
  ["canal", { channel_session_id: CANAL }],
  ["tag", { tag: "vip" }],
  ["canal + tag", { channel_session_id: CANAL, tag: "vip" }],
  ["Minhas + tag", { assigned_to: "me", tag: "vip" }],
  ["status único", { status: "open" }],
  ["status em lista", { status: ["open", "pending"] }],
  ["só terminais", { status: "closed" }],
  ["status terminal + exclude_finished (contradição = vazio)", { status: ["closed"], exclude_finished: true }],
  ["exclude_finished", { exclude_finished: true }],
  ["Fila por comando (ordem por espera)", { comando: ["aguardando"] }],
  ["Fila com automático", { comando: ["aguardando", "automatico"] }],
  ["automático", { comando: ["automatico"] }],
  ["comando + canal + tag", { comando: ["humano", "automatico"], channel_session_id: CANAL, tag: "vip" }],
  ["Fila legada (sem dono)", { assigned_to: "unassigned", status: ["open", "pending"] }],
  ["aba Fila (tabToFilter)", tabToFilter("unassigned")],
  ["aba Minhas", tabToFilter("mine")],
  ["aba Fechadas", tabToFilter("closed")],
  ["aba Automático", tabToFilter("ai")],
  ["aba Todas", tabToFilter("all")],
];

describe("lista do cliente = lista do servidor", () => {
  it.each(COMBINACOES)("%s", async (_nome, filtros) => {
    expect(doCliente(filtros)).toEqual(await doServidor(filtros));
  });

  it("controle: o conjunto distingue as regras (resultados diferentes entre combinações, e ao menos um vazio)", async () => {
    const todos = await Promise.all(COMBINACOES.map(([, f]) => doServidor(f)));
    expect(new Set(todos.map((x) => x.join())).size).toBeGreaterThan(10);
    expect(todos.some((x) => x.length === 0)).toBe(true);
  });
});
