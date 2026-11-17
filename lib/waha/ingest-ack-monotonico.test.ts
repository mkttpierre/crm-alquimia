import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

/**
 * O STATUS DE ENTREGA NUNCA DESCE.
 *
 * Defeito medido em 05/11/2026 na organização B: a Evolution manda `SERVER_ACK` (1)
 * de novo DEPOIS do `DELIVERY_ACK` (2) — visto em 3 de 3 mensagens conferidas
 * (ex.: SERVER 13:25:02, DELIVERY 13:25:02, SERVER 13:26:33). O `handleAck` gravava
 * `ack`/`status` sem comparar com o que já estava no banco, então a mensagem
 * entregue voltava a "sent" (um tique), com `delivered_at` preenchido. No
 * conjunto da organização B, 70 de 158 mensagens enviadas apareciam na tela como
 * "não entregues" mesmo tendo chegado; numa organização, o mesmo padrão.
 *
 * O duplo de admin implementa só o que importa: o filtro `or("ack.is.null,ack.lt.N")`
 * e o `is("delivered_at", null)`. Entra pelo caminho de produção (`dispatchWahaEvent`).
 */

interface Linha {
  external_id: string;
  ack: number | null;
  status: string;
  delivered_at: string | null;
  read_at: string | null;
}

function bancoDeMentira(linhas: Linha[]) {
  const from = () => ({
    update(patch: Record<string, unknown>) {
      let candidatos: string[] = [];
      const condicoes: Array<(l: Linha) => boolean> = [];
      const q = {
        eq: () => q,
        in(_coluna: string, valores: string[]) {
          candidatos = valores;
          return q;
        },
        is(coluna: string, valor: null) {
          condicoes.push((l) => (l as unknown as Record<string, unknown>)[coluna] === valor);
          return q;
        },
        or(expr: string) {
          // Só a forma que o handler usa: "ack.is.null,ack.lt.<n>".
          const m = /^ack\.is\.null,ack\.lt\.(\d+)$/.exec(expr);
          if (!m) throw new Error(`filtro .or() fora do que o duplo entende: ${expr}`);
          const n = Number(m[1]);
          condicoes.push((l) => l.ack === null || l.ack < n);
          return q;
        },
        then(resolve: (v: { error: null }) => void) {
          for (const l of linhas) {
            if (candidatos.includes(l.external_id) && condicoes.every((c) => c(l))) Object.assign(l, patch);
          }
          resolve({ error: null });
        },
      };
      return q;
    },
  });
  return { from };
}

const SESSION = { id: "sessao-1", organization_id: "org-1", is_warmup_complete: true, warmup_started_at: null };

function ack(id: string, valor: number): WahaEnvelope {
  return { event: "message.ack", session: "celular-b", payload: { id, ack: valor } };
}

async function aplicar(linha: Linha, valores: number[]) {
  const admin = bancoDeMentira([linha]);
  for (const v of valores) await dispatchWahaEvent(admin as never, SESSION as never, ack(linha.external_id, v), "req-1");
}

const nova = (): Linha => ({ external_id: "3EB0AAA", ack: null, status: "sent", delivered_at: null, read_at: null });

describe("handleAck: o ack só sobe", () => {
  it("SERVER_ACK atrasado (1) não rebaixa uma mensagem já entregue (2)", async () => {
    const l = nova();
    await aplicar(l, [1, 2, 1]);
    expect(l.ack).toBe(2);
    expect(l.status).toBe("delivered");
    expect(l.delivered_at).not.toBeNull();
  });

  it("DELIVERY_ACK (2) atrasado não rebaixa uma mensagem já lida (3)", async () => {
    const l = nova();
    await aplicar(l, [1, 2, 3, 2, 1]);
    expect(l.ack).toBe(3);
    expect(l.status).toBe("read");
    expect(l.read_at).not.toBeNull();
  });

  it("a sequência normal 1 → 2 → 3 continua subindo", async () => {
    const l = nova();
    await aplicar(l, [1]);
    expect([l.ack, l.status]).toEqual([1, "sent"]);
    await aplicar(l, [2]);
    expect([l.ack, l.status]).toEqual([2, "delivered"]);
    await aplicar(l, [3]);
    expect([l.ack, l.status]).toEqual([3, "read"]);
  });

  it("o horário de entrega é o da primeira entrega, não o do recibo de leitura", async () => {
    const l = nova();
    await aplicar(l, [2]);
    const primeiraEntrega = l.delivered_at;
    await new Promise((r) => setTimeout(r, 5));
    await aplicar(l, [3]);
    expect(l.delivered_at).toBe(primeiraEntrega);
  });

  it("recibo de leitura sem o de entrega ainda preenche delivered_at", async () => {
    const l = nova();
    await aplicar(l, [3]);
    expect(l.delivered_at).not.toBeNull();
    expect(l.read_at).not.toBeNull();
  });
});
