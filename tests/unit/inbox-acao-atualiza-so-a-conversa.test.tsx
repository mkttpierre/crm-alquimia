import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DEPOIS DE UMA AÇÃO DO USUÁRIO OU DE UMA MENSAGEM DA CONVERSA ABERTA, A LISTA
 * ATUALIZA SÓ A CONVERSA QUE MUDOU.
 *
 * Antes: enviar, marcar como lida, assumir, encerrar, transferir etc. invalidavam
 * `["conversations"]` (e cada evento de mensagem da conversa aberta fazia o
 * mesmo, agrupado), e com a lista completa isso eram ~8 GETs em sequência por
 * ação. Agora, quando se sabe QUAL conversa mudou, o hook busca só ela
 * (`GET /conversations/{id}`) DEPOIS que a mutação terminou no servidor e a
 * insere/reordena/remove no cache. Onde não se sabe (busca ativa, `assigned_to=me`
 * sem o id de quem olha, ação sobre contato) a recarga completa continua.
 */

const mock = vi.hoisted(() => ({
  handler: null as null | ((p: unknown) => void),
  chamadas: [] as string[],
  get: vi.fn(),
  escrita: vi.fn(),
  agrupado: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (u: string) => mock.get(u),
    post: (u: string) => mock.escrita("POST", u),
    patch: (u: string) => mock.escrita("PATCH", u),
    delete: (u: string) => mock.escrita("DELETE", u),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u-1", support: null } }) }));
vi.mock("@/lib/inbox/invalidar-conversas", () => ({
  invalidarConversasAgrupado: (...a: unknown[]) => mock.agrupado(...a),
}));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => {
    const canal: Record<string, unknown> = {};
    canal.on = (_t: string, _c: unknown, h: (p: unknown) => void) => {
      mock.handler = h;
      return canal;
    };
    canal.subscribe = () => canal;
    return { channel: () => canal, removeChannel: () => {} };
  },
}));

import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useCloseConversation, useReopenConversation } from "@/hooks/inbox/useCloseConversation";
import { useUpdateConversationTags } from "@/hooks/inbox/useConversationTags";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { useMarkAsRead } from "@/hooks/inbox/useMarkAsRead";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { usePauseAiAttendance } from "@/hooks/inbox/usePauseAiAttendance";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useSequenciaComando } from "@/hooks/inbox/useSequenciaComando";
import { useSnoozeConversation } from "@/hooks/inbox/useSnoozeConversation";
import { useTransferConversation } from "@/hooks/inbox/useTransferConversation";
import { registrarMeuId } from "@/lib/inbox/atualizar-conversa-no-cache";
import { ApiError } from "@/lib/api/types";

function conv(id: string, over: Partial<ConversationWithContact> = {}): ConversationWithContact {
  return {
    id,
    status: "open",
    channel_session_id: "ch-1",
    assigned_to_user_id: null,
    tags: [],
    unread_count_for_assignee: 3,
    last_message_at: "2026-11-01T10:00:00Z",
    last_inbound_at: "2026-11-01T10:00:00Z",
    comando_da_conversa: "aguardando",
    ...over,
  } as ConversationWithContact;
}

let servidor: Map<string, ConversationWithContact>;
const ehLista = (u: string) => u.startsWith("/api/v1/conversations?");
const buscasDeUma = () =>
  mock.get.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith("/api/v1/conversations/") && !u.includes("/messages"));
const buscasDeLista = () => mock.get.mock.calls.map((c) => c[0] as string).filter(ehLista);

const CHAVE = (filtros: object = {}) => ["conversations", filtros, true] as const;
const lista = (...cs: ConversationWithContact[]) => ({
  pages: [{ data: cs, meta: { has_more: false, cursor: null } }],
  pageParams: [undefined],
});
const idsDe = (qc: QueryClient, filtros: object = {}) =>
  (qc.getQueryData<ReturnType<typeof lista>>(CHAVE(filtros))?.pages ?? []).flatMap((p) => p.data).map((c) => c.id);
const daLista = (qc: QueryClient, id: string, filtros: object = {}) =>
  (qc.getQueryData<ReturnType<typeof lista>>(CHAVE(filtros))?.pages ?? []).flatMap((p) => p.data).find((c) => c.id === id);

function novoQc(filtros: object = {}, semear = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (semear) {
    qc.setQueryData(
      CHAVE(filtros),
      lista(
        conv("a", { last_message_at: "2026-11-01T12:00:00Z" }),
        conv("b", { last_message_at: "2026-11-01T11:00:00Z" }),
        conv("c", { last_message_at: "2026-11-01T10:00:00Z" }),
      ),
    );
  }
  return qc;
}
const envolver = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

beforeEach(() => {
  mock.handler = null;
  mock.chamadas = [];
  mock.get.mockReset();
  mock.escrita.mockReset();
  mock.agrupado.mockReset();
  servidor = new Map([["a", conv("a", { last_message_at: "2026-11-01T12:00:00Z" })]]);
  // A escrita só "termina" depois de um tick: a busca individual tem de vir DEPOIS dela.
  mock.escrita.mockImplementation(async (metodo: string, u: string) => {
    mock.chamadas.push(`${metodo} ${u}`);
    await new Promise((r) => setTimeout(r, 15));
    mock.chamadas.push(`fim ${metodo} ${u}`);
    return { data: {} };
  });
  mock.get.mockImplementation(async (u: string) => {
    mock.chamadas.push(`GET ${u}`);
    if (ehLista(u)) return { data: [...servidor.values()], meta: { has_more: false } };
    if (u.includes("/messages")) return { data: [], meta: { has_more: false } };
    const c = servidor.get(u.replace("/api/v1/conversations/", ""));
    if (!c) throw new ApiError(404, "not_found", undefined, "req-teste", "x");
    return { data: c };
  });
});

/** O estado que o servidor passa a ter depois da ação: lida, mais recente, dona definida. */
function servidorDepoisDaAcao(over: Partial<ConversationWithContact> = {}) {
  servidor.set(
    "c",
    conv("c", {
      unread_count_for_assignee: 0,
      last_message_at: "2026-11-01T13:00:00Z",
      last_message_preview: "depois",
      ...over,
    }),
  );
}

const ID = "c";
const acoes: { nome: string; rodar: (qc: QueryClient) => Promise<void> }[] = [
  {
    nome: "assumir (claim)",
    rodar: async (qc) => {
      const { result } = renderHook(() => useClaimConversation(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    },
  },
  {
    nome: "encerrar (close)",
    rodar: async (qc) => {
      const { result } = renderHook(() => useCloseConversation(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    },
  },
  {
    nome: "reabrir",
    rodar: async (qc) => {
      const { result } = renderHook(() => useReopenConversation(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    },
  },
  {
    nome: "devolver (release)",
    rodar: async (qc) => {
      const { result } = renderHook(() => useReleaseConversation(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    },
  },
  {
    nome: "transferir",
    rodar: async (qc) => {
      const { result } = renderHook(() => useTransferConversation(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID, to_user_id: "u-2" }));
    },
  },
  {
    nome: "pausar o automático",
    rodar: async (qc) => {
      const { result } = renderHook(() => usePauseAiAttendance(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    },
  },
  {
    nome: "devolver ao automático",
    rodar: async (qc) => {
      const { result } = renderHook(() => useResumeAiAttendance(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    },
  },
  {
    nome: "adiar (snooze)",
    rodar: async (qc) => {
      const { result } = renderHook(() => useSnoozeConversation(), { wrapper: envolver(qc) });
      await act(async () => result.current.snooze.mutateAsync({ conversation_id: ID, duration_hours: 1 }));
    },
  },
  {
    nome: "cancelar adiamento",
    rodar: async (qc) => {
      const { result } = renderHook(() => useSnoozeConversation(), { wrapper: envolver(qc) });
      await act(async () => result.current.cancel.mutateAsync({ conversation_id: ID }));
    },
  },
  {
    nome: "tags da conversa",
    rodar: async (qc) => {
      const { result } = renderHook(() => useUpdateConversationTags(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID, tags: ["vip"] }));
    },
  },
  {
    nome: "enviar mensagem",
    rodar: async (qc) => {
      const { result } = renderHook(() => useSendMessage(), { wrapper: envolver(qc) });
      await act(async () => result.current.mutateAsync({ conversation_id: ID, body: "oi", type: "text" }));
    },
  },
  {
    nome: "sequência do funil",
    rodar: async (qc) => {
      const { result } = renderHook(() => useSequenciaComando(), { wrapper: envolver(qc) });
      // a resposta de mentira não tem `data`: o onSuccess de toast não é o assunto aqui
      mock.escrita.mockImplementation(async (metodo: string, u: string) => {
        mock.chamadas.push(`${metodo} ${u}`);
        await new Promise((r) => setTimeout(r, 15));
        mock.chamadas.push(`fim ${metodo} ${u}`);
        return { data: { titulo: "t", partes: 1, modo: "real", motivo_simulado: null, chip: "x", primeira_em: "", ultima_em: "", duracao_seg: 1 } };
      });
      await act(async () => result.current.mutateAsync({ conversation_id: ID, atalho: "funil-valores" }));
    },
  },
  {
    nome: "marcar como lida",
    rodar: async (qc) => {
      renderHook(() => useMarkAsRead(ID, 3), { wrapper: envolver(qc) });
      await waitFor(() => expect(mock.chamadas.some((c) => c.startsWith("fim POST"))).toBe(true), { timeout: 4000 });
    },
  },
];

describe("(b) ação do usuário: uma busca só da conversa, DEPOIS da mutação, e a lista reflete o novo estado", () => {
  it.each(acoes)("$nome", async ({ rodar }) => {
    const qc = novoQc();
    servidorDepoisDaAcao();
    await rodar(qc);

    await waitFor(() => expect(daLista(qc, ID)?.unread_count_for_assignee).toBe(0));
    expect(buscasDeUma()).toEqual([`/api/v1/conversations/${ID}`]);
    expect(buscasDeLista()).toEqual([]);
    expect(mock.agrupado).not.toHaveBeenCalled();
    // reordenou: a conversa mais recente subiu para o topo
    expect(idsDe(qc)[0]).toBe(ID);
    // a busca veio depois que a escrita terminou no servidor
    const fimDaEscrita = mock.chamadas.findIndex((c) => c.startsWith("fim "));
    const busca = mock.chamadas.indexOf(`GET /api/v1/conversations/${ID}`);
    expect(fimDaEscrita).toBeGreaterThanOrEqual(0);
    expect(busca).toBeGreaterThan(fimDaEscrita);
  }, 10_000);

  it("a conversa que a ação tirou do filtro sai da lista (sai da Fila, encerrada some das abertas)", async () => {
    const filtros = { exclude_finished: true };
    const qc = novoQc(filtros);
    servidorDepoisDaAcao({ status: "closed" });
    const { result } = renderHook(() => useCloseConversation(), { wrapper: envolver(qc) });
    await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    await waitFor(() => expect(idsDe(qc, filtros)).toEqual(["a", "b"]));
    expect(buscasDeLista()).toEqual([]);
  });

  it("assumir com a lista 'Minhas' e o id de quem olha registrado: entra na lista sem recarregar", async () => {
    const filtros = { assigned_to: "me" as const };
    const qc = novoQc(filtros);
    registrarMeuId(qc, "u-1");
    servidorDepoisDaAcao({ assigned_to_user_id: "u-1" });
    const { result } = renderHook(() => useClaimConversation(), { wrapper: envolver(qc) });
    await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    await waitFor(() => expect(daLista(qc, ID, filtros)?.assigned_to_user_id).toBe("u-1"));
    expect(buscasDeLista()).toEqual([]);
    expect(mock.agrupado).not.toHaveBeenCalled();
  });

  it("erro da ação: a conversa também é conferida (o servidor pode ter outro dono), e o erro continua sendo mostrado", async () => {
    const { showApiError } = await import("@/components/feedback/ApiErrorToast");
    const qc = novoQc();
    servidorDepoisDaAcao({ assigned_to_user_id: "u-9" });
    mock.escrita.mockRejectedValueOnce(new ApiError(409, "conflict", undefined, "req-teste", "outro dono"));
    const { result } = renderHook(() => useClaimConversation(), { wrapper: envolver(qc) });
    await act(async () => {
      await result.current.mutateAsync({ conversation_id: ID }).catch(() => undefined);
    });
    await waitFor(() => expect(daLista(qc, ID)?.assigned_to_user_id).toBe("u-9"));
    expect(showApiError).toHaveBeenCalled();
    expect(buscasDeLista()).toEqual([]);
  });
});

describe("(c) o que o cliente não decide continua recarregando tudo", () => {
  it("busca ativa: a ação cai na recarga agrupada, sem busca individual", async () => {
    const filtros = { search: "ana" };
    const qc = novoQc(filtros);
    const { result } = renderHook(() => useCloseConversation(), { wrapper: envolver(qc) });
    await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    await waitFor(() => expect(mock.agrupado).toHaveBeenCalledTimes(1));
    expect(buscasDeUma()).toEqual([]);
  });

  it("'Minhas' sem o id de quem olha: recarga agrupada", async () => {
    const filtros = { assigned_to: "me" as const };
    const qc = novoQc(filtros);
    const { result } = renderHook(() => useClaimConversation(), { wrapper: envolver(qc) });
    await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    await waitFor(() => expect(mock.agrupado).toHaveBeenCalledTimes(1));
    expect(buscasDeUma()).toEqual([]);
  });

  it("busca individual que falha (rede) cai na recarga agrupada", async () => {
    const qc = novoQc();
    mock.get.mockImplementation(async (u: string) => {
      if (u.startsWith("/api/v1/conversations/")) throw new Error("rede");
      return { data: [], meta: { has_more: false } };
    });
    const { result } = renderHook(() => useClaimConversation(), { wrapper: envolver(qc) });
    await act(async () => result.current.mutateAsync({ conversation_id: ID }));
    await waitFor(() => expect(mock.agrupado).toHaveBeenCalledTimes(1));
  });
});

describe("(a) evento de mensagem da conversa aberta", () => {
  function montarMensagens(qc: QueryClient) {
    return renderHook(() => useMessagesRealtime(ID), { wrapper: envolver(qc) });
  }
  const evento = () => act(async () => mock.handler!({ eventType: "INSERT", new: { id: "m1" }, old: {} }));

  it("gera no máximo UMA busca da conversa, e nenhuma recarga de todas as páginas", async () => {
    const qc = novoQc();
    montarMensagens(qc);
    await waitFor(() => expect(mock.handler).not.toBeNull());
    servidorDepoisDaAcao();
    const listasAntes = buscasDeLista().length;

    await evento();
    await evento(); // rajada: cada mensagem dispara um evento
    await evento();

    await waitFor(() => expect(daLista(qc, ID)?.last_message_preview).toBe("depois"));
    expect(buscasDeUma()).toEqual([`/api/v1/conversations/${ID}`]);
    expect(buscasDeLista().length).toBe(listasAntes);
    expect(mock.agrupado).not.toHaveBeenCalled();
    expect(idsDe(qc)[0]).toBe(ID);
  });

  it("com busca ativa na lista, continua recarregando tudo (agrupado)", async () => {
    const qc = novoQc({ search: "ana" });
    montarMensagens(qc);
    await waitFor(() => expect(mock.handler).not.toBeNull());
    await evento();
    await waitFor(() => expect(mock.agrupado).toHaveBeenCalledTimes(1));
    expect(buscasDeUma()).toEqual([]);
  });
});
