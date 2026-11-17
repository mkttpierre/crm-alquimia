/**
 * Follow-up × mensagem RECUPERADA (chegou horas ou dias depois, pela reconciliação de entrada).
 *
 * Valem só os efeitos que PARAM envio: contato bloqueado cancela tudo; `cancel_on_reply` cancela.
 * O que faz o fluxo andar (acordar `waiting_reply`/`wait`, aplicar o texto no `match_reply`) não
 * roda: o próximo nó pode mandar texto, e responder sozinho a uma mensagem velha é o defeito.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const aplicarTexto = vi.fn(async () => undefined);
vi.mock("@/lib/followup/aplicar-inbound", () => ({
  aplicarTextoNosFollowups: (...a: unknown[]) => aplicarTexto(...(a as [])),
  textoDoPayloadInbound: () => "sim",
}));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { applyReactivityEvent, type LiveEnrollmentRef, type ReactivityAdminClient } from "./reactivity";

function dbEmMemoria(opts: { bloqueado: boolean; vivos: LiveEnrollmentRef[] }) {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const db: ReactivityAdminClient = {
    loadConversationContactId: async () => null,
    loadContactBlocked: async () => opts.bloqueado,
    loadLiveEnrollmentsForContact: async () => opts.vivos,
    insertEnrollmentEvent: async () => ({ inserted: true }),
    updateEnrollment: async (id, _org, patch) => {
      patches.push({ id, patch: patch as Record<string, unknown> });
    },
    agoraNoBanco: async () => "2026-11-10T12:00:00.000Z",
  };
  return { db, patches };
}

const vivo = (id: string, status: LiveEnrollmentRef["status"], cancelOnReply = false): LiveEnrollmentRef => ({
  id,
  status,
  current_node_id: "n1",
  steps_taken: 1,
  pointer_id: "p1",
  handoff_policy: "pause",
  trigger_config: cancelOnReply ? { kind: "manual", cancel_on_reply: true } : { kind: "manual" },
});

const evento = (recuperada: boolean): EventRow => ({
  id: "ev-1",
  organization_id: "org-1",
  event_type: "message.received",
  entity_kind: "message",
  entity_id: "m-1",
  payload: { contact_id: "c-1", message_id: "m-1" },
  metadata: recuperada ? { mensagem_recuperada: true } : {},
  consumed_by: [],
  attempts: 0,
});

const relogio = () => new Date("2026-11-10T12:00:00.000Z");

describe("reatividade do follow-up com mensagem recuperada", () => {
  it("controle: mensagem viva ACORDA quem espera resposta", async () => {
    const { db, patches } = dbEmMemoria({ bloqueado: false, vivos: [vivo("e1", "waiting_reply"), vivo("e2", "active")] });
    await applyReactivityEvent(db, relogio, evento(false));
    expect(patches.map((p) => p.id).sort()).toEqual(["e1", "e2"]);
    expect(patches.every((p) => "next_eval_at" in p.patch && p.patch.status === undefined)).toBe(true);
  });

  it("recuperada NÃO acorda ninguém (o próximo nó poderia enviar)", async () => {
    const { db, patches } = dbEmMemoria({ bloqueado: false, vivos: [vivo("e1", "waiting_reply"), vivo("e2", "active")] });
    const r = await applyReactivityEvent(db, relogio, evento(true));
    expect(patches).toEqual([]);
    expect(r.reacted).toBe(0);
  });

  it("recuperada ainda CANCELA por cancel_on_reply (efeito que para envio)", async () => {
    const { db, patches } = dbEmMemoria({ bloqueado: false, vivos: [vivo("e1", "waiting_reply", true)] });
    await applyReactivityEvent(db, relogio, evento(true));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.patch).toMatchObject({ status: "cancelled", outcome: "replied" });
  });

  it("recuperada de contato bloqueado cancela tudo (opt-out)", async () => {
    const { db, patches } = dbEmMemoria({ bloqueado: true, vivos: [vivo("e1", "waiting_reply"), vivo("e2", "active")] });
    await applyReactivityEvent(db, relogio, evento(true));
    expect(patches.map((p) => p.patch.outcome)).toEqual(["opted_out", "opted_out"]);
  });

  it("o adapter não aplica o texto da recuperada nos follow-ups, e aceita o evento recuperado", async () => {
    const { followupReactivityHandler } = await import("./reactivity.handler");
    expect(followupReactivityHandler.aceitaMensagemRecuperada).toBe(true);
    aplicarTexto.mockClear();
    // O adapter cria o client real; aqui só importa que o texto não é aplicado.
    await followupReactivityHandler.handle(evento(true)).catch(() => undefined);
    expect(aplicarTexto).not.toHaveBeenCalled();
  });
});
