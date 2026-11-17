/**
 * Cerca: quem consome `message.received` de mensagem RECUPERADA. Só dois, e nenhum envia ao
 * contato: o aviso ao operador (web push) e a reatividade do follow-up (que, para recuperada,
 * só cancela). IA, sentimento (que pode escalar e responder) e automação do usuário ficam de fora.
 * Consumidor novo de `message.received` nasce de fora (falha fechada); entrar nesta lista é
 * decisão escrita aqui.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));

import { getRegisteredHandlers } from "./dispatcher";
import { ensureHandlersRegistered } from "./register-handlers";

describe("consumidores de message.received que rodam para mensagem recuperada", () => {
  it("são exatamente o push ao operador e a reatividade do follow-up", () => {
    ensureHandlersRegistered();
    const deEntrada = getRegisteredHandlers().filter((h) => h.events.includes("message.received"));
    // Guarda de vacuidade: o registro enxerga os consumidores de entrada.
    expect(deEntrada.length).toBeGreaterThanOrEqual(4);
    const aceitam = deEntrada.filter((h) => h.aceitaMensagemRecuperada).map((h) => h.key).sort();
    expect(aceitam).toEqual(["followup-reactivity.v1", "web-push-inbound.v1"]);
  });
});
