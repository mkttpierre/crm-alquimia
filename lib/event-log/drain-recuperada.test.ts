/**
 * O dreno reconhece o `message.received` de mensagem RECUPERADA (marca em
 * `messages.metadata.recuperada`) e o entrega ao despacho com `metadata.mensagem_recuperada`,
 * para que só os consumidores que não enviam rodem. A consulta é UMA por lote, só quando há
 * `message.received` no lote. Se ela falhar, esses eventos ficam para o próximo tick (nem
 * reclamados nem despachados): despachar sem saber poderia responder a uma mensagem velha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/event-log/poda-sem-consumidor", () => ({ podarEventosSemConsumidor: async () => undefined }));

const dispatch = vi.fn();
vi.mock("@/lib/event-log/dispatcher", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getRegisteredHandlers: () => [{ key: "k", events: ["message.received", "lead.created"] }],
  dispatchEvent: (row: unknown) => dispatch(row),
}));

import { drainEventLog } from "@/lib/event-log/drain";

type Resposta = { data: unknown; error: unknown };

function dublar(eventos: unknown[], mensagens: Resposta) {
  const consultasDeMensagens: Array<{ coluna: string; valores: unknown }> = [];
  const claims: string[] = [];
  const from = (tabela: string) => {
    let op = "select";
    let claimId: string | null = null;
    const q: Record<string, unknown> = {};
    q.update = (p: Record<string, unknown>) => {
      op = p.status === "processing" ? "claim" : "update";
      return q;
    };
    q.select = () => q;
    q.eq = (c: string, v: unknown) => {
      if (op === "claim" && c === "id") claimId = String(v);
      return q;
    };
    q.lt = () => q;
    q.or = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.in = (c: string, v: unknown) => {
      if (tabela === "messages") consultasDeMensagens.push({ coluna: c, valores: v });
      return q;
    };
    q.then = (resolve: (r: Resposta) => void) => {
      if (tabela === "messages") return resolve(mensagens);
      if (op === "claim") {
        claims.push(claimId!);
        return resolve({ data: [{ id: claimId }], error: null });
      }
      if (op === "update") return resolve({ data: [], error: null });
      return resolve({ data: eventos, error: null });
    };
    return q;
  };
  return { admin: { from } as never, consultasDeMensagens, claims };
}

const ev = (id: string, tipo: string, messageId: string | null) => ({
  id,
  organization_id: "org-1",
  event_type: tipo,
  entity_kind: "message",
  entity_id: messageId,
  payload: messageId ? { message_id: messageId } : {},
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date().toISOString(),
});

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockResolvedValue([{ consumer_key: "k", status: "ok" }]);
});

describe("dreno × mensagem recuperada", () => {
  it("marca só o evento cuja mensagem foi recuperada (da mesma organização)", async () => {
    const { admin, consultasDeMensagens } = dublar(
      [ev("e1", "message.received", "m-rec"), ev("e2", "message.received", "m-viva"), ev("e3", "lead.created", null)],
      {
        data: [
          { id: "m-rec", organization_id: "org-1", metadata: { recuperada: true } },
          { id: "m-viva", organization_id: "org-1", metadata: { raw_type: "chat" } },
        ],
        error: null,
      },
    );
    await drainEventLog(admin);

    expect(consultasDeMensagens).toEqual([{ coluna: "id", valores: ["m-rec", "m-viva"] }]);
    const porId = new Map(dispatch.mock.calls.map((c) => [(c[0] as { id: string }).id, c[0] as { metadata: Record<string, unknown> }]));
    expect(porId.get("e1")!.metadata.mensagem_recuperada).toBe(true);
    expect(porId.get("e2")!.metadata.mensagem_recuperada).toBeUndefined();
    expect(porId.get("e3")!.metadata.mensagem_recuperada).toBeUndefined();
  });

  it("marca de OUTRA organização não vale (o id casa, o tenant não)", async () => {
    const { admin } = dublar([ev("e1", "message.received", "m-1")], {
      data: [{ id: "m-1", organization_id: "org-2", metadata: { recuperada: true } }],
      error: null,
    });
    await drainEventLog(admin);
    expect((dispatch.mock.calls[0]![0] as { metadata: Record<string, unknown> }).metadata.mensagem_recuperada).toBeUndefined();
  });

  it("lote sem message.received não consulta messages", async () => {
    const { admin, consultasDeMensagens } = dublar([ev("e3", "lead.created", null)], { data: [], error: null });
    await drainEventLog(admin);
    expect(consultasDeMensagens).toEqual([]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("consulta falhou: message.received fica para o próximo tick; o resto do lote segue", async () => {
    const { admin, claims } = dublar([ev("e1", "message.received", "m-1"), ev("e3", "lead.created", null)], {
      data: null,
      error: { message: "boom" },
    });
    await drainEventLog(admin);
    expect(claims).toEqual(["e3"]);
    expect(dispatch.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["e3"]);
  });
});
