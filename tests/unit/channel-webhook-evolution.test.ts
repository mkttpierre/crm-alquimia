import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Entrada do canal Evolution: contrato do fio, tradução para o envelope interno
 * e despacho na ingestão compartilhada.
 *
 * As formas de payload são as que o webhook do um CRM anterior
 * (`src/app/api/whatsapp/route.ts`) lê em produção: `messages.upsert` com
 * `data.key.{remoteJid, remoteJidAlt, fromMe, id}`, `pushName`, `message.*`.
 *
 * Metade dos casos prova o que NÃO pode entrar: status, grupo, canal, evento de
 * outra instância, payload malformado. Webhook que aceita o que não devia grava
 * lixo no banco de quem instalou.
 */
import {
  ackDoStatus,
  eventoCanonico,
  idDaReferenciaDeMidia,
  lerEnvelopeEvolution,
  statusDoEstado,
  traduzirEvento,
  type EvolutionEnvelope,
} from "@/lib/channels/evolution/webhook";

const upsert = (data: unknown, extra: Record<string, unknown> = {}) =>
  ({ event: "messages.upsert", instance: "chip-01", data, ...extra }) as EvolutionEnvelope;

const msg = (over: Record<string, unknown> = {}, key: Record<string, unknown> = {}) => ({
  key: { remoteJid: "5581999990000@s.whatsapp.net", fromMe: false, id: "3EB0AAA", ...key },
  pushName: "Maria",
  messageType: "conversation",
  messageTimestamp: 1_760_000_000,
  message: { conversation: "bom dia" },
  ...over,
});

describe("contrato do fio", () => {
  it("lê o envelope mínimo e preserva campo desconhecido (loose)", () => {
    const r = lerEnvelopeEvolution(JSON.stringify({ event: "x", instance: "i", novo: 1 }));
    expect(r.ok && (r.envelope as Record<string, unknown>).novo).toBe(1);
  });

  it("JSON quebrado e instância ausente são motivos DIFERENTES", () => {
    expect(lerEnvelopeEvolution("{nao e json")).toMatchObject({ ok: false, motivo: "json_invalido" });
    const r = lerEnvelopeEvolution(JSON.stringify({ event: "messages.upsert" }));
    expect(r).toMatchObject({ ok: false, motivo: "contrato_violado" });
    // nomeia o CAMPO, nunca o valor
    expect(r.ok === false && r.campos).toEqual(["instance"]);
  });

  it("MESSAGES_UPSERT e messages.upsert são o mesmo evento", () => {
    expect(eventoCanonico("MESSAGES_UPSERT")).toBe("messages.upsert");
    expect(eventoCanonico("connection.update")).toBe("connection.update");
  });
});

describe("messages.upsert → envelope interno", () => {
  it("texto recebido vira evento `message` com o id cru do Baileys", () => {
    const t = traduzirEvento(upsert(msg()));
    expect(t.envelopes).toHaveLength(1);
    expect(t.envelopes[0]!).toMatchObject({
      event: "message",
      session: "chip-01",
      payload: {
        id: "3EB0AAA",
        from: "5581999990000@s.whatsapp.net",
        fromMe: false,
        body: "bom dia",
        hasMedia: false,
        timestamp: 1_760_000_000,
        _data: { pushName: "Maria" },
      },
    });
    // recebido não tem `to`
    expect(t.envelopes[0]!.payload).not.toHaveProperty("to");
  });

  it("fromMe carrega o chat em `from` E `to` (o caminho do celular do dono)", () => {
    const t = traduzirEvento(upsert(msg({}, { fromMe: true })));
    expect(t.envelopes[0]!.payload).toMatchObject({
      fromMe: true,
      from: "5581999990000@s.whatsapp.net",
      to: "5581999990000@s.whatsapp.net",
    });
  });

  it("chat @lid leva o telefone real em remoteJidAlt (o dado que a identidade usa)", () => {
    const t = traduzirEvento(
      upsert(msg({}, { remoteJid: "70000000000001@lid", remoteJidAlt: "5581999990000@s.whatsapp.net" })),
    );
    expect(t.envelopes[0]!.payload?.from).toBe("70000000000001@lid");
    expect(t.envelopes[0]!.payload?._data?.key?.remoteJidAlt).toBe("5581999990000@s.whatsapp.net");
  });

  it.each([
    ["extendedTextMessage", { extendedTextMessage: { text: "com link" } }, "com link"],
    ["legenda de imagem", { imageMessage: { caption: "olha", mimetype: "image/jpeg" } }, "olha"],
    ["resposta de botão", { buttonsResponseMessage: { selectedDisplayText: "Sim" } }, "Sim"],
    ["resposta de lista", { listResponseMessage: { title: "Plano B" } }, "Plano B"],
  ])("extrai o texto de %s", (_n, message, esperado) => {
    expect(traduzirEvento(upsert(msg({ message }))).envelopes[0]!.payload?.body).toBe(esperado);
  });

  it("mídia vira referência evolution-media:<id> + mime, sem URL pública", () => {
    const t = traduzirEvento(
      upsert(msg({ message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } } })),
    );
    const p = t.envelopes[0]!.payload!;
    expect(p.hasMedia).toBe(true);
    expect(p.mediaUrl).toBe("evolution-media:3EB0AAA");
    expect(p.mimetype).toBe("audio/ogg; codecs=opus");
    expect(idDaReferenciaDeMidia(p.mediaUrl!)).toBe("3EB0AAA");
  });

  it("desembrulha mensagem efêmera e de visualização única", () => {
    const t = traduzirEvento(
      upsert(msg({ message: { ephemeralMessage: { message: { conversation: "some em 24h" } } } })),
    );
    expect(t.envelopes[0]!.payload?.body).toBe("some em 24h");
    const v = traduzirEvento(
      upsert(msg({ message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } } } })),
    );
    expect(v.envelopes[0]!.payload?.hasMedia).toBe(true);
  });

  it("data como lista gera um envelope por mensagem", () => {
    const t = traduzirEvento(upsert([msg(), msg({}, { id: "3EB0BBB" })]));
    expect(t.envelopes.map((e) => e.payload?.id)).toEqual(["3EB0AAA", "3EB0BBB"]);
  });

  it.each([
    ["status", "status@broadcast"],
    ["canal", "120363@newsletter"],
    ["lista de transmissão", "5581@broadcast"],
  ])("%s nunca vira conversa", (_n, jid) => {
    expect(traduzirEvento(upsert(msg({}, { remoteJid: jid }))).envelopes).toEqual([]);
  });

  // REGRA ABSOLUTA (03/11/2026, ordem do operador): grupo (@g.us) é ignorado por completo, já na tradução do webhook —
  // nenhum envelope, então nada chega a mensagem, contato ou log. (Antes o grupo entrava e a ingestão o descartava.)
  it("grupo nunca vira envelope (descartado já na tradução do webhook)", () => {
    const t = traduzirEvento(upsert(msg({}, { remoteJid: "120363@g.us" })));
    expect(t.envelopes).toEqual([]);
  });

  it("item sem key.id é descartado sem derrubar o lote; item malformado é CONTADO", () => {
    const t = traduzirEvento(
      upsert([msg({}, { id: undefined }), { key: "nao-e-objeto" }, 42, msg({}, { id: "3EB0OK" })]),
    );
    expect(t.envelopes.map((e) => e.payload?.id)).toEqual(["3EB0OK"]);
    // `{ key: "..." }` e `42` fora do contrato; o sem-id passou no schema e foi filtrado
    expect(t.descartados).toBe(2);
  });

  it("timestamp em string numérica é aceito; lixo vira ausente", () => {
    expect(
      traduzirEvento(upsert(msg({ messageTimestamp: "1760000000" }))).envelopes[0]!.payload?.timestamp,
    ).toBe(1_760_000_000);
    expect(
      traduzirEvento(upsert(msg({ messageTimestamp: { low: 1, high: 0 } }))).envelopes[0]!.payload?.timestamp,
    ).toBeUndefined();
  });

  it("reação não tem texto nem mídia: o envelope sai, e a ingestão o descarta pela guarda de corpo vazio", () => {
    const t = traduzirEvento(upsert(msg({ message: { reactionMessage: { text: "👍" } } })));
    expect(t.envelopes[0]!.payload?.body).toBeNull();
    expect(t.envelopes[0]!.payload?.hasMedia).toBe(false);
  });
});

describe("messages.update → ack", () => {
  const upd = (data: unknown) => ({ event: "messages.update", instance: "chip-01", data }) as EvolutionEnvelope;

  it.each([
    ["SERVER_ACK", 1],
    ["DELIVERY_ACK", 2],
    ["READ", 3],
    ["PLAYED", 4],
  ])("%s → ack %i", (status, ack) => {
    expect(ackDoStatus(status)).toBe(ack);
    const t = traduzirEvento(upd({ keyId: "3EB0AAA", fromMe: true, status }));
    expect(t.envelopes).toEqual([
      { event: "message.ack", session: "chip-01", payload: { id: "3EB0AAA", ack } },
    ]);
  });

  it("ERROR e vocabulário novo NÃO rebaixam o status de quem já foi entregue", () => {
    expect(ackDoStatus("ERROR")).toBeNull();
    expect(traduzirEvento(upd({ keyId: "x", fromMe: true, status: "ERROR" })).envelopes).toEqual([]);
  });

  it("recibo de mensagem que não é nossa (fromMe:false) não atualiza linha", () => {
    expect(traduzirEvento(upd({ keyId: "x", fromMe: false, status: "READ" })).envelopes).toEqual([]);
  });
});

describe("connection.update → status da sessão", () => {
  const conn = (state: unknown) =>
    ({ event: "connection.update", instance: "chip-01", data: { instance: "chip-01", state } }) as EvolutionEnvelope;

  it.each([
    ["open", "WORKING"],
    ["connecting", "STARTING"],
    ["close", "STOPPED"],
  ])("%s → %s", (state, status) => {
    expect(statusDoEstado(state)).toBe(status);
    expect(traduzirEvento(conn(state)).envelopes).toEqual([
      { event: "session.status", session: "chip-01", payload: { status } },
    ]);
  });

  it("estado desconhecido não inventa status", () => {
    expect(statusDoEstado("refused")).toBeNull();
    expect(traduzirEvento(conn("refused")).envelopes).toEqual([]);
  });
});

describe("messages.delete → revogada", () => {
  it("vira message.revoked pelo id", () => {
    const t = traduzirEvento({
      event: "messages.delete",
      instance: "chip-01",
      data: { id: "3EB0AAA", remoteJid: "x@s.whatsapp.net", fromMe: false },
    } as EvolutionEnvelope);
    expect(t.envelopes).toEqual([
      { event: "message.revoked", session: "chip-01", payload: { id: "3EB0AAA", revokedMessageId: "3EB0AAA" } },
    ]);
  });
});

describe("evento que o CRM não consome", () => {
  it.each(["qrcode.updated", "presence.update", "chats.upsert", "contacts.update"])(
    "%s é ignorado (não é erro)",
    (evento) => {
      const t = traduzirEvento({ event: evento, instance: "chip-01", data: {} } as EvolutionEnvelope);
      expect(t.ignorado).toBe(true);
      expect(t.envelopes).toEqual([]);
    },
  );
});

describe("referência de mídia", () => {
  it("só aceita o prefixo nosso", () => {
    expect(idDaReferenciaDeMidia("evolution-media:ABC")).toBe("ABC");
    expect(idDaReferenciaDeMidia("evolution-media:")).toBeNull();
    expect(idDaReferenciaDeMidia("https://x/y.jpg")).toBeNull();
  });
});

// ─── A ingestão: o que chega ao dispatch compartilhado ─────────────────────────

const dispatchMock = vi.fn(async () => undefined);
vi.mock("@/lib/waha/ingest", () => ({ dispatchWahaEvent: (...a: unknown[]) => dispatchMock(...(a as [])) }));

import { ingestEvolutionInbound } from "@/lib/channels/evolution/ingest";

const SESSAO = { id: "s-1", organization_id: "org-1" };

/** Admin dublado: devolve a linha da sessão e guarda os filtros recebidos. */
function adminCom(linha: Record<string, unknown> | null, erro: { message: string } | null = null) {
  const filtros: Array<[string, unknown]> = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (c: string, v: unknown) => {
    filtros.push([c, v]);
    return q;
  };
  q.maybeSingle = async () => ({ data: linha, error: erro });
  return { admin: { from: () => q } as never, filtros };
}

const SESSAO_DB = {
  id: "s-1",
  organization_id: "org-1",
  evolution_instance_name: "chip-01",
  is_warmup_complete: false,
  warmup_started_at: "2026-10-01T00:00:00Z",
};

beforeEach(() => dispatchMock.mockClear());

describe("ingestEvolutionInbound", () => {
  const corpoDe = (e: Record<string, unknown>) => JSON.stringify(e);

  it("despacha cada evento traduzido, com a sessão e a organização do TOKEN", async () => {
    const { admin, filtros } = adminCom(SESSAO_DB);
    const r = await ingestEvolutionInbound(admin, {
      session: SESSAO,
      rawBody: corpoDe({ event: "messages.upsert", instance: "chip-01", data: [msg(), msg({}, { id: "3EB0BBB" })] }),
    });

    expect(r).toEqual({ ok: true, body: { status: "processed", eventos: 2, descartados: 0 } });
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    const [, sessao, envelope] = dispatchMock.mock.calls[0] as unknown as [unknown, Record<string, unknown>, { event: string }];
    expect(sessao).toEqual({
      id: "s-1",
      organization_id: "org-1",
      is_warmup_complete: false,
      warmup_started_at: "2026-10-01T00:00:00Z",
    });
    expect(envelope.event).toBe("message");
    // a busca da sessão leva a ORGANIZAÇÃO junto (multi-tenant)
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["id", "s-1"]);
  });

  it("instância do payload diferente da sessão → ignorado, NADA despachado", async () => {
    const { admin } = adminCom(SESSAO_DB);
    const r = await ingestEvolutionInbound(admin, {
      session: SESSAO,
      rawBody: corpoDe({ event: "messages.upsert", instance: "OUTRO-CHIP", data: msg() }),
    });
    expect(r).toEqual({ ok: true, body: { status: "ignored", reason: "instancia_divergente" } });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("evento sem interesse → 200 ignorado", async () => {
    const { admin } = adminCom(SESSAO_DB);
    const r = await ingestEvolutionInbound(admin, {
      session: SESSAO,
      rawBody: corpoDe({ event: "presence.update", instance: "chip-01", data: {} }),
    });
    expect(r).toEqual({ ok: true, body: { status: "ignored", reason: "evento_sem_interesse" } });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("contagem de itens descartados volta no corpo (nunca calada)", async () => {
    const { admin } = adminCom(SESSAO_DB);
    const r = await ingestEvolutionInbound(admin, {
      session: SESSAO,
      rawBody: corpoDe({ event: "messages.upsert", instance: "chip-01", data: [msg(), 42] }),
    });
    expect(r).toMatchObject({ ok: true, body: { eventos: 1, descartados: 1 } });
  });

  it("JSON inválido e contrato violado são recusas distintas", async () => {
    const { admin } = adminCom(SESSAO_DB);
    expect(await ingestEvolutionInbound(admin, { session: SESSAO, rawBody: "{ruim" })).toMatchObject({
      ok: false,
      code: "invalid_json",
    });
    expect(
      await ingestEvolutionInbound(admin, { session: SESSAO, rawBody: corpoDe({ event: "x" }) }),
    ).toMatchObject({ ok: false, code: "contrato_violado" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("falha de leitura da sessão LANÇA (a rota responde 500 e a Evolution reentrega)", async () => {
    const { admin } = adminCom(null, { message: "db fora" });
    await expect(
      ingestEvolutionInbound(admin, {
        session: SESSAO,
        rawBody: corpoDe({ event: "messages.upsert", instance: "chip-01", data: msg() }),
      }),
    ).rejects.toThrow(/evolution_session_lookup_failed/);
  });

  it("sessão sumida → ignorado, sem despacho", async () => {
    const { admin } = adminCom(null);
    const r = await ingestEvolutionInbound(admin, {
      session: SESSAO,
      rawBody: corpoDe({ event: "messages.upsert", instance: "chip-01", data: msg() }),
    });
    expect(r).toEqual({ ok: true, body: { status: "ignored", reason: "sessao_inexistente" } });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
