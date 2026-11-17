/**
 * Leitura das mensagens gravadas na Evolution (`POST /chat/findMessages/{instância}`), usada pela
 * reconciliação de entrada. Formato conferido no código da 2.3.7 (`fetchMessages`): filtro em
 * `where.messageTimestamp` só vale com `gte` E `lte` (ISO), paginação por `page` (1-based) e
 * `offset` (= tamanho da página), ordem do mais novo para o mais velho, resposta em
 * `{ messages: { total, pages, currentPage, records } }`. `where.key.fromMe: false` é IGNORADO pela
 * Evolution (falsy), então o filtro de direção fica do nosso lado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { buscarMensagens } from "./client";

const CREDS = { baseUrl: "http://evolution.local", apiKey: "k", instance: "chip-alfa", source: "session" as const };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(resposta: unknown, status = 200) {
  const f = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(resposta), { status }));
  vi.stubGlobal("fetch", f);
  return f;
}

describe("buscarMensagens", () => {
  it("POST em /chat/findMessages/<instância> com janela, página e apikey no header", async () => {
    const f = stubFetch({ messages: { total: 1, pages: 1, currentPage: 1, records: [{ key: { id: "A" } }] } });
    const desde = new Date("2026-11-09T12:00:00.000Z");
    const ate = new Date("2026-11-10T12:00:00.000Z");
    await buscarMensagens(CREDS, { desde, ate, pagina: 2, porPagina: 100 });

    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://evolution.local/chat/findMessages/chip-alfa");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).apikey).toBe("k");
    expect(String(url)).not.toContain("apikey");
    expect(JSON.parse(String(init.body))).toEqual({
      where: { messageTimestamp: { gte: desde.toISOString(), lte: ate.toISOString() } },
      page: 2,
      offset: 100,
    });
    // Tempo limite sempre: a reconciliação não pode pendurar o cron numa Evolution travada.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("normaliza a resposta (total, páginas, registros)", async () => {
    stubFetch({ messages: { total: 3, pages: 2, currentPage: 1, records: [{ key: { id: "A" } }, { key: { id: "B" } }] } });
    const r = await buscarMensagens(CREDS, { desde: new Date(0), ate: new Date(), pagina: 1, porPagina: 2 });
    expect(r).toEqual({ total: 3, paginas: 2, registros: [{ key: { id: "A" } }, { key: { id: "B" } }] });
  });

  it("resposta fora de forma vira página vazia, não exceção", async () => {
    stubFetch({ algo: "inesperado" });
    const r = await buscarMensagens(CREDS, { desde: new Date(0), ate: new Date(), pagina: 1, porPagina: 50 });
    expect(r).toEqual({ total: 0, paginas: 0, registros: [] });
  });

  it("HTTP de erro lança com o prefixo evolution_<status>", async () => {
    stubFetch({ error: "x" }, 500);
    await expect(buscarMensagens(CREDS, { desde: new Date(0), ate: new Date(), pagina: 1, porPagina: 50 })).rejects.toThrow(
      /^evolution_500/,
    );
  });
});
