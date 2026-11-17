import { describe, expect, it, vi } from "vitest";

import { traduzirEvento, type EvolutionEnvelope } from "@/lib/channels/evolution/webhook";

/**
 * Itens 5, 6, 7 e 8 da auditoria de entrada (05/11/2026), na tradução do fio.
 */

const upsert = (data: unknown) => ({ event: "messages.upsert", instance: "chip-01", data }) as EvolutionEnvelope;
const upd = (data: unknown) => ({ event: "messages.update", instance: "chip-01", data }) as EvolutionEnvelope;

const msg = (message: unknown, key: Record<string, unknown> = {}) => ({
  key: { remoteJid: "5581999990000@s.whatsapp.net", fromMe: false, id: "3EB0AAA", ...key },
  pushName: "Maria",
  messageType: "locationMessage",
  messageTimestamp: 1_760_000_000,
  message,
});

describe("item 5 — locationMessage vira texto, não mensagem vazia", () => {
  it("coordenadas + nome + endereço", () => {
    const t = traduzirEvento(
      upsert(
        msg({
          locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63, name: "Loja", address: "Rua A, 10" },
        }),
      ),
    );
    const body = t.envelopes[0]!.payload?.body ?? "";
    expect(body).toContain("[Localização]");
    expect(body).toContain("Loja");
    expect(body).toContain("Rua A, 10");
    expect(body).toContain("-23.55");
    expect(body).toContain("-46.63");
  });

  it("só coordenadas ainda gera texto", () => {
    const t = traduzirEvento(upsert(msg({ locationMessage: { degreesLatitude: 1.5, degreesLongitude: 2.5 } })));
    expect(t.envelopes[0]!.payload?.body).toMatch(/^\[Localização\].*1\.5.*2\.5/);
  });

  it("sem nenhum dado, ainda é '[Localização]' (a mensagem não some)", () => {
    const t = traduzirEvento(upsert(msg({ locationMessage: {} })));
    expect(t.envelopes[0]!.payload?.body).toBe("[Localização]");
  });

  it("localização ao vivo também", () => {
    const t = traduzirEvento(upsert(msg({ liveLocationMessage: { degreesLatitude: 3, degreesLongitude: 4 } })));
    expect(t.envelopes[0]!.payload?.body).toContain("[Localização]");
  });

  it("texto comum não é afetado", () => {
    const t = traduzirEvento(upsert(msg({ conversation: "oi" })));
    expect(t.envelopes[0]!.payload?.body).toBe("oi");
  });
});

describe("item 6 — itens sem key.id são CONTADOS", () => {
  it("semId conta o item que passou no schema e foi filtrado por falta de id", () => {
    const t = traduzirEvento(upsert([msg({ conversation: "a" }, { id: undefined }), msg({ conversation: "b" }, { id: "OK" })]));
    expect(t.envelopes).toHaveLength(1);
    expect(t.semId).toBe(1);
    expect(t.descartados).toBe(0);
  });

  it("status@broadcast NÃO conta como sem id (descarte legítimo)", () => {
    const t = traduzirEvento(upsert(msg({ conversation: "a" }, { remoteJid: "status@broadcast" })));
    expect(t.semId).toBe(0);
  });
});

describe("item 7 — ack de grupo em lote misto é filtrado", () => {
  it("remoteJid @g.us no item não gera message.ack", () => {
    const t = traduzirEvento(
      upd([
        { keyId: "GRUPO1", remoteJid: "120363@g.us", fromMe: true, status: "DELIVERY_ACK" },
        { keyId: "PRIV1", remoteJid: "5581999990000@s.whatsapp.net", fromMe: true, status: "DELIVERY_ACK" },
      ]),
    );
    expect(t.envelopes.map((e) => e.payload?.id)).toEqual(["PRIV1"]);
  });

  it("jid de grupo dentro de key também", () => {
    const t = traduzirEvento(upd([{ keyId: "G", key: { remoteJid: "120363@g.us" }, fromMe: true, status: "READ" }]));
    expect(t.envelopes).toEqual([]);
  });

  it("ERROR de grupo também não vira falha", () => {
    const t = traduzirEvento(upd([{ keyId: "G", remoteJid: "120363@g.us", fromMe: true, status: "ERROR" }]));
    expect(t.envelopes).toEqual([]);
    expect(t.falhas).toEqual([]);
  });
});

describe("item 8 — status ERROR vira falha, sem tocar nos acks", () => {
  it("ERROR gera message.failed em `falhas`", () => {
    const t = traduzirEvento(upd({ keyId: "3EB0X", remoteJid: "5581999990000@s.whatsapp.net", fromMe: true, status: "ERROR" }));
    expect(t.falhas).toEqual([{ event: "message.failed", session: "chip-01", payload: { id: "3EB0X" } }]);
    // não vira ack: nenhum número inventado que rebaixe mensagem entregue
    expect(t.envelopes).toEqual([]);
  });

  it("ERROR de mensagem que não é nossa (fromMe:false) é ignorado", () => {
    expect(traduzirEvento(upd({ keyId: "x", fromMe: false, status: "ERROR" })).falhas).toEqual([]);
  });

  it("status normal não gera falha", () => {
    expect(traduzirEvento(upd({ keyId: "x", fromMe: true, status: "READ" })).falhas).toEqual([]);
  });
});

// ─── item 6/8: a ingestão despacha as falhas e devolve as contagens ─────────────
const dispatchMock = vi.fn(async () => undefined);
vi.mock("@/lib/waha/ingest", () => ({ dispatchWahaEvent: (...a: unknown[]) => dispatchMock(...(a as [])) }));

import { ingestEvolutionInbound } from "@/lib/channels/evolution/ingest";

function adminCom(linha: Record<string, unknown>) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => ({ data: linha, error: null });
  return { from: () => q } as never;
}
const SESSAO_DB = { id: "s-1", organization_id: "org-1", evolution_instance_name: "chip-01", is_warmup_complete: false, warmup_started_at: null };

describe("ingestEvolutionInbound — contagens e falhas", () => {
  it("devolve sem_id quando houve item sem key.id (e só então)", async () => {
    dispatchMock.mockClear();
    const r = await ingestEvolutionInbound(adminCom(SESSAO_DB), {
      session: { id: "s-1", organization_id: "org-1" },
      rawBody: JSON.stringify({ event: "messages.upsert", instance: "chip-01", data: [msg({ conversation: "a" }, { id: undefined })] }),
    });
    expect(r).toMatchObject({ ok: true, body: { status: "processed", eventos: 0, descartados: 0, sem_id: 1 } });
  });

  it("sem item problemático o corpo continua exatamente como antes", async () => {
    const r = await ingestEvolutionInbound(adminCom(SESSAO_DB), {
      session: { id: "s-1", organization_id: "org-1" },
      rawBody: JSON.stringify({ event: "messages.upsert", instance: "chip-01", data: msg({ conversation: "a" }) }),
    });
    expect(r).toEqual({ ok: true, body: { status: "processed", eventos: 1, descartados: 0 } });
  });

  it("ERROR é despachado como message.failed", async () => {
    dispatchMock.mockClear();
    await ingestEvolutionInbound(adminCom(SESSAO_DB), {
      session: { id: "s-1", organization_id: "org-1" },
      rawBody: JSON.stringify({ event: "messages.update", instance: "chip-01", data: { keyId: "3EB0X", fromMe: true, status: "ERROR" } }),
    });
    const eventos = dispatchMock.mock.calls.map((c) => (c as unknown as [unknown, unknown, { event: string }])[2].event);
    expect(eventos).toEqual(["message.failed"]);
  });
});
