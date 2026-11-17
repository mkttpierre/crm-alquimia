import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Item 6 (auditoria 05/11/2026): descartes e itens sem key.id fechavam o arquivo do
 * webhook como `processed` SEM nenhum registro. Agora o desfecho carrega a contagem
 * em `error_message` (o status segue `processed`: a mensagem boa foi ingerida).
 */

const state = vi.hoisted(() => ({
  corpo: {} as Record<string, unknown>,
  fechado: null as null | { status: string; erro?: string | null },
}));

vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => null }));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async (primeira: () => unknown) => primeira(),
}));
vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  abrirArquivoDoWebhook: async () => "log-1",
  fecharArquivoDoWebhook: async (_a: unknown, _id: unknown, d: { status: string; erro?: string | null }) => {
    state.fechado = d;
  },
}));
vi.mock("@/lib/channels/inbound", () => ({
  acceptsInboundWebhook: () => true,
  descartarAntesDeArquivar: () => null,
  corpoParaArquivarEIngerir: (_p: string, corpo: string) => corpo,
  exigeSegredoDeAssinatura: () => false,
  handleInboundWebhook: async () => ({ ok: true, body: state.corpo }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

// O `admin.from("channel_sessions")...maybeSingle()` da rota.
vi.mock("@/lib/supabase/admin", () => {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => ({
    data: { id: "s-1", organization_id: "org-1", provider: "evolution", display_name: null, phone_number: null, webhook_secret_encrypted: null },
    error: null,
  });
  return { createAdminClient: () => ({ from: () => q }) };
});

import { POST } from "./route";

async function chamar() {
  const req = new NextRequest("http://localhost/api/v1/webhooks/channel/token-comprido-ok", { method: "POST", body: "{}" });
  return POST(req, { params: Promise.resolve({ token: "token-comprido-ok" }) });
}

beforeEach(() => {
  state.fechado = null;
});

describe("arquivo do webhook registra o que foi descartado", () => {
  it("itens malformados (descartados) e sem key.id aparecem no erro do arquivo", async () => {
    state.corpo = { status: "processed", eventos: 1, descartados: 2, sem_id: 3 };
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(state.fechado?.status).toBe("processed");
    expect(state.fechado?.erro).toContain("descartados=2");
    expect(state.fechado?.erro).toContain("sem_id=3");
  });

  it("lote limpo continua sem erro", async () => {
    state.corpo = { status: "processed", eventos: 2, descartados: 0 };
    await chamar();
    expect(state.fechado).toMatchObject({ status: "processed", erro: null });
  });

  it("o motivo de 'ignored' continua indo para o erro (comportamento anterior)", async () => {
    state.corpo = { status: "ignored", reason: "instancia_divergente" };
    await chamar();
    expect(state.fechado?.erro).toBe("instancia_divergente");
  });
});
