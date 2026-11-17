/**
 * ORGANIZAÇÃO COM AGENTE EXTERNO NÃO TEM HANDOFF POR SENTIMENTO DO UPSTREAM.
 *
 * ## O defeito (confirmado no código, 14/10/2026)
 *
 * `isAiGatewayConfigured()` fica verdadeiro com só `OPENROUTER_API_KEY`, e o
 * `ai-sentiment-worker` roda MESMO sem agente publicado. Nota baixa emite
 * `ai.sentiment_alert`; o handler chama `triggerHandoff`, que silencia a conversa
 * para sempre (`bot_silenced_until='infinity'`) e chama `avisarLeadDoCrm`, que
 * manda um TEXTO REAL à lead — fora da trava `DISPARO_REAL_LIBERADO`. Nas orgs do
 * organização A e da organização B (`ai_dispatch_mode='external'`, decisão D1) quem silencia e quem
 * fala é o atendimento próprio, atrás da trava dele.
 *
 * ## Por que os casos são estes
 *
 * Cada caso de "pula" tem um irmão que NÃO pula (org nativa, ausente ou null), na
 * mesma montagem: sem o irmão, um guard que pula sempre aprovaria os dois.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "",
  AI_GATEWAY_API_KEY: "",
  OPENROUTER_API_KEY: "sk-or-teste",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

type Resposta = { data: unknown; error: { message: string } | null };
let organizacao: Resposta = { data: { settings: {} }, error: null };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(tabela === "organizations" ? organizacao : { data: null, error: null }),
      };
      return chain;
    },
    rpc: vi.fn(),
  }),
}));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn(async () => null) }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/atendimento/origem-mensagem", () => ({
  serviceFromMessage: vi.fn(async () => ({
    organization_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "33333333-3333-4333-8333-333333333333",
    contact_id: "44444444-4444-4444-8444-444444444444",
  })),
}));
const triggerHandoff = vi.fn(async (..._a: unknown[]) => ({ triggered: true, reason: "ok" }));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: (...a: unknown[]) => triggerHandoff(...a) }));

import { generateObject } from "ai";

import { orgTemAgenteExterno } from "@/lib/ai/agente-externo";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";
import { processSentiment } from "@/workers/ai-sentiment-worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";

const evento = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  organization_id: ORG,
  entity_id: MSG,
  payload: { message_id: MSG, conversation_id: CONV, sentiment_score: 0.05 },
} as unknown as EventRow;

const externa: Resposta = { data: { settings: { ai_dispatch_mode: "external" } }, error: null };
const nativa: Resposta = { data: { settings: { ai_dispatch_mode: "native" } }, error: null };
const semChave: Resposta = { data: { settings: { llm: {} } }, error: null };
const nula: Resposta = { data: { settings: null }, error: null };
const quebrada: Resposta = { data: null, error: { message: "db down" } };

beforeEach(() => {
  vi.clearAllMocks();
  organizacao = nativa;
});

describe("orgTemAgenteExterno", () => {
  it.each([
    ["external", externa, true],
    ["native", nativa, false],
    ["chave ausente", semChave, false],
    ["settings null", nula, false],
    ["erro de leitura (fail-closed)", quebrada, true],
  ] as const)("%s", async (_nome, resposta, esperado) => {
    organizacao = resposta;
    expect(await orgTemAgenteExterno(createAdminClient(), ORG)).toBe(esperado);
  });
});

describe("worker de sentimento", () => {
  it("org externa: pula ANTES de resolver modelo ou chamar o Haiku", async () => {
    organizacao = externa;
    const r = await processSentiment(evento);
    expect(r).toEqual({ skipped: true, reason: "agente_externo" });
    expect(resolverModeloDoPonto).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("org externa e leitura quebrada: pula igual (fail-closed)", async () => {
    organizacao = quebrada;
    const r = await processSentiment(evento);
    expect(r.reason).toBe("agente_externo");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("org nativa: passa pelo guard e segue para resolver o modelo (o irmão que não pula)", async () => {
    organizacao = nativa;
    await processSentiment(evento);
    expect(resolverModeloDoPonto).toHaveBeenCalledOnce();
  });
});

describe("handler do handoff por sentimento", () => {
  it("org externa: NÃO chama triggerHandoff (nem silencia, nem avisa a lead)", async () => {
    organizacao = externa;
    const r = await aiHandoffFromSentimentHandler.handle(evento);
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("agente_externo");
    expect(triggerHandoff).not.toHaveBeenCalled();
  });

  it("alerta antigo no event_log + org virou externa depois: também pula", async () => {
    organizacao = externa;
    const antigo = { ...evento, payload: { message_id: MSG, sentiment_score: 0.01 } } as unknown as EventRow;
    const r = await aiHandoffFromSentimentHandler.handle(antigo);
    expect(r.detail).toBe("agente_externo");
    expect(triggerHandoff).not.toHaveBeenCalled();
  });

  it("org externa e leitura quebrada: pula (fail-closed)", async () => {
    organizacao = quebrada;
    const r = await aiHandoffFromSentimentHandler.handle(evento);
    expect(r.detail).toBe("agente_externo");
    expect(triggerHandoff).not.toHaveBeenCalled();
  });

  it("org nativa: o handoff por sentimento continua funcionando (o irmão que não pula)", async () => {
    organizacao = nativa;
    const r = await aiHandoffFromSentimentHandler.handle(evento);
    expect(triggerHandoff).toHaveBeenCalledOnce();
    expect(triggerHandoff).toHaveBeenCalledWith(expect.objectContaining({ reason: "low_sentiment", organizationId: ORG }));
    expect(r.status).toBe("ok");
  });
});
