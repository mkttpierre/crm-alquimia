/**
 * O histórico que a IA lê não pode trazer nota de tela (`type=system`).
 *
 * A nota de ligação nasce `direction='outbound'` (ver `lib/channels/evolution/ligacoes.ts`):
 * sem o filtro, "Ligação perdida às 14:05" entraria no histórico como fala do ASSISTENTE.
 */
import { describe, expect, it } from "vitest";

import { loadHistoryWithBudget } from "./history";

type Linha = { id: string; body: string; direction: string; sent_at: string; type: string; organization_id: string; conversation_id: string };

/** Supabase em memória com os filtros que a consulta usa (eq, neq), ordem e limite. */
function supabaseCom(linhas: Linha[]) {
  const filtros: Array<(l: Linha) => boolean> = [];
  let limite = Infinity;
  const q = {
    select: () => q,
    eq: (c: keyof Linha, v: unknown) => (filtros.push((l) => l[c] === v), q),
    neq: (c: keyof Linha, v: unknown) => (filtros.push((l) => l[c] !== v), q),
    order: () => q,
    limit: (n: number) => ((limite = n), q),
    then: (ok: (v: unknown) => unknown) =>
      Promise.resolve(
        ok({
          data: linhas
            .filter((l) => filtros.every((f) => f(l)))
            .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
            .slice(0, limite),
          error: null,
        }),
      ),
  };
  return { from: () => q } as never;
}

const linha = (id: string, minuto: number, extra: Partial<Linha> = {}): Linha => ({
  id,
  body: `texto ${id}`,
  direction: "inbound",
  sent_at: `2026-11-13T17:${String(minuto).padStart(2, "0")}:00.000Z`,
  type: "text",
  organization_id: "org",
  conversation_id: "c1",
  ...extra,
});

describe("loadHistoryWithBudget", () => {
  it("nota de ligação (type=system, outbound) não vira fala do assistente", async () => {
    const h = await loadHistoryWithBudget(
      supabaseCom([
        linha("a", 1, { body: "oi, tudo bem?" }),
        linha("lig", 2, { type: "system", direction: "outbound", body: "Ligação perdida às 14:02" }),
        linha("b", 3, { direction: "outbound", body: "tudo, e você?" }),
      ]),
      { conversationId: "c1", organizationId: "org", messageWindow: 10, tokenWindow: 10_000 },
    );
    expect(h).toEqual([
      { role: "user", content: "oi, tudo bem?" },
      { role: "assistant", content: "tudo, e você?" },
    ]);
  });

  it("a nota não ocupa a janela de mensagens", async () => {
    const h = await loadHistoryWithBudget(
      supabaseCom([
        linha("a", 1),
        linha("lig1", 2, { type: "system", direction: "outbound" }),
        linha("lig2", 3, { type: "system", direction: "outbound" }),
      ]),
      { conversationId: "c1", organizationId: "org", messageWindow: 1, tokenWindow: 10_000 },
    );
    expect(h).toEqual([{ role: "user", content: "texto a" }]);
  });
});
