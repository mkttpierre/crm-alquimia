import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import {
  LIMITE_POR_TIPO_BYTES,
  MENSAGENS_DE_RECUSA,
  recusaDoAnexo,
  validateOutboundMedia,
} from "@/lib/messaging/media/upload-validation";

describe("validateOutboundMedia", () => {
  it("classifica mimes suportados no kind certo", () => {
    expect(validateOutboundMedia("image/jpeg", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("image/webp", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("video/mp4", 1000)).toEqual({ ok: true, kind: "video" });
    expect(validateOutboundMedia("audio/ogg; codecs=opus", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("audio/webm", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("application/pdf", 1000)).toEqual({ ok: true, kind: "document" });
    expect(validateOutboundMedia("text/csv", 1000)).toEqual({ ok: true, kind: "document" });
  });
  it("rejeita mime não suportado", () => {
    const r = validateOutboundMedia("application/x-msdownload", 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_media_type");
  });
  it("rejeita acima de 50MB", () => {
    const r = validateOutboundMedia("image/jpeg", 51 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("payload_too_large");
  });
  it("rejeita arquivo vazio", () => {
    const r = validateOutboundMedia("image/jpeg", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("validation_failed");
  });
});

/**
 * Vídeo e áudio pelo composer. O teto do bucket (50 MB) não é o do WhatsApp:
 * vídeo e áudio acima de 16 MB passavam no upload e morriam no canal, sem dizer o motivo. E vídeo
 * fora de MP4/3GP (o `.mov` do iPhone, o `.webm`) subia com extensão `.bin` e chegava à Evolution
 * como `application/octet-stream` — e o `video/webm` ainda era convertido em ÁUDIO pelo transcodificador
 * de nota de voz e mandado como vídeo.
 */
describe("limite e formato por tipo (o que o WhatsApp entrega)", () => {
  const MB = 1024 * 1024;

  it("vídeo e áudio têm teto de 16 MB, escrito na mensagem", () => {
    expect(LIMITE_POR_TIPO_BYTES.video).toBe(16 * MB);
    expect(LIMITE_POR_TIPO_BYTES.audio).toBe(16 * MB);
    const v = validateOutboundMedia("video/mp4", 16 * MB + 1);
    expect(v).toMatchObject({ ok: false, code: "payload_too_large" });
    if (!v.ok) expect(v.message).toContain("16 MB");
    const a = validateOutboundMedia("audio/ogg", 17 * MB);
    expect(a).toMatchObject({ ok: false, code: "payload_too_large" });
    if (!a.ok) expect(a.message).toContain("16 MB");
  });

  it("vídeo de exatamente 16 MB passa", () => {
    expect(validateOutboundMedia("video/mp4", 16 * MB)).toEqual({ ok: true, kind: "video" });
  });

  it("imagem e documento seguem com o teto do bucket (50 MB)", () => {
    expect(validateOutboundMedia("image/jpeg", 20 * MB)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("application/pdf", 40 * MB)).toEqual({ ok: true, kind: "document" });
  });

  it("vídeo só em MP4 ou 3GP", () => {
    expect(validateOutboundMedia("video/3gpp", 1000)).toEqual({ ok: true, kind: "video" });
    for (const mime of ["video/quicktime", "video/webm", "video/x-matroska"]) {
      const r = validateOutboundMedia(mime, 1000);
      expect(r).toMatchObject({ ok: false, code: "unsupported_media_type" });
      if (!r.ok) expect(r.message).toContain("MP4");
    }
  });

  it("recusaDoAnexo: o que a tela mostra ANTES do upload (null = pode subir)", () => {
    expect(recusaDoAnexo("video/mp4", 1000)).toBeNull();
    expect(recusaDoAnexo("video/mp4", 17 * MB)).toContain("16 MB");
    expect(recusaDoAnexo("video/quicktime", 1000)).toContain("MP4");
  });

  it("toda recusa tem tradução para o espanhol (a tela passa a mensagem por t())", () => {
    for (const texto of MENSAGENS_DE_RECUSA) {
      expect(traduzir(texto, "es"), texto).not.toBe(texto);
    }
  });
});
