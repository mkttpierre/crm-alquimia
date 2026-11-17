import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { exigeSegredoDeAssinatura } from "@/lib/channels/inbound";
import { logger } from "@/lib/logger";

import { decryptWebhookSecret, limparAvisosDeDecifraParaTeste } from "./secrets";

function adminQueDecifra(resposta: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(resposta);
  return { admin: { rpc } as unknown as SupabaseClient, rpc };
}

beforeEach(() => {
  limparAvisosDeDecifraParaTeste();
  vi.restoreAllMocks();
});

describe("decryptWebhookSecret: falha vira UM aviso por contexto", () => {
  it("devolve null e avisa só na primeira falha do mesmo contexto", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { admin, rpc } = adminQueDecifra({ data: null, error: { message: "Wrong key or corrupt data" } });

    for (let i = 0; i < 5; i += 1) {
      expect(await decryptWebhookSecret(admin, "abcd", { contexto: "webhook:sessao-1" })).toBeNull();
    }

    expect(rpc).toHaveBeenCalledTimes(5);
    expect(aviso).toHaveBeenCalledTimes(1);
    expect(aviso.mock.calls[0]?.[1]).toMatchObject({
      contexto: "webhook:sessao-1",
      error: "Wrong key or corrupt data",
    });
  });

  it("contextos diferentes avisam cada um uma vez", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { admin } = adminQueDecifra({ data: null, error: { message: "x" } });

    await decryptWebhookSecret(admin, "abcd", { contexto: "webhook:a" });
    await decryptWebhookSecret(admin, "abcd", { contexto: "webhook:b" });
    await decryptWebhookSecret(admin, "abcd", { contexto: "webhook:a" });

    expect(aviso).toHaveBeenCalledTimes(2);
  });

  it("sem contexto não avisa (o chamador trata o null)", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { admin } = adminQueDecifra({ data: null, error: { message: "x" } });

    expect(await decryptWebhookSecret(admin, "abcd")).toBeNull();
    expect(aviso).not.toHaveBeenCalled();
  });

  it("decifra que dá certo devolve o texto, não avisa e prefixa o bytea", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { admin, rpc } = adminQueDecifra({ data: "segredo-claro", error: null });

    expect(await decryptWebhookSecret(admin, "abcd", { contexto: "webhook:ok" })).toBe("segredo-claro");
    expect(rpc).toHaveBeenCalledWith("fn_decrypt_oauth", { ciphertext: "\\xabcd" });
    expect(aviso).not.toHaveBeenCalled();
  });
});

describe("exigeSegredoDeAssinatura: a rota só decifra para quem confere assinatura", () => {
  it("zernio assina o corpo, evolution autentica pelo token do caminho", () => {
    expect(exigeSegredoDeAssinatura("zernio")).toBe(true);
    expect(exigeSegredoDeAssinatura("evolution")).toBe(false);
  });
});
