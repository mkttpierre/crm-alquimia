/**
 * O que o webhook da Evolution passa a entregar ao freio de saúde: o ack de cada envio e a conexão da
 * sessão — e a prova de que o resto do webhook continua igual (os envelopes não mudam).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { traduzirEvento, type EvolutionEnvelope } from "@/lib/channels/evolution/webhook";

import { acksDoLote, registrarConexoes, registrarEntregas } from "./saude-eventos";

const ORG = "00000000-0000-4000-8000-0000000000f1";
const AGORA = new Date("2026-10-16T15:00:00Z");

/** Cliente falso que grava cada cadeia de chamadas e devolve o que o teste mandar. */
function dbFalso(resposta: { data?: unknown; error?: { message: string } | null } = {}) {
  const chamadas: { tabela: string; passos: [string, unknown[]][] }[] = [];
  const db = {
    from(tabela: string) {
      const passos: [string, unknown[]][] = [];
      chamadas.push({ tabela, passos });
      const cadeia: Record<string, unknown> = {};
      const proxy = new Proxy(cadeia, {
        get(_a, nome: string) {
          if (nome === "then") return (ok: (v: unknown) => unknown) => ok({ data: resposta.data ?? [{ id: "x" }], error: resposta.error ?? null });
          return (...args: unknown[]) => (passos.push([nome, args]), proxy);
        },
      });
      return proxy;
    },
  };
  return { db: db as unknown as SupabaseClient, chamadas };
}

const evento = (event: string, data: unknown): EvolutionEnvelope => ({ event, instance: "chip-a", data });

describe("status de entrega (messages.update) -> ack do envio", () => {
  const envelope = (id: string, ack: number) => ({ event: "message.ack", payload: { id, ack } });

  it("a Evolution manda DELIVERY_ACK: vira envelope message.ack com ack 2 (o que já funcionava)", () => {
    const t = traduzirEvento(evento("messages.update", [{ keyId: "3EB0AAA", fromMe: true, status: "DELIVERY_ACK" }]));
    expect(t.envelopes).toEqual([{ event: "message.ack", session: "chip-a", payload: { id: "3EB0AAA", ack: 2 } }]);
  });

  it("acksDoLote guarda o maior ack de cada mensagem e ignora o que não é ack", () => {
    const m = acksDoLote([envelope("a", 1), envelope("a", 3), envelope("a", 2), envelope("b", 1), { event: "message", payload: { id: "c", ack: 3 } }, { event: "message.ack", payload: { id: "d" } }]);
    expect([...m.entries()]).toEqual([["a", 3], ["b", 1]]);
  });

  it("registrarEntregas: atualiza só envios da organização, por external_id, e só se o ack subir", async () => {
    const { db, chamadas } = dbFalso();
    const n = await registrarEntregas(db, ORG, [envelope("3EB0AAA", 2)], AGORA);
    expect(n).toBe(1);
    const c = chamadas[0]!;
    expect(c.tabela).toBe("disparo_envios");
    const passos = Object.fromEntries(c.passos.map(([k, v]) => [k, v]));
    expect(passos.update![0]).toMatchObject({ ack: 2, ack_em: AGORA.toISOString(), entregue_em: AGORA.toISOString() });
    expect(passos.update![0]).not.toHaveProperty("lido_em");
    expect(c.passos.filter(([k]) => k === "eq").map(([, v]) => v)).toEqual([["organization_id", ORG], ["external_id", "3EB0AAA"]]);
    expect(passos.or![0]).toBe("ack.is.null,ack.lt.2");
  });

  it("ack 3 (lido) grava também a hora da leitura; ack 1 (um tique) não grava entrega", async () => {
    const lido = dbFalso();
    await registrarEntregas(lido.db, ORG, [envelope("a", 3)], AGORA);
    expect(lido.chamadas[0]!.passos.find(([k]) => k === "update")![1][0]).toMatchObject({ entregue_em: AGORA.toISOString(), lido_em: AGORA.toISOString() });
    const um = dbFalso();
    await registrarEntregas(um.db, ORG, [envelope("a", 1)], AGORA);
    expect(um.chamadas[0]!.passos.find(([k]) => k === "update")![1][0]).not.toHaveProperty("entregue_em");
  });

  it("erro do banco nunca lança (o webhook segue e responde 200)", async () => {
    const { db } = dbFalso({ error: { message: "boom" } });
    await expect(registrarEntregas(db, ORG, [envelope("a", 2)], AGORA)).resolves.toBe(0);
  });

  it("lote sem ack não toca no banco", async () => {
    const { db, chamadas } = dbFalso();
    await registrarEntregas(db, ORG, [{ event: "message", payload: { id: "a" } }], AGORA);
    expect(chamadas).toHaveLength(0);
  });
});

describe("connection.update / logout.instance -> eventos de conexão", () => {
  it("close com statusReason 428 vira conexão {close, 428} e o envelope session.status continua igual", () => {
    const t = traduzirEvento(evento("connection.update", { instance: "chip-a", state: "close", statusReason: 428 }));
    expect(t.conexoes).toEqual([{ estado: "close", codigo: 428 }]);
    expect(t.envelopes).toEqual([{ event: "session.status", session: "chip-a", payload: { status: "STOPPED" } }]);
    expect(t.ignorado).toBe(false);
  });
  it("statusReason numérico em texto também lê; sem statusReason o código é null", () => {
    expect(traduzirEvento(evento("CONNECTION_UPDATE", { state: "close", statusReason: "401" })).conexoes).toEqual([{ estado: "close", codigo: 401 }]);
    expect(traduzirEvento(evento("connection.update", { state: "connecting" })).conexoes).toEqual([{ estado: "connecting", codigo: null }]);
    expect(traduzirEvento(evento("connection.update", { state: "open" })).conexoes).toEqual([{ estado: "open", codigo: null }]);
  });
  it("logout.instance não vira envelope (como antes), mas conta como queda", () => {
    const t = traduzirEvento(evento("logout.instance", {}));
    expect(t.conexoes).toEqual([{ estado: "logout", codigo: null }]);
    expect(t.envelopes).toEqual([]);
    expect(t.ignorado).toBe(true);
  });
  it("mensagem comum não gera evento de conexão", () => {
    expect(traduzirEvento(evento("messages.upsert", [])).conexoes).toEqual([]);
  });

  it("registrarConexoes grava um evento por estado, na sessão e organização do token", async () => {
    const { db, chamadas } = dbFalso();
    const n = await registrarConexoes(db, ORG, "sessao-1", [{ estado: "close", codigo: 428 }], AGORA);
    expect(n).toBe(1);
    expect(chamadas[0]!.tabela).toBe("disparo_eventos_conexao");
    expect(chamadas[0]!.passos[0]).toEqual(["insert", [[{ organization_id: ORG, channel_session_id: "sessao-1", estado: "close", codigo: 428, ocorrido_em: AGORA.toISOString() }]]]);
  });
  it("sem eventos não toca no banco; erro do banco não lança", async () => {
    const a = dbFalso();
    expect(await registrarConexoes(a.db, ORG, "s", [], AGORA)).toBe(0);
    expect(a.chamadas).toHaveLength(0);
    const b = dbFalso({ error: { message: "boom" } });
    await expect(registrarConexoes(b.db, ORG, "s", [{ estado: "close", codigo: null }], AGORA)).resolves.toBe(0);
  });
});
