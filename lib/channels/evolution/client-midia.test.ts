/**
 * A Evolution 2.3.7 IGNORA o `mimetype` que mandamos no `/message/sendMedia`: o `prepareMediaMessage` dela
 * deduz o tipo pelo nome do arquivo (`mime.lookup(fileName)`). Nome sem extensão ("Tabela de valores do
 * funil (Marca A)") vira `mimetype: "false"`, o WhatsApp aceita o envio e nunca entrega (fica PENDING).
 * Por isso o `fileName` sai sempre com a extensão do mime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { enviarMidia } from "./client";

const CREDS = { baseUrl: "http://evolution.local", apiKey: "k", instance: "chip-alfa", source: "session" as const };

afterEach(() => vi.unstubAllGlobals());

async function enviar(filename: string | null, mime: string) {
  const fetchFalso = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ key: { id: "x" } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchFalso);
  await enviarMidia(CREDS, { number: "5511999990000", kind: "image", url: "http://host/a?token=t", mime, filename });
  const init = fetchFalso.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(init.body)) as { fileName: string; mimetype: string };
}

describe("nome do arquivo da mídia sempre com a extensão do mime", () => {
  it("nome sem extensão ganha a do mime (o caso da tabela de valores de uma organização)", async () => {
    const b = await enviar("Tabela de valores do funil (Marca A)", "image/jpeg");
    expect(b.fileName).toBe("Tabela de valores do funil (Marca A).jpg");
    expect(b.mimetype).toBe("image/jpeg");
  });

  it("nome que já termina na extensão certa fica igual", async () => {
    expect((await enviar("Prévia Doces Exemplo.png", "image/png")).fileName).toBe("Prévia Doces Exemplo.png");
  });

  it("extensão que não bate com o mime ganha a certa no fim", async () => {
    expect((await enviar("tabela.png", "image/jpeg")).fileName).toBe("tabela.png.jpg");
  });

  it("sem nome: arquivo + extensão do mime", async () => {
    expect((await enviar(null, "image/webp")).fileName).toBe("arquivo.webp");
    expect((await enviar(null, "application/pdf")).fileName).toBe("arquivo.pdf");
    expect((await enviar(null, "video/mp4")).fileName).toBe("arquivo.mp4");
  });

  it("mime desconhecido: nome fica como veio", async () => {
    expect((await enviar("planilha", "application/x-coisa")).fileName).toBe("planilha");
  });
});
