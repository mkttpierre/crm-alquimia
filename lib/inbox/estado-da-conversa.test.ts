import { describe, expect, it } from "vitest";
import { estadoDaConversa } from "./estado-da-conversa";

const base = { status: "open", assigned_to_user_id: null, last_outbound_at: null, last_inbound_at: null };
describe("estado da conversa (org sem automático no ar)", () => {
  it.each([
    [{ ...base, status: "closed", last_outbound_at: "2026-01-02" }, "finalizados"],
    [{ ...base, status: "archived" }, "finalizados"],
    [base, "nao_iniciados"],
    [{ ...base, assigned_to_user_id: "u", last_outbound_at: "2026-01-02", last_inbound_at: "2026-01-01" }, "em_espera"],
    [{ ...base, last_outbound_at: "2026-01-02" }, "em_espera"],
    [{ ...base, last_outbound_at: "2026-01-01", last_inbound_at: "2026-01-02" }, "em_atendimento"],
    [{ ...base, assigned_to_user_id: "u" }, "em_atendimento"],
    [{ ...base, assigned_to_user_id: "u", last_outbound_at: "2026-01-01", last_inbound_at: "2026-01-01" }, "em_atendimento"],
  ])("classifica segundo a prioridade: %#", (conversa, esperado) => {
    expect(estadoDaConversa(conversa, false)).toBe(esperado);
  });
});

describe("Bot pergunta quem manda, não o status", () => {
  it("sem dono e com automático no ar = Bot", () => {
    expect(estadoDaConversa(base, true)).toBe("bot");
  });
  it("status ai_handling com dono humano NÃO é Bot", () => {
    expect(estadoDaConversa({ ...base, status: "ai_handling", assigned_to_user_id: "u" }, true)).toBe("em_atendimento");
  });
  it("automático calado (silêncio vigente) não é Bot", () => {
    expect(estadoDaConversa({ ...base, bot_silenced_until: "infinity" }, true)).toBe("nao_iniciados");
  });
  it("contato com force_human não é Bot", () => {
    expect(estadoDaConversa({ ...base, contacts: { force_human: true } }, true)).toBe("nao_iniciados");
  });
});
