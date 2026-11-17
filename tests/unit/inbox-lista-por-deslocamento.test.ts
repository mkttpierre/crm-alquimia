/**
 * A LISTA DE CONVERSAS ACEITA DESLOCAMENTO (`offset`) — o encanamento da carga
 * completa em paralelo do inbox (`lib/inbox/carregar-paginas-em-paralelo.ts`).
 *
 * Três elos, cada um quebrável sozinho sem os outros acusarem:
 *   schema   aceita `offset` (inteiro ≥ 0);
 *   handler  troca o `limit` por `range(offset, offset + limit)` (limit + 1 linhas,
 *            a sobra é o has_more) e recusa `offset` junto de `cursor`;
 *   rota     lê `?offset=` (a leitura em si é vigiada por
 *            `rota-le-todo-filtro-do-schema.test.ts`).
 */
import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { ApiError } from "@/lib/api/types";
import { listConversationsQuerySchema } from "@/lib/schemas";

function fakeSupabase() {
  const chamadas: { metodo: string; args: unknown[] }[] = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        }
        return (...args: unknown[]) => {
          chamadas.push({ metodo: String(prop), args });
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  return { client: { from: () => proxy } as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

describe("schema: offset", () => {
  it("aceita inteiro ≥ 0 vindo da query string", () => {
    const r = listConversationsQuerySchema.safeParse({ offset: "300" });
    expect(r.success && r.data.offset).toBe(300);
  });

  it("recusa negativo", () => {
    expect(listConversationsQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });

  it("sem o parâmetro, fica indefinido (o caminho do cursor não muda)", () => {
    const r = listConversationsQuerySchema.safeParse({});
    expect(r.success && r.data.offset).toBeUndefined();
  });
});

describe("handler: offset vira range com uma linha de sobra", () => {
  it("offset 200, limit 100 → range(200, 300)", async () => {
    const { client, chamadas } = fakeSupabase();
    await listConversationsHandler(client, ctx, { limit: 100, offset: 200 } as never);
    expect(chamadas.filter((c) => c.metodo === "range").map((c) => c.args)).toEqual([[200, 300]]);
  });

  it("CONTROLE: sem offset, nenhum range (o cursor segue como antes)", async () => {
    const { client, chamadas } = fakeSupabase();
    await listConversationsHandler(client, ctx, { limit: 100 } as never);
    expect(chamadas.some((c) => c.metodo === "range")).toBe(false);
  });

  it("offset junto de cursor é recusado com 400", async () => {
    const { client } = fakeSupabase();
    const cursor = Buffer.from(JSON.stringify({ sort: null, id: "x" }), "utf8").toString("base64url");
    await expect(
      listConversationsHandler(client, ctx, { limit: 100, offset: 100, cursor } as never),
    ).rejects.toSatisfy((e) => e instanceof ApiError && e.status === 400);
  });
});
