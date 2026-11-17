import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

/**
 * Itens 8 e 9 da auditoria de entrada (05/11/2026), na ingestão compartilhada.
 *
 * 8) `messages.update` com status ERROR: a mensagem enviada vira `failed` visível,
 *    sem rebaixar quem já foi entregue/lido.
 * 9) O ACK da Evolution pode chegar ANTES do espelho da mensagem enviada (o motor
 *    chama o canal e só depois grava a linha). O ACK pendente é guardado e aplicado
 *    quando a linha aparecer.
 */

interface Linha {
  external_id: string;
  ack: number | null;
  status: string;
  delivered_at: string | null;
  read_at: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

function bancoDeMentira(linhas: Linha[]) {
  return {
    from: () => ({
      update(patch: Record<string, unknown>, opts?: { count?: string }) {
        let candidatos: string[] = [];
        const condicoes: Array<(l: Linha) => boolean> = [];
        const q = {
          eq: () => q,
          in(_c: string, v: string[]) {
            candidatos = v;
            return q;
          },
          is(coluna: string, valor: null) {
            condicoes.push((l) => (l as unknown as Record<string, unknown>)[coluna] === valor);
            return q;
          },
          or(expr: string) {
            const m = /^ack\.is\.null,ack\.lt\.(\d+)$/.exec(expr);
            if (!m) throw new Error(`filtro .or() fora do que o duplo entende: ${expr}`);
            const n = Number(m[1]);
            condicoes.push((l) => l.ack === null || l.ack < n);
            return q;
          },
          then(resolve: (v: { error: null; count?: number }) => void) {
            let n = 0;
            for (const l of linhas) {
              if (candidatos.includes(l.external_id) && condicoes.every((c) => c(l))) {
                Object.assign(l, patch);
                n++;
              }
            }
            resolve({ error: null, ...(opts?.count ? { count: n } : {}) });
          },
        };
        return q;
      },
      select() {
        let candidatos: string[] = [];
        const q = {
          eq: () => q,
          in(_c: string, v: string[]) {
            candidatos = v;
            return q;
          },
          limit: () => q,
          maybeSingle: async () => ({
            data: (() => { const l = linhas.find((x) => candidatos.includes(x.external_id)); return l ? { id: "x", ack: l.ack } : null; })(),
            error: null,
          }),
        };
        return q;
      },
    }),
  };
}

const SESSION = { id: "sessao-1", organization_id: "org-1", is_warmup_complete: true, warmup_started_at: null };
const nova = (id = "3EB0AAA", over: Partial<Linha> = {}): Linha => ({
  external_id: id,
  ack: null,
  status: "sent",
  delivered_at: null,
  read_at: null,
  ...over,
});
const ackEv = (id: string, ack: number): WahaEnvelope => ({ event: "message.ack", session: "celular-b", payload: { id, ack } });
const falhaEv = (id: string): WahaEnvelope => ({ event: "message.failed", session: "celular-b", payload: { id } });
const despachar = (admin: unknown, e: WahaEnvelope) => dispatchWahaEvent(admin as never, SESSION as never, e, "req-1");

describe("item 8 — message.failed", () => {
  it("mensagem enviada (sem ack ou só 1 tique) vira failed com motivo visível", async () => {
    for (const ack of [null, 1]) {
      const l = nova("F1", { ack });
      await despachar(bancoDeMentira([l]), falhaEv("F1"));
      expect(l.status, `ack ${ack}`).toBe("failed");
      expect(l.error_code).toBeTruthy();
    }
  });

  it("NÃO rebaixa quem já foi entregue ou lido", async () => {
    const entregue = nova("E1", { ack: 2, status: "delivered" });
    const lida = nova("L1", { ack: 3, status: "read" });
    await despachar(bancoDeMentira([entregue]), falhaEv("E1"));
    await despachar(bancoDeMentira([lida]), falhaEv("L1"));
    expect(entregue.status).toBe("delivered");
    expect(lida.status).toBe("read");
  });

  it("um ack real posterior desfaz o failed (a entrega venceu o erro)", async () => {
    const l = nova("R1");
    const db = bancoDeMentira([l]);
    await despachar(db, falhaEv("R1"));
    await despachar(db, ackEv("R1", 2));
    expect(l.status).toBe("delivered");
  });
});

describe("item 9 — ACK antes do espelho", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ACK sem linha é guardado e aplicado quando o espelho nasce", async () => {
    const linhas: Linha[] = [];
    const db = bancoDeMentira(linhas);
    await despachar(db, ackEv("3EB0NEW", 2)); // chega primeiro: nada a atualizar
    linhas.push(nova("3EB0NEW")); // o motor grava o espelho depois
    await vi.advanceTimersByTimeAsync(2_000);
    expect(linhas[0]!.ack).toBe(2);
    expect(linhas[0]!.status).toBe("delivered");
    expect(linhas[0]!.delivered_at).not.toBeNull();
  });

  it("vários ACKs antes do espelho: vale o MAIOR", async () => {
    const linhas: Linha[] = [];
    const db = bancoDeMentira(linhas);
    await despachar(db, ackEv("3EB0MAX", 3));
    await despachar(db, ackEv("3EB0MAX", 1));
    linhas.push(nova("3EB0MAX"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(linhas[0]!.ack).toBe(3);
    expect(linhas[0]!.status).toBe("read");
  });

  it("espelho que nasce tarde (até ~30s) ainda recebe o ACK", async () => {
    const linhas: Linha[] = [];
    const db = bancoDeMentira(linhas);
    await despachar(db, ackEv("3EB0LATE", 2));
    await vi.advanceTimersByTimeAsync(8_000);
    linhas.push(nova("3EB0LATE"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(linhas[0]!.ack).toBe(2);
  });

  it("ACK atrasado de linha que JÁ existe (monotônico) não agenda nada", async () => {
    const l = nova("3EB0OLD", { ack: 3, status: "read" });
    await despachar(bancoDeMentira([l]), ackEv("3EB0OLD", 1));
    expect(vi.getTimerCount()).toBe(0);
    expect(l.ack).toBe(3);
  });

  it("linha que nunca aparece: as tentativas acabam (sem timer eterno)", async () => {
    await despachar(bancoDeMentira([]), ackEv("3EB0NUNCA", 2));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("itens 3 e 4 da revisão — corrida e erro de escrita no ACK", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("espelho que nasce ENTRE o UPDATE e o SELECT não perde o ACK", async () => {
    const linhas: Linha[] = [];
    const base = bancoDeMentira(linhas);
    let primeiro = true;
    const db = {
      from: () => {
        const t = base.from();
        return {
          select: t.select,
          update(patch: Record<string, unknown>, opts?: { count?: string }) {
            if (!primeiro) return t.update(patch, opts);
            primeiro = false;
            // o UPDATE roda quando a linha ainda não existe; ela nasce logo depois, antes do SELECT
            const q: Record<string, unknown> = {};
            for (const m of ["eq", "in", "is", "or"]) q[m] = () => q;
            q.then = (r: (v: unknown) => void) => { r({ error: null, count: 0 }); linhas.push(nova("3EB0RACE")); };
            return q;
          },
        };
      },
    };
    await despachar(db, ackEv("3EB0RACE", 2));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(linhas[0]!.ack).toBe(2);
    expect(linhas[0]!.status).toBe("delivered");
  });

  it("erro de escrita no UPDATE do ACK não o perde: a tentativa pendente reaplica", async () => {
    const linhas = [nova("3EB0ERR")];
    const base = bancoDeMentira(linhas);
    let falhas = 1;
    const db = {
      from: () => {
        const t = base.from();
        return {
          select: t.select,
          update(patch: Record<string, unknown>, opts?: { count?: string }) {
            if (opts?.count && falhas > 0) {
              falhas--;
              const q: Record<string, unknown> = {};
              for (const m of ["eq", "in", "is", "or"]) q[m] = () => q;
              q.then = (r: (v: unknown) => void) => r({ error: { message: "db down" }, count: null });
              return q;
            }
            return t.update(patch, opts);
          },
        };
      },
    };
    await despachar(db, ackEv("3EB0ERR", 2));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(linhas[0]!.ack).toBe(2);
  });

  it("message.failed com erro de escrita propaga (para a reentrega), em vez de calar", async () => {
    const db = {
      from: () => ({
        update: () => {
          const q: Record<string, unknown> = {};
          for (const m of ["eq", "in", "is", "or"]) q[m] = () => q;
          q.then = (r: (v: unknown) => void) => r({ error: { message: "db down" } });
          return q;
        },
      }),
    };
    await expect(despachar(db, falhaEv("3EB0F"))).rejects.toThrow();
  });
});
