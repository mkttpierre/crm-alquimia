/**
 * Webhook GLOBAL da Evolution: o instalador cadastra UMA url para todas as
 * instâncias, com um segredo no caminho (`EVOLUTION_WEBHOOK_TOKEN`). A rota acha
 * a conexão pelo NOME DA INSTÂNCIA do corpo, e só quando o token bate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TOKEN_GLOBAL = "token-global-da-instalacao-0123456789";

const state = vi.hoisted(() => ({
  filtros: [] as Array<[string, unknown]>,
  sessao: null as null | Record<string, unknown>,
  ingeriu: 0,
  erro: null as null | { code: string },
  env: { EVOLUTION_WEBHOOK_TOKEN: "" },
}));

vi.mock("@/lib/env", () => ({ env: state.env }));

vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => null }));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async (primeira: () => unknown) => primeira(),
}));
vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  abrirArquivoDoWebhook: async () => "log-1",
  fecharArquivoDoWebhook: async () => undefined,
}));
vi.mock("@/lib/channels/inbound", () => ({
  acceptsInboundWebhook: () => true,
  descartarAntesDeArquivar: () => null,
  corpoParaArquivarEIngerir: (_p: string, corpo: string) => corpo,
  exigeSegredoDeAssinatura: () => false,
  handleInboundWebhook: async () => {
    state.ingeriu += 1;
    return { ok: true, body: { status: "processed", eventos: 1 } };
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (coluna: string, valor: unknown) => {
    state.filtros.push([coluna, valor]);
    return q;
  };
  q.is = (coluna: string, valor: unknown) => {
    state.filtros.push([`${coluna} is`, valor]);
    return q;
  };
  q.maybeSingle = async () => ({ data: state.erro ? null : state.sessao, error: state.erro });
  return { createAdminClient: () => ({ from: () => q }) };
});

import { POST } from "./route";

const SESSAO = {
  id: "s-1",
  organization_id: "org-1",
  provider: "evolution",
  display_name: null,
  phone_number: null,
  webhook_secret_encrypted: null,
  archived_at: null,
};

async function chamar(token: string, corpo: unknown) {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/evolution/${token}`, {
    method: "POST",
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });
  return POST(req, { params: Promise.resolve({ token }) });
}

beforeEach(() => {
  state.filtros = [];
  state.sessao = SESSAO;
  state.ingeriu = 0;
  state.erro = null;
  state.env.EVOLUTION_WEBHOOK_TOKEN = TOKEN_GLOBAL;
});

describe("webhook global da Evolution (token do ambiente + instância do corpo)", () => {
  it("token global válido: acha a conexão pelo nome da instância, não pelo token", async () => {
    const res = await chamar(TOKEN_GLOBAL, { event: "messages.upsert", instance: "crm_abc_1" });
    expect(res.status).toBe(200);
    expect(state.ingeriu).toBe(1);
    expect(state.filtros).toContainEqual(["provider", "evolution"]);
    expect(state.filtros).toContainEqual(["evolution_instance_name", "crm_abc_1"]);
    expect(state.filtros).toContainEqual(["archived_at is", null]);
    // só as conexões do servidor único (sem servidor próprio), que o índice único da instância garante
    expect(state.filtros).toContainEqual(["evolution_base_url is", null]);
    expect(state.filtros.some(([c]) => c === "webhook_path_token")).toBe(false);
  });

  it("instância que não é de nenhuma conexão ativa: 200 ignorado, nada ingerido", async () => {
    state.sessao = null;
    const res = await chamar(TOKEN_GLOBAL, { event: "messages.upsert", instance: "criada-na-mao" });
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { status: string; reason: string } };
    expect(corpo.data).toMatchObject({ status: "ignored", reason: "instancia_desconhecida" });
    expect(state.ingeriu).toBe(0);
  });

  it("token global válido mas corpo sem instância: 200 ignorado", async () => {
    const res = await chamar(TOKEN_GLOBAL, "isto nao e json");
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { reason: string } };
    expect(corpo.data.reason).toBe("instancia_ausente");
    expect(state.ingeriu).toBe(0);
  });

  it("token errado continua sendo o caminho por token da sessão (e 404 se não existe)", async () => {
    state.sessao = null;
    const res = await chamar("token-que-nao-e-o-global-xxxxxxxx", { instance: "crm_abc_1" });
    expect(res.status).toBe(404);
    expect(state.filtros).toContainEqual(["webhook_path_token", "token-que-nao-e-o-global-xxxxxxxx"]);
  });

  it("sem EVOLUTION_WEBHOOK_TOKEN no ambiente, nenhum token vale como global", async () => {
    state.env.EVOLUTION_WEBHOOK_TOKEN = "";
    state.sessao = null;
    const res = await chamar(TOKEN_GLOBAL, { instance: "crm_abc_1" });
    expect(res.status).toBe(404);
    expect(state.filtros.some(([c]) => c === "evolution_instance_name")).toBe(false);
  });

  it("token global curto demais (menos de 16) é ignorado como global", async () => {
    state.env.EVOLUTION_WEBHOOK_TOKEN = "curtinho-12345";
    state.sessao = null;
    const res = await chamar("curtinho-12345", { instance: "crm_abc_1" });
    expect(res.status).toBe(404);
  });

  it("falha da CONSULTA vira 500 (a Evolution reentrega) e fica registrada, não 'desconhecida'", async () => {
    state.erro = { code: "XX000" };
    const res = await chamar(TOKEN_GLOBAL, { event: "messages.upsert", instance: "crm_abc_1" });
    expect(res.status).toBe(500);
    expect(state.ingeriu).toBe(0);
    const { logger } = await import("@/lib/logger");
    expect(logger.error).toHaveBeenCalledWith(
      "[webhook-canal] consulta da sessão falhou",
      expect.objectContaining({ via: "token_global", code: "XX000" }),
    );
  });
});
