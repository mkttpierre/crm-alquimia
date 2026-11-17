import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adapter do canal Evolution API v2 — o transporte, com a Evolution DUBLADA.
 *
 * Nenhum teste aqui fala com servidor real: `fetch` é um mock, e as formas de
 * resposta (`{ key: { id } }`, `{ instance: { state } }`, `{ base64 }`) são as
 * que o cliente do um CRM anterior (`src/lib/evolution.ts`) lê em produção.
 *
 * O que se prova: o endpoint e o corpo de cada tipo de envio, o header `apikey`
 * (nunca query string), que o adapter falha ALTO sem credencial (em vez de
 * devolver `{externalId: null}` e o handler gravar `sent`), e os desfechos do
 * `checkHealth`.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/evolution/credentials", () => ({
  resolveEvolutionCreds: async () => credsRef.current,
}));

import { evolutionAdapter } from "@/lib/channels/adapters/evolution";
import { getAdapter } from "@/lib/channels";
import { DETALHE_CREDENCIAL_RECUSADA } from "@/lib/channels/health";

const CREDS = {
  baseUrl: "http://evolution.local:8081",
  apiKey: "chave-da-instancia",
  instance: "chip-01",
  source: "session" as const,
};
const ORG = "00000000-0000-4000-8000-000000000233";
const ID = "3EB0A1B2C3D4E5F60718";

function resposta(corpoJson: unknown, status = 201) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpoJson,
    text: async () => JSON.stringify(corpoJson),
  });
}

const ultima = () => ({
  url: String(fetchMock.mock.calls.at(-1)?.[0] ?? ""),
  init: (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
});
const corpo = () => JSON.parse(ultima().init.body ?? "{}") as Record<string, unknown>;

const envelope = (over: Record<string, unknown> = {}) =>
  ({
    organizationId: ORG,
    sessionRef: "chip-01",
    to: "5581999990000",
    kind: "text",
    body: "oi",
    ...over,
  }) as Parameters<typeof evolutionAdapter.send>[0];

beforeEach(() => {
  fetchMock.mockReset();
  credsRef.current = CREDS;
});

describe("registro no seam", () => {
  it("getAdapter('evolution') devolve este adapter", () => {
    expect(getAdapter("evolution")).toBe(evolutionAdapter);
    expect(evolutionAdapter.provider).toBe("evolution");
  });
});

describe("resolveRecipient", () => {
  const base = { isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: null };

  it("telefone vira dígitos", () => {
    expect(evolutionAdapter.resolveRecipient({ ...base, phoneNumber: "+55 (81) 99999-0000" })).toBe(
      "5581999990000",
    );
  });

  it("prefere o wa_identity de telefone", () => {
    expect(
      evolutionAdapter.resolveRecipient({
        ...base,
        phoneNumber: "+5511000000000",
        waIdentity: "phone:+5581999990000",
      }),
    ).toBe("5581999990000");
  });

  it("lid vem ANTES do telefone — o envio continua por onde a conversa veio", () => {
    expect(
      evolutionAdapter.resolveRecipient({
        ...base,
        phoneNumber: "+5581999990000",
        waLid: "70000000000001",
      }),
    ).toBe("70000000000001@lid");
  });

  it("identidade lid sem coluna wa_lid também vira @lid", () => {
    expect(evolutionAdapter.resolveRecipient({ ...base, waIdentity: "lid:123456" })).toBe(
      "123456@lid",
    );
  });

  it("grupo e contato sem endereço devolvem null", () => {
    expect(
      evolutionAdapter.resolveRecipient({ ...base, isGroup: true, groupChatId: "1@g.us" }),
    ).toBeNull();
    expect(evolutionAdapter.resolveRecipient(base)).toBeNull();
  });
});

describe("send — texto", () => {
  it("POST /message/sendText/<instância> com apikey no HEADER", async () => {
    resposta({ key: { id: ID } });
    const r = await evolutionAdapter.send(envelope());

    const { url, init } = ultima();
    expect(url).toBe("http://evolution.local:8081/message/sendText/chip-01");
    expect(init.method).toBe("POST");
    expect(init.headers?.apikey).toBe("chave-da-instancia");
    // A chave NUNCA vai na URL.
    expect(url).not.toContain("chave-da-instancia");
    expect(corpo()).toMatchObject({ number: "5581999990000", text: "oi", linkPreview: false });
    expect(r).toEqual({ externalId: ID });
  });

  it("cita a mensagem pelo id que o provider conhece", async () => {
    resposta({ key: { id: ID } });
    await evolutionAdapter.send(envelope({ replyToExternalId: "ORIGINAL123" }));
    expect(corpo().quoted).toEqual({ key: { id: "ORIGINAL123" } });
  });

  it("sem citação, o campo nem entra no corpo", async () => {
    resposta({ key: { id: ID } });
    await evolutionAdapter.send(envelope());
    expect(corpo()).not.toHaveProperty("quoted");
  });

  it("resposta sem key.id → externalId null (a mensagem saiu, só não sabemos o id)", async () => {
    resposta({});
    expect(await evolutionAdapter.send(envelope())).toEqual({
      externalId: null,
      confirmado: false,
      motivo: "resposta_sem_key_id",
    });
  });

  it("chama beforeSend antes do transporte", async () => {
    const ordem: string[] = [];
    fetchMock.mockImplementationOnce(async () => {
      ordem.push("fetch");
      return { ok: true, status: 201, json: async () => ({ key: { id: ID } }), text: async () => "" };
    });
    await evolutionAdapter.send(
      envelope({
        beforeSend: async () => {
          ordem.push("beforeSend");
        },
      }),
    );
    expect(ordem).toEqual(["beforeSend", "fetch"]);
  });
});

describe("send — mídia", () => {
  const media = { url: "https://cdn.x/a.jpg", mime: "image/jpeg", filename: "a.jpg", caption: "olha" };

  it("imagem vai por sendMedia com mediatype image e legenda", async () => {
    resposta({ key: { id: ID } });
    const r = await evolutionAdapter.send(envelope({ kind: "image", body: undefined, media }));
    expect(ultima().url).toBe("http://evolution.local:8081/message/sendMedia/chip-01");
    expect(corpo()).toMatchObject({
      number: "5581999990000",
      mediatype: "image",
      mimetype: "image/jpeg",
      media: "https://cdn.x/a.jpg",
      fileName: "a.jpg",
      caption: "olha",
    });
    expect(r.externalId).toBe(ID);
  });

  it("documento e sticker caem em mediatype document", async () => {
    resposta({ key: { id: ID } });
    await evolutionAdapter.send(
      envelope({ kind: "document", body: undefined, media: { ...media, mime: "application/pdf" } }),
    );
    expect(corpo().mediatype).toBe("document");
  });

  it("áudio vai por sendWhatsAppAudio com encoding:true (a Evolution converte)", async () => {
    resposta({ key: { id: ID } });
    await evolutionAdapter.send(
      envelope({ kind: "audio", body: undefined, media: { url: "https://cdn.x/v.mp3", mime: "audio/mpeg" } }),
    );
    expect(ultima().url).toBe("http://evolution.local:8081/message/sendWhatsAppAudio/chip-01");
    expect(corpo()).toMatchObject({ audio: "https://cdn.x/v.mp3", encoding: true });
  });
});

describe("send — falhas altas", () => {
  it("sem credencial LANÇA evolution_not_configured (nunca devolve null calado)", async () => {
    credsRef.current = null;
    await expect(evolutionAdapter.send(envelope())).rejects.toThrow(/^evolution_not_configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP de erro sobe com o status no prefixo", async () => {
    resposta({ message: "x" }, 400);
    await expect(evolutionAdapter.send(envelope())).rejects.toThrow(/^evolution_400/);
  });

  it("cartão de contato não é suportado e não toca o transporte", async () => {
    await expect(evolutionAdapter.send(envelope({ kind: "contact" }))).rejects.toThrow(
      /evolution_contact_not_supported/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isConfigured é sempre true: quem desiste é send()", () => {
    expect(evolutionAdapter.isConfigured()).toBe(true);
  });

  it("os códigos de erro carregam o nome do canal", () => {
    expect(evolutionAdapter.codes).toEqual({
      notConfigured: "evolution_not_configured",
      sendFailed: "evolution_error",
      unknownError: "evolution_unknown",
    });
  });
});

describe("checkHealth", () => {
  const pergunta = () => evolutionAdapter.checkHealth!({ organizationId: ORG, sessionRef: "chip-01" });

  it.each([
    ["open", "WORKING"],
    ["connecting", "STARTING"],
    ["close", "STOPPED"],
  ])("estado %s → %s", async (estado, esperado) => {
    resposta({ instance: { instanceName: "chip-01", state: estado } }, 200);
    expect(await pergunta()).toEqual({ reachable: true, status: esperado, detail: null });
    expect(ultima().url).toBe("http://evolution.local:8081/instance/connectionState/chip-01");
    expect(ultima().init.method).toBe("GET");
  });

  it("estado desconhecido NÃO vira queda: reachable false, sem status", async () => {
    resposta({ instance: { state: "algo-novo" } }, 200);
    const h = await pergunta();
    expect(h.reachable).toBe(false);
    expect(h.status).toBeNull();
  });

  it("404 = a instância não existe mais → STOPPED, alcançável", async () => {
    resposta({ message: "not found" }, 404);
    expect(await pergunta()).toEqual({ reachable: true, status: "STOPPED", detail: null });
  });

  it("um 404 só no CORPO de um 500 não vira STOPPED", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '{"detail":"upstream 404"}',
      json: async () => ({}),
    });
    const h = await pergunta();
    expect(h.reachable).toBe(false);
    expect(h.status).toBeNull();
  });

  it.each([401, 403])("%s → credencial recusada, sem inventar estado", async (code) => {
    resposta({}, code);
    expect(await pergunta()).toEqual({
      reachable: false,
      status: null,
      detail: DETALHE_CREDENCIAL_RECUSADA,
    });
  });

  it("servidor fora do ar → reachable false com o motivo", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    const h = await pergunta();
    expect(h).toMatchObject({ reachable: false, status: null });
    expect(h.detail).toContain("fetch failed");
  });

  it("sem credencial → transporte_nao_configurado", async () => {
    credsRef.current = null;
    expect(await pergunta()).toEqual({
      reachable: false,
      status: null,
      detail: "transporte_nao_configurado",
    });
  });
});

describe("fetchInboundMedia", () => {
  const baixa = (url: string) =>
    evolutionAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: "chip-01", url });

  it("baixa pelo id da referência, do PRÓPRIO servidor, e decodifica o base64", async () => {
    resposta({ base64: Buffer.from("conteudo").toString("base64"), mimetype: "image/png" }, 201);
    const m = await baixa(`evolution-media:${ID}`);
    expect(ultima().url).toBe("http://evolution.local:8081/chat/getBase64FromMediaMessage/chip-01");
    expect(corpo()).toEqual({ message: { key: { id: ID } } });
    expect(m.buffer.toString()).toBe("conteudo");
    expect(m.mime).toBe("image/png");
  });

  it("aceita prefixo data: no base64", async () => {
    resposta({ base64: `data:image/png;base64,${Buffer.from("x").toString("base64")}` }, 201);
    expect((await baixa(`evolution-media:${ID}`)).buffer.toString()).toBe("x");
  });

  it("URL que não é referência nossa é recusada SEM nenhuma chamada de rede (anti-SSRF)", async () => {
    await expect(baixa("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /referência de mídia desconhecida/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchProfilePictureUrl", () => {
  it("devolve a URL; erro vira null", async () => {
    resposta({ profilePictureUrl: "https://pps/x.jpg" }, 201);
    expect(
      await evolutionAdapter.fetchProfilePictureUrl!({
        organizationId: ORG,
        sessionRef: "chip-01",
        recipient: "5581999990000",
      }),
    ).toBe("https://pps/x.jpg");

    fetchMock.mockRejectedValueOnce(new Error("boom"));
    expect(
      await evolutionAdapter.fetchProfilePictureUrl!({
        organizationId: ORG,
        sessionRef: "chip-01",
        recipient: "5581999990000",
      }),
    ).toBeNull();
  });
});

describe("send — presença (digitando/gravando) antes do envio", () => {
  it("com presence, chama /chat/sendPresence ANTES do envio, com o tempo em delay", async () => {
    resposta({});
    resposta({ key: { id: ID } });
    await evolutionAdapter.send(envelope({ presence: { kind: "recording", ms: 20000 } }));
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["http://evolution.local:8081/chat/sendPresence/chip-01", "http://evolution.local:8081/message/sendText/chip-01"]);
    const corpoPresenca = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body)) as Record<string, unknown>;
    expect(corpoPresenca).toEqual({ number: "5581999990000", presence: "recording", delay: 20000 });
  });

  it("presença acima de 25 s é cortada em 25 s", async () => {
    resposta({});
    resposta({ key: { id: ID } });
    await evolutionAdapter.send(envelope({ presence: { kind: "composing", ms: 90000 } }));
    const corpoPresenca = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body)) as Record<string, unknown>;
    expect(corpoPresenca.delay).toBe(25000);
  });

  it("presença que falha NÃO impede o envio (é enfeite)", async () => {
    resposta({ erro: "x" }, 500);
    resposta({ key: { id: ID } });
    expect(await evolutionAdapter.send(envelope({ presence: { kind: "composing", ms: 2000 } }))).toEqual({ externalId: ID });
  });

  it("sem presence, não chama /chat/sendPresence", async () => {
    resposta({ key: { id: ID } });
    await evolutionAdapter.send(envelope());
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("sendPresence"))).toBe(false);
  });
});
