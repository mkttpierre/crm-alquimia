import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerHandler } from "@/lib/event-log/dispatcher";

import {
  MOTIVO_SEM_CONSUMIDOR,
  TIPOS_SEM_CONSUMIDOR,
  podarEventosSemConsumidor,
  reiniciarRelogioDaPodaParaTeste,
  tiposParaPodar,
} from "./poda-sem-consumidor";

function adminDeUpdate(linhas: Array<{ id: string }>) {
  const chamadas: { update?: unknown; eq?: unknown[]; in?: unknown[] } = {};
  const cadeia = {
    update: vi.fn((v: unknown) => ((chamadas.update = v), cadeia)),
    eq: vi.fn((...a: unknown[]) => ((chamadas.eq = a), cadeia)),
    in: vi.fn((...a: unknown[]) => ((chamadas.in = a), cadeia)),
    select: vi.fn(async () => ({ data: linhas, error: null })),
  };
  const admin = { from: vi.fn(() => cadeia) } as unknown as SupabaseClient;
  return { admin, cadeia, chamadas };
}

// Relógio de teste longe de zero: o relógio da poda começa em 0.
const BASE = 10 * 60 * 60_000;

beforeEach(() => reiniciarRelogioDaPodaParaTeste());

describe("podarEventosSemConsumidor", () => {
  it("encerra como done, com motivo, só os pending dos tipos da lista", async () => {
    const { admin, chamadas } = adminDeUpdate([{ id: "1" }, { id: "2" }]);

    expect(await podarEventosSemConsumidor(admin, BASE)).toBe(2);
    expect(chamadas.update).toEqual({ status: "done", last_error: MOTIVO_SEM_CONSUMIDOR });
    expect(chamadas.eq).toEqual(["status", "pending"]);
    expect(chamadas.in).toEqual(["event_type", [...TIPOS_SEM_CONSUMIDOR]]);
  });

  it("não repete dentro da hora", async () => {
    const { admin, cadeia } = adminDeUpdate([]);

    await podarEventosSemConsumidor(admin, BASE);
    await podarEventosSemConsumidor(admin, BASE + 59 * 60_000);
    expect(cadeia.update).toHaveBeenCalledTimes(1);

    await podarEventosSemConsumidor(admin, BASE + 61 * 60_000);
    expect(cadeia.update).toHaveBeenCalledTimes(2);
  });

  it("nunca lança: erro do banco vira 0", async () => {
    const admin = {
      from: () => {
        throw new Error("banco fora");
      },
    } as unknown as SupabaseClient;
    expect(await podarEventosSemConsumidor(admin, BASE)).toBe(0);
  });

  it("tipo que ganhou handler sai da poda sozinho", () => {
    expect(tiposParaPodar()).toContain("message.sent");
    registerHandler({
      key: "teste-poda-message-sent",
      events: ["message.sent"],
      handle: async () => ({ consumer_key: "teste-poda-message-sent", status: "ok" }),
    });
    expect(tiposParaPodar()).not.toContain("message.sent");
  });
});
