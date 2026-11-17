/**
 * Revogar a instância Evolution ao excluir a conexão: logout e delete no servidor.
 *
 * É TENTATIVA, não portão. Quem chama (a exclusão da conexão) segue para o banco
 * em qualquer desfecho, então a função nunca lança: devolve `revogado` e o
 * motivo, e a tela avisa o operador quando o servidor não respondeu.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { revogarInstanciaEvolution } from "./revogar";

const CREDS = { baseUrl: "http://evolution.local", apiKey: "k", instance: "chip-alfa", source: "session" as const };

afterEach(() => vi.unstubAllGlobals());

type Resposta = { status: number; corpo?: unknown } | Error;

/** `fetch` dublado que responde, por caminho, o que o teste mandar. */
function stubFetch(porCaminho: Record<string, Resposta>) {
  const f = vi.fn(async (url: string, _init: RequestInit) => {
    const caminho = new URL(url).pathname;
    const r = porCaminho[caminho];
    if (!r) throw new Error(`caminho inesperado: ${caminho}`);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.corpo ?? { status: "SUCCESS" }), { status: r.status });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

function econnrefused(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8081"), { code: "ECONNREFUSED" }),
  });
}

describe("revogarInstanciaEvolution", () => {
  it("faz logout e depois delete da instância, com apikey no header e tempo limite", async () => {
    const f = stubFetch({
      "/instance/logout/chip-alfa": { status: 200 },
      "/instance/delete/chip-alfa": { status: 200 },
    });

    await expect(revogarInstanciaEvolution(CREDS, "chip-alfa")).resolves.toEqual({ revogado: true });

    expect(f.mock.calls.map(([url]) => url)).toEqual([
      "http://evolution.local/instance/logout/chip-alfa",
      "http://evolution.local/instance/delete/chip-alfa",
    ]);
    for (const [url, init] of f.mock.calls) {
      expect(init.method).toBe("DELETE");
      expect((init.headers as Record<string, string>).apikey).toBe("k");
      expect(String(url)).not.toContain("apikey");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("usa a instância pedida, não a das credenciais", async () => {
    const f = stubFetch({
      "/instance/logout/chip%202": { status: 200 },
      "/instance/delete/chip%202": { status: 200 },
    });
    await expect(revogarInstanciaEvolution(CREDS, "chip 2")).resolves.toEqual({ revogado: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("servidor fora do ar (ECONNREFUSED): não lança, devolve revogado=false com motivo", async () => {
    stubFetch({
      "/instance/logout/chip-alfa": econnrefused(),
      "/instance/delete/chip-alfa": econnrefused(),
    });

    const r = await revogarInstanciaEvolution(CREDS, "chip-alfa");
    expect(r.revogado).toBe(false);
    expect(r.motivo).toEqual(expect.any(String));
  });

  it("instância inexistente (404): revogado=false, sem lançar", async () => {
    stubFetch({
      "/instance/logout/chip-alfa": { status: 404, corpo: { message: "instance does not exist" } },
      "/instance/delete/chip-alfa": { status: 404, corpo: { message: "instance does not exist" } },
    });

    const r = await revogarInstanciaEvolution(CREDS, "chip-alfa");
    expect(r.revogado).toBe(false);
    expect(r.motivo).toContain("evolution_404");
  });

  it("logout recusado por instância fechada + delete ok → revogado, sem motivo", async () => {
    const f = stubFetch({
      "/instance/logout/chip-alfa": { status: 400, corpo: { message: "The \"chip-alfa\" instance is not connected" } },
      "/instance/delete/chip-alfa": { status: 200 },
    });

    const r = await revogarInstanciaEvolution(CREDS, "chip-alfa");
    expect(f).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ revogado: true });
  });

  it("logout ok + delete recusado → não promete revogação", async () => {
    stubFetch({
      "/instance/logout/chip-alfa": { status: 200 },
      "/instance/delete/chip-alfa": { status: 500, corpo: { message: "erro interno" } },
    });

    const r = await revogarInstanciaEvolution(CREDS, "chip-alfa");
    expect(r.revogado).toBe(false);
    expect(r.motivo).toContain("evolution_500");
  });

  it("o motivo nunca carrega a apikey", async () => {
    stubFetch({
      "/instance/logout/chip-alfa": new Error("falhou com k=segredo-da-chave"),
      "/instance/delete/chip-alfa": new Error("falhou"),
    });
    const r = await revogarInstanciaEvolution({ ...CREDS, apiKey: "segredo-da-chave" }, "chip-alfa");
    expect(r.revogado).toBe(false);
    expect(r.motivo).not.toContain("segredo-da-chave");
  });
});
