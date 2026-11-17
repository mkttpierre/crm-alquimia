/**
 * Vídeo e áudio que o operador manda pelo COMPOSER da conversa, do lado do canal Evolution.
 *
 * O caminho real: o composer sobe o arquivo (`POST /conversations/[id]/media`, que guarda em
 * `{org}/{conversa}/out-<uuid>.<ext>` e devolve `kind` + `media_mime`), depois `POST /messages`
 * com `type = kind` e `media_storage_path`; o handler assina a URL do Storage e entrega ao
 * adapter um envelope com `kind`, `media.url`, `media.mime`, `media.filename` (o último pedaço do
 * path) e `media.caption` (a legenda digitada). Este arquivo começa nesse envelope e termina no
 * corpo HTTP que chega à Evolution 2.3.7, com a Evolution dublada por um `fetch` falso.
 *
 * Contrato da 2.3.7 (lido no bundle `infra/x1/docker/evolution-main.js`, serviço Baileys):
 * - `POST /message/sendWhatsAppAudio/{instance}`: `audio` = URL ou base64; `encoding: true` faz
 *   ela baixar a URL e reencodar em ogg/opus (`processAudio`) e mandar com `ptt: true` (bolha de
 *   voz). Sem `encoding` ela também converte (o padrão é `true`), mas o pedido explícito não
 *   depende de padrão de versão.
 * - `POST /message/sendMedia/{instance}`: `mediatype` image|video|document, `media` = URL ou
 *   base64, `caption`; o `mimetype` final ela deduz do `fileName` (`mime.lookup`), por isso o
 *   nome precisa terminar na extensão do vídeo (`client-midia.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/evolution/credentials", () => ({
  resolveEvolutionCreds: async () => ({
    baseUrl: "http://evolution.local:8081",
    apiKey: "k",
    instance: "chip-01",
    source: "session" as const,
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { evolutionAdapter } from "@/lib/channels/adapters/evolution";

type Envelope = Parameters<typeof evolutionAdapter.send>[0];

const URL_ASSINADA =
  "http://host.docker.internal:54321/storage/v1/object/sign/whatsapp-media/org-1/conv-1/out-7f1c.mp4?token=t";
const URL_AUDIO =
  "http://host.docker.internal:54321/storage/v1/object/sign/whatsapp-media/org-1/conv-1/out-9a2b.ogg?token=t";

/** O envelope que o handler monta a partir do que o upload devolveu. */
function doComposer(over: Partial<Envelope>): Envelope {
  return {
    organizationId: "org-1",
    sessionRef: "chip-01",
    to: "5581999990000",
    providerConversationId: null,
    replyToExternalId: null,
    ...over,
  } as Envelope;
}

function chamada(i = 0): { url: string; corpo: Record<string, unknown>; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return {
    url,
    corpo: JSON.parse(String(init.body)) as Record<string, unknown>,
    headers: init.headers as Record<string, string>,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ key: { id: "3EB0COMPOSER" } }),
    text: async () => "",
  });
});

describe("áudio gravado no composer → mensagem de voz", () => {
  it("sai por sendWhatsAppAudio, com a URL assinada e encoding: true — corpo exato", async () => {
    // O upload já trocou o container webm → ogg (voice-transcode); o mime que chega aqui é o guardado.
    const r = await evolutionAdapter.send(
      doComposer({
        kind: "audio",
        media: { url: URL_AUDIO, mime: "audio/ogg", filename: "out-9a2b.ogg", caption: null },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, corpo, headers } = chamada();
    expect(url).toBe("http://evolution.local:8081/message/sendWhatsAppAudio/chip-01");
    expect(corpo).toEqual({ number: "5581999990000", audio: URL_AUDIO, encoding: true });
    expect(headers.apikey).toBe("k");
    expect(r).toEqual({ externalId: "3EB0COMPOSER" });
  });

  it("o webm que o Chrome grava (quando a conversão do upload falha) vai pelo MESMO caminho de voz", async () => {
    const webm = URL_AUDIO.replace(".ogg", ".webm");
    await evolutionAdapter.send(
      doComposer({
        kind: "audio",
        media: { url: webm, mime: "audio/webm;codecs=opus", filename: "out-9a2b.webm", caption: null },
      }),
    );
    const { url, corpo } = chamada();
    expect(url).toMatch(/\/message\/sendWhatsAppAudio\//);
    // `encoding: true` é o que faz a Evolution reencodar em ogg/opus antes de mandar.
    expect(corpo).toEqual({ number: "5581999990000", audio: webm, encoding: true });
  });

  it("áudio nunca vai por sendMedia (chegaria como arquivo anexo, sem a bolha de voz)", async () => {
    await evolutionAdapter.send(
      doComposer({ kind: "audio", media: { url: URL_AUDIO, mime: "audio/ogg", filename: "out-9a2b.ogg", caption: null } }),
    );
    expect(chamada().url).not.toMatch(/sendMedia/);
  });
});

describe("vídeo mp4 anexado no composer → vídeo com legenda", () => {
  it("sai por sendMedia com mediatype video, mimetype video/mp4 e a legenda — corpo exato", async () => {
    const r = await evolutionAdapter.send(
      doComposer({
        kind: "video",
        media: { url: URL_ASSINADA, mime: "video/mp4", filename: "out-7f1c.mp4", caption: "Olha o vídeo" },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, corpo } = chamada();
    expect(url).toBe("http://evolution.local:8081/message/sendMedia/chip-01");
    expect(corpo).toEqual({
      number: "5581999990000",
      mediatype: "video",
      mimetype: "video/mp4",
      media: URL_ASSINADA,
      fileName: "out-7f1c.mp4",
      caption: "Olha o vídeo",
    });
    expect(r).toEqual({ externalId: "3EB0COMPOSER" });
  });

  it("sem legenda, o corpo não leva `caption`", async () => {
    await evolutionAdapter.send(
      doComposer({ kind: "video", media: { url: URL_ASSINADA, mime: "video/mp4", filename: "out-7f1c.mp4", caption: null } }),
    );
    expect(chamada().corpo).not.toHaveProperty("caption");
  });

  it("a mídia vai como URL (Storage primeiro), nunca como base64 inline", async () => {
    await evolutionAdapter.send(
      doComposer({ kind: "video", media: { url: URL_ASSINADA, mime: "video/mp4", filename: "out-7f1c.mp4", caption: null } }),
    );
    expect(String(chamada().corpo.media)).toMatch(/^https?:\/\//);
  });
});
