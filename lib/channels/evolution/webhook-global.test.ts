/**
 * Com o webhook GLOBAL da Evolution ligado (instalação local de um comando), a instância não
 * tem URL própria — e o aviso "esta conexão não tem webhook" seria falso: as mensagens chegam
 * pela URL do servidor. Sem o webhook global, o aviso continua valendo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assinarEventosDoWebhook, webhookGlobalLigado } from "./client";
import { ehTokenGlobal, instanciaDoCorpo } from "./webhook-global";

const creds = { baseUrl: "https://evolution.test", apiKey: "chave", instance: "crm_abc_1", source: "env" as const };

function evolutionSemWebhookProprio() {
  const chamadas: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      chamadas.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      // A Evolution devolve null (ou objeto sem url) para instância sem webhook próprio.
      return Response.json(null);
    }),
  );
  return chamadas;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllEnvs());

describe("webhookGlobalLigado", () => {
  it.each(["true", "1", "sim", "TRUE", " on "])("%j liga", (valor) => {
    vi.stubEnv("EVOLUTION_WEBHOOK_GLOBAL", valor);
    expect(webhookGlobalLigado()).toBe(true);
  });

  it.each(["", "false", "0", "nao", "talvez"])("%j não liga", (valor) => {
    vi.stubEnv("EVOLUTION_WEBHOOK_GLOBAL", valor);
    expect(webhookGlobalLigado()).toBe(false);
  });
});

describe("assinarEventosDoWebhook com o webhook global", () => {
  it("ligado: instância sem URL própria não gera aviso e não escreve nada", async () => {
    vi.stubEnv("EVOLUTION_WEBHOOK_GLOBAL", "true");
    const chamadas = evolutionSemWebhookProprio();
    expect(await assinarEventosDoWebhook(creds)).toBeNull();
    expect(chamadas).toEqual(["GET /webhook/find/crm_abc_1"]);
  });

  it("desligado: o aviso de instância sem webhook continua", async () => {
    vi.stubEnv("EVOLUTION_WEBHOOK_GLOBAL", "");
    evolutionSemWebhookProprio();
    expect(await assinarEventosDoWebhook(creds)).toMatch(/webhook/i);
  });
});

describe("ehTokenGlobal e instanciaDoCorpo (webhook global)", () => {
  const SEGREDO = "segredo-global-com-mais-de-16-caracteres";

  it("só o segredo exato, com pelo menos 16 caracteres, vale", () => {
    expect(ehTokenGlobal(SEGREDO, SEGREDO)).toBe(true);
    expect(ehTokenGlobal(`${SEGREDO}x`, SEGREDO)).toBe(false);
    expect(ehTokenGlobal("outro-segredo-de-mesmo-tamanho-aa", SEGREDO)).toBe(false);
    expect(ehTokenGlobal("curto", "curto")).toBe(false);
    expect(ehTokenGlobal(SEGREDO, "")).toBe(false);
    expect(ehTokenGlobal(SEGREDO, undefined)).toBe(false);
  });

  it("lê o nome da instância do corpo; corpo ruim ou sem instância é null", () => {
    expect(instanciaDoCorpo('{"event":"x","instance":"crm_a_1"}')).toBe("crm_a_1");
    expect(instanciaDoCorpo('{"instance":"  "}')).toBeNull();
    expect(instanciaDoCorpo('{"instance":3}')).toBeNull();
    expect(instanciaDoCorpo("não é json")).toBeNull();
  });
});
