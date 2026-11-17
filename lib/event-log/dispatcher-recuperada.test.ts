/**
 * Mensagem RECUPERADA pela reconciliação de entrada (chegou horas ou dias depois, sem webhook) não
 * pode fazer o sistema enviar nada sozinho. O `message.received` dela nasce do mesmo gatilho do
 * banco que qualquer entrada; o dreno a reconhece pela marca da linha em `messages` e põe
 * `metadata.mensagem_recuperada` no evento (só em memória). O despacho, então, só entrega o evento
 * a quem declarou `aceitaMensagemRecuperada` — falha FECHADA: consumidor novo nasce de fora.
 */
import { describe, expect, it, vi } from "vitest";

import { dispatchEvent, registerHandler, type EventRow } from "./dispatcher";

function linha(extra: Partial<EventRow> = {}): EventRow {
  return {
    id: `ev-${Math.random()}`,
    organization_id: "org-1",
    event_type: "teste.recuperada",
    entity_kind: "message",
    entity_id: "m-1",
    payload: { message_id: "m-1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...extra,
  };
}

const queEnvia = vi.fn(async () => ({ consumer_key: "teste-que-envia", status: "ok" as const }));
const queSoAvisa = vi.fn(async () => ({ consumer_key: "teste-que-so-avisa", status: "ok" as const }));
registerHandler({ key: "teste-que-envia", events: ["teste.recuperada"], handle: queEnvia });
registerHandler({ key: "teste-que-so-avisa", events: ["teste.recuperada"], aceitaMensagemRecuperada: true, handle: queSoAvisa });

describe("despacho de evento de mensagem recuperada", () => {
  it("evento comum vai a todos os consumidores", async () => {
    queEnvia.mockClear();
    queSoAvisa.mockClear();
    await dispatchEvent(linha());
    expect(queEnvia).toHaveBeenCalledTimes(1);
    expect(queSoAvisa).toHaveBeenCalledTimes(1);
  });

  it("recuperada: só quem aceita roda; o outro é PULADO com motivo (e conta como consumido)", async () => {
    queEnvia.mockClear();
    queSoAvisa.mockClear();
    const r = await dispatchEvent(linha({ metadata: { mensagem_recuperada: true } }));
    expect(queEnvia).not.toHaveBeenCalled();
    expect(queSoAvisa).toHaveBeenCalledTimes(1);
    const pulado = r.find((x) => x.consumer_key === "teste-que-envia");
    expect(pulado?.status).toBe("skipped");
    expect(pulado?.detail).toMatch(/recuperada/);
  });
});
