import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * UM EVENTO DE REALTIME ATUALIZA SÓ A CONVERSA QUE MUDOU.
 *
 * Antes: cada evento de `conversations` (de QUALQUER conversa da org) invalidava
 * a lista inteira, e com `todasAsPaginas` isso eram ~8 GETs em sequência
 * (~1 s de banco) por mensagem recebida. Agora o hook busca SÓ a conversa do
 * payload (`GET /api/v1/conversations/{id}`, mesmo SELECT da lista) e a
 * remove/insere/reordena no cache. A recarga completa fica para montagem,
 * reconexão (`{tipo:"reassinado"}`) e a rede de segurança.
 */

const mock = vi.hoisted(() => ({
  handler: null as null | ((p: unknown) => void),
  get: vi.fn(),
  agrupado: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (u: string) => mock.get(u) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
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

import { useConversationsRealtime } from "@/hooks/inbox/useConversationsRealtime";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

function conv(id: string, over: Partial<ConversationWithContact> = {}): ConversationWithContact {
  return {
    id,
    status: "open",
    channel_session_id: "ch-1",
    assigned_to_user_id: null,
    tags: [],
    last_message_at: "2026-11-01T10:00:00Z",
    last_inbound_at: "2026-11-01T10:00:00Z",
    comando_da_conversa: "humano",
    ...over,
  } as ConversationWithContact;
}

/** Estado "servidor": a lista e o que `GET /conversations/{id}` devolve. */
let servidor: Map<string, ConversationWithContact>;
const ehLista = (u: string) => u.startsWith("/api/v1/conversations?");
const idDaUrl = (u: string) => u.replace("/api/v1/conversations/", "");
const buscasDeUma = () => mock.get.mock.calls.map((c) => c[0] as string).filter((u) => !ehLista(u));
const buscasDeLista = () => mock.get.mock.calls.map((c) => c[0] as string).filter(ehLista);

function montar(filtros: Parameters<typeof useConversationsRealtime>[0] = {}, opts = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => useConversationsRealtime(filtros, "org-1", { todasAsPaginas: true, ...opts }),
    { wrapper },
  );
}
const ids = (r: { current: { data?: { pages: { data: ConversationWithContact[] }[] } } }) =>
  r.current.data?.pages.flatMap((p) => p.data).map((c) => c.id) ?? [];

async function pronto(r: ReturnType<typeof montar>["result"]) {
  await waitFor(() => expect(ids(r).length).toBeGreaterThan(0));
  await waitFor(() => expect(mock.handler).not.toBeNull());
}
const evento = (id: string, eventType = "UPDATE") =>
  act(async () => mock.handler!({ eventType, new: { id }, old: { id } }));

beforeEach(() => {
  mock.handler = null;
  mock.get.mockReset();
  mock.agrupado.mockReset();
  servidor = new Map([
    ["a", conv("a", { last_message_at: "2026-11-01T12:00:00Z" })],
    ["b", conv("b", { last_message_at: "2026-11-01T11:00:00Z" })],
    ["c", conv("c", { last_message_at: "2026-11-01T10:00:00Z" })],
  ]);
  mock.get.mockImplementation(async (u: string) => {
    if (ehLista(u)) {
      const qs = new URL(u, "http://x").searchParams;
      const offset = Number(qs.get("offset") ?? 0);
      const limite = Number(qs.get("limit") ?? 50);
      const todas = [...servidor.values()].sort((x, y) =>
        (y.last_message_at ?? "").localeCompare(x.last_message_at ?? ""),
      );
      // A carga completa pede por `offset`, em ondas de páginas: o dublê honra o deslocamento.
      return {
        data: todas.slice(offset, offset + limite),
        meta: { has_more: offset + limite < todas.length, cursor: null },
      };
    }
    const c = servidor.get(idDaUrl(u));
    if (!c) {
      const { ApiError } = await import("@/lib/api/types");
      throw new ApiError(404, "not_found", undefined, "req-teste", "x");
    }
    return { data: c };
  });
});

describe("evento de uma conversa", () => {
  it("(a) gera UMA busca daquela conversa e nenhuma recarga da lista", async () => {
    const { result } = montar();
    await pronto(result);
    const listasAntes = buscasDeLista().length;

    servidor.set("c", conv("c", { last_message_at: "2026-11-01T13:00:00Z", last_message_preview: "oi" }));
    await evento("c");
    await evento("c"); // rajada na mesma conversa
    await evento("c");

    await waitFor(() => expect(ids(result)[0]).toBe("c"));
    expect(buscasDeUma()).toEqual(["/api/v1/conversations/c"]);
    expect(buscasDeLista().length).toBe(listasAntes);
    expect(mock.agrupado).not.toHaveBeenCalled();
  });

  it("(b) a conversa atualizada sobe para a posição da ordenação da lista", async () => {
    const { result } = montar();
    await pronto(result);
    expect(ids(result)).toEqual(["a", "b", "c"]);

    servidor.set("b", conv("b", { last_message_at: "2026-11-01T12:30:00Z" }));
    await evento("b");
    await waitFor(() => expect(ids(result)).toEqual(["b", "a", "c"]));

    // e desce, se o valor novo for mais antigo
    servidor.set("b", conv("b", { last_message_at: "2026-11-01T09:00:00Z" }));
    await evento("b");
    await waitFor(() => expect(ids(result)).toEqual(["a", "c", "b"]));
  });

  it("(c) conversa nova que não estava na lista entra", async () => {
    const { result } = montar();
    await pronto(result);
    // A carga completa pede a lista em ondas de páginas por `offset` (várias buscas na
    // montagem); o que se guarda é que o EVENTO não recarrega a lista.
    const listasAntes = buscasDeLista().length;
    servidor.set("n", conv("n", { last_message_at: "2026-11-01T11:30:00Z" }));
    await evento("n", "INSERT");
    await waitFor(() => expect(ids(result)).toEqual(["a", "n", "b", "c"]));
    expect(buscasDeLista().length).toBe(listasAntes);
  });

  it("(d) conversa que deixou de casar o filtro do servidor sai", async () => {
    const { result } = montar({ channel_session_id: "ch-1", tag: "vip" });
    servidor.set("a", conv("a", { tags: ["vip"], last_message_at: "2026-11-01T12:00:00Z" }));
    servidor.set("b", conv("b", { tags: ["vip"], last_message_at: "2026-11-01T11:00:00Z" }));
    servidor.set("c", conv("c", { tags: ["vip"], last_message_at: "2026-11-01T10:00:00Z" }));
    await pronto(result);

    servidor.set("b", conv("b", { tags: [], last_message_at: "2026-11-01T11:00:00Z" }));
    await evento("b");
    await waitFor(() => expect(ids(result)).toEqual(["a", "c"]));

    // conversa de outro canal que apareceu não entra
    servidor.set("x", conv("x", { tags: ["vip"], channel_session_id: "ch-2" }));
    await evento("x", "INSERT");
    await waitFor(() => expect(buscasDeUma()).toContain("/api/v1/conversations/x"));
    expect(ids(result)).toEqual(["a", "c"]);
  });

  it("DELETE e 404 (saiu do escopo) removem sem recarregar a lista", async () => {
    const { result } = montar();
    await pronto(result);
    await evento("b", "DELETE");
    await waitFor(() => expect(ids(result)).toEqual(["a", "c"]));
    expect(buscasDeUma()).toEqual([]);

    servidor.delete("c");
    await evento("c");
    await waitFor(() => expect(ids(result)).toEqual(["a"]));
    expect(mock.agrupado).not.toHaveBeenCalled();
  });

  it("filtro que o cliente não consegue avaliar (busca) cai na recarga agrupada", async () => {
    const { result } = montar({ search: "ana" });
    await pronto(result);
    await evento("a");
    expect(mock.agrupado).toHaveBeenCalledTimes(1);
    expect(buscasDeUma()).toEqual([]);
  });

  it("falha na busca individual cai na recarga agrupada", async () => {
    const { result } = montar();
    await pronto(result);
    mock.get.mockImplementation(async (u: string) => {
      if (ehLista(u)) return { data: [...servidor.values()], meta: { has_more: false } };
      throw new Error("rede");
    });
    await evento("a");
    await waitFor(() => expect(mock.agrupado).toHaveBeenCalledTimes(1));
  });
});

describe("(e) reconexão", () => {
  it("o evento sintético de reassinatura ainda recarrega tudo", async () => {
    const { result } = montar();
    await pronto(result);
    await act(async () => mock.handler!({ tipo: "reassinado" }));
    expect(mock.agrupado).toHaveBeenCalledTimes(1);
    expect(buscasDeUma()).toEqual([]);
  });
});
