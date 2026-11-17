import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __limparCacheParaTeste,
  listaDaInstalacao,
} from "@/lib/ai/provedores/lista-da-instalacao";

/**
 * A lista VIVA do provedor que tem chave no ambiente da instalação. Antes a
 * tela listava o catálogo `ai_models` como se fosse o que a chave libera — e,
 * com a chave ausente, mostrava modelo para provedor que nem conectado estava.
 *
 * Só fetch falso: a chamada real é a provedor de API paga.
 */

const SEGREDO = "sk-or-v1-segredo";

function fetchFalso(respostas: Record<string, { status: number; body?: unknown }>) {
  const chamadas: { url: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({ url, init });
    const chave = Object.keys(respostas).find((k) => url.includes(k));
    const r = chave ? respostas[chave]! : { status: 404 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    } as unknown as Response;
  });
  return { f, chamadas };
}

afterEach(() => {
  __limparCacheParaTeste();
  vi.unstubAllGlobals();
});

describe("listaDaInstalacao", () => {
  it("sem a chave do provedor no ambiente não busca nada", async () => {
    const { f } = fetchFalso({});
    vi.stubGlobal("fetch", f);
    const r = await listaDaInstalacao("anthropic", { fonte: { ANTHROPIC_API_KEY: "" } });
    expect(r).toEqual({ conferida: false, motivo: "sem_chave", modelos: [], lidaEm: null });
    expect(f).not.toHaveBeenCalled();
  });

  it("lê a lista viva com a chave do ambiente, só conversa, com ferramentas, e nunca devolve a chave", async () => {
    const { f, chamadas } = fetchFalso({
      "/api/v1/key": { status: 200 },
      "/api/v1/models": {
        status: 200,
        body: {
          data: [
            { id: "a/chat", supported_parameters: ["tools"] },
            { id: "b/chat-sem-tools", supported_parameters: [] },
            { id: "openai/text-embedding-3-small" },
          ],
        },
      },
    });
    vi.stubGlobal("fetch", f);
    const r = await listaDaInstalacao("openrouter", {
      fonte: { OPENROUTER_API_KEY: SEGREDO },
      agora: new Date("2026-11-16T03:00:00.000Z"),
    });
    expect(r.conferida).toBe(true);
    expect(r.lidaEm).toBe("2026-11-16T03:00:00.000Z");
    expect(r.modelos).toEqual([
      { model_id: "a/chat", supports_tools: true },
      { model_id: "b/chat-sem-tools", supports_tools: false },
    ]);
    expect(JSON.stringify(r)).not.toContain(SEGREDO);
    // A chave vai no cabeçalho, nunca na URL.
    expect(chamadas.map((c) => c.url).join(" ")).not.toContain(SEGREDO);
  });

  it("guarda em memória por 1 h por provedor", async () => {
    const { f } = fetchFalso({
      "/api/v1/key": { status: 200 },
      "/api/v1/models": { status: 200, body: { data: [{ id: "a/chat" }] } },
    });
    vi.stubGlobal("fetch", f);
    const fonte = { OPENROUTER_API_KEY: SEGREDO };
    const t0 = new Date("2026-11-16T03:00:00.000Z");
    await listaDaInstalacao("openrouter", { fonte, agora: t0 });
    const chamadasDepoisDaPrimeira = f.mock.calls.length;
    await listaDaInstalacao("openrouter", { fonte, agora: new Date(t0.getTime() + 59 * 60_000) });
    expect(f.mock.calls.length).toBe(chamadasDepoisDaPrimeira);
    await listaDaInstalacao("openrouter", { fonte, agora: new Date(t0.getTime() + 61 * 60_000) });
    expect(f.mock.calls.length).toBeGreaterThan(chamadasDepoisDaPrimeira);
  });

  it("falha do provedor é 'lista não conferida', sem lista nenhuma", async () => {
    const { f } = fetchFalso({ "/api/v1/key": { status: 401 } });
    vi.stubGlobal("fetch", f);
    const r = await listaDaInstalacao("openrouter", { fonte: { OPENROUTER_API_KEY: SEGREDO } });
    expect(r).toEqual({ conferida: false, motivo: "auth_failed_401", modelos: [], lidaEm: null });
  });

  it("chave válida com catálogo fora do ar também é 'não conferida'", async () => {
    const { f } = fetchFalso({ "/api/v1/key": { status: 200 }, "/api/v1/models": { status: 503 } });
    vi.stubGlobal("fetch", f);
    const r = await listaDaInstalacao("openrouter", { fonte: { OPENROUTER_API_KEY: SEGREDO } });
    expect(r.conferida).toBe(false);
    expect(r.modelos).toEqual([]);
  });
});
