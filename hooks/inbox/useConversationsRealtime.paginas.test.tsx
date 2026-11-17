import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";

import { useConversationsRealtime } from "./useConversationsRealtime";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "SUBSCRIBED", ultimaEntrega: { current: null } }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => ({ divergencias: 0 }),
}));

/**
 * A carga completa do inbox (abas do multiatendimento, `todasAsPaginas`) pedia
 * as páginas UMA DEPOIS DA OUTRA pelo cursor: com ~800 conversas, 8 voltas
 * inteiras de rede+banco antes de a lista aparecer (varredura de 10/11/2026).
 *
 * O dublê do servidor atende os dois protocolos — `cursor` (o de antes) e
 * `offset` (o de agora) — e mede quantas requisições ficaram em voo ao mesmo
 * tempo. O critério: páginas em paralelo, nunca mais de 4 simultâneas, e a
 * lista final igual à do servidor, na ordem, sem repetição.
 */

const TOTAL = 750;
const CONVERSAS = Array.from({ length: TOTAL }, (_, i) => ({
  id: `c${String(i).padStart(4, "0")}`,
  last_message_at: new Date(Date.UTC(2026, 10, 1) - i * 60_000).toISOString(),
}));

let emVoo = 0;
let maxEmVoo = 0;
let pedidos: URLSearchParams[] = [];

function servidor(url: string) {
  const qs = new URL(url, "http://x").searchParams;
  pedidos.push(qs);
  const limite = Number(qs.get("limit") ?? 50);
  const inicio = qs.get("cursor") !== null ? Number(qs.get("cursor")) : Number(qs.get("offset") ?? 0);
  const data = CONVERSAS.slice(inicio, inicio + limite);
  const has_more = inicio + limite < TOTAL;
  return { data, meta: { has_more, cursor: has_more ? String(inicio + limite) : null } };
}

beforeEach(() => {
  emVoo = 0;
  maxEmVoo = 0;
  pedidos = [];
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    emVoo++;
    maxEmVoo = Math.max(maxEmVoo, emVoo);
    await new Promise((r) => setTimeout(r, 5));
    emVoo--;
    return servidor(url);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function montar(todasAsPaginas: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => useConversationsRealtime({ status: ["open", "pending"] }, "org-1", { todasAsPaginas, meuId: "u1" }),
    { wrapper },
  );
}

describe("inbox: carga completa em paralelo, no máximo 4 simultâneas", () => {
  it("busca as páginas em paralelo (mais de uma em voo), nunca mais de 4", async () => {
    const { result } = montar(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(maxEmVoo).toBeGreaterThan(1);
    expect(maxEmVoo).toBeLessThanOrEqual(4);
  });

  it("a lista final é a do servidor, inteira, na ordem e sem repetição", async () => {
    const { result } = montar(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const ids = result.current.data!.pages.flatMap((p) => p.data.map((c) => c.id));
    expect(ids).toEqual(CONVERSAS.map((c) => c.id));
    expect(result.current.data!.pages.at(-1)!.meta?.has_more).toBe(false);
  });

  it("todo pedido leva os filtros e o teto de 100 por página", async () => {
    const { result } = montar(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(pedidos.length).toBeGreaterThan(0);
    for (const qs of pedidos) {
      expect(qs.get("status")).toBe("open,pending");
      expect(qs.get("limit")).toBe("100");
    }
  });

  it("CONTROLE: a lista paginada comum (sem todasAsPaginas) segue com uma página de 50 pelo cursor", async () => {
    const { result } = montar(false);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.get("limit")).toBe("50");
    expect(pedidos[0]!.get("offset")).toBeNull();
    expect(result.current.hasNextPage).toBe(true);
  });
});
