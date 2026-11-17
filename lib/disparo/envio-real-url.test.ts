import { describe, expect, it } from "vitest";
import { urlParaOCanal } from "./envio-real";

describe("urlParaOCanal", () => {
  const assinada = "http://127.0.0.1:54321/storage/v1/object/sign/whatsapp-media/x.ogg?token=abc";
  it("troca o host local pelo host do container", () => {
    expect(urlParaOCanal(assinada, "host.docker.internal")).toBe(
      "http://host.docker.internal:54321/storage/v1/object/sign/whatsapp-media/x.ogg?token=abc",
    );
  });
  it("sem host configurado mantém a URL", () => {
    expect(urlParaOCanal(assinada, "")).toBe(assinada);
  });
  it("não mexe em URL que não é local", () => {
    const publica = "https://abc.supabase.co/storage/v1/x?token=1";
    expect(urlParaOCanal(publica, "host.docker.internal")).toBe(publica);
  });
});
