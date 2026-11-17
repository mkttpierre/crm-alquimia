/**
 * As rotas do passo "Conectar WhatsApp" do wizard SEM WAHA: com a Evolution configurada, criam a
 * instância, dizem o estado dela e servem o QR (a chave do servidor nunca vai ao navegador).
 * A lógica fina está em `lib/channels/onboarding-evolution.test.ts`; aqui, só a fiação das rotas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-2222-3333-4444-555555555555";
const CANAL = { id: "canal-1", evolution_instance_name: "crm_11111111_onboarding", status: "STARTING" };

const mocks = vi.hoisted(() => ({
  carregar: vi.fn(),
  status: vi.fn(),
  qr: vi.fn(),
  conectar: vi.fn(),
  waha: vi.fn(() => null as unknown),
}));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1" }),
  resolveActiveOrg: async () => ({ orgId: ORG }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, org: { orgId: ORG }, user: { id: "user-1" } }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ tag: "db" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ tag: "admin" }) }));
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => mocks.waha() }));
vi.mock("@/lib/channels/onboarding-session", () => ({ loadOnboardingChannel: vi.fn() }));
vi.mock("@/lib/channels/connect-waha", () => ({
  connectWahaChannel: vi.fn(),
  ChannelConnectionError: class extends Error {
    constructor(public code: string, public status: number, public technical?: unknown) {
      super(code);
    }
  },
}));
vi.mock("@/lib/channels/connect-evolution", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  connectEvolutionChannel: mocks.conectar,
}));
vi.mock("@/lib/channels/onboarding-evolution", () => ({
  carregarCanalDoOnboardingEvolution: mocks.carregar,
  statusDoOnboardingEvolution: mocks.status,
  qrDoOnboardingEvolution: mocks.qr,
}));

import { GET as qrGet } from "./qr/route";
import { GET as sessionGet, POST as sessionPost } from "./session/route";

beforeEach(() => {
  for (const m of [mocks.carregar, mocks.status, mocks.qr, mocks.conectar]) m.mockReset();
  mocks.waha.mockReturnValue(null);
  vi.stubEnv("EVOLUTION_API_BASE_URL", "http://evolution:8080");
  vi.stubEnv("EVOLUTION_API_KEY", "chave-do-servidor");
  vi.stubEnv("WAHA_API_BASE_URL", "");
  vi.stubEnv("WAHA_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /onboarding/whatsapp/session sem WAHA", () => {
  it("cria a conexão do wizard pela Evolution e manda mostrar o QR", async () => {
    mocks.conectar.mockResolvedValue({ channel: { id: "canal-1", provider: "evolution", status: "STARTING" }, replay: false });
    const res = await sessionPost(new Request("http://x/api/v1/onboarding/whatsapp/session", { method: "POST" }));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data).toEqual({
      status: "SCAN_QR_CODE",
      session: "crm_11111111_onboarding",
      channel_session_id: "canal-1",
    });
    expect(mocks.conectar).toHaveBeenCalledWith(
      { tag: "admin" },
      expect.objectContaining({ organizationId: ORG, userId: "user-1", onboarding: true }),
    );
    // a chave do servidor não aparece na resposta
    expect(JSON.stringify(corpo)).not.toContain("chave-do-servidor");
  });

  it("Evolution fora do ar: erro de reparo com o status certo", async () => {
    const { ChannelConnectionError } = await import("@/lib/channels/connect-waha");
    mocks.conectar.mockRejectedValue(new ChannelConnectionError("connection_repair_required", 502));
    const res = await sessionPost(new Request("http://x/api/v1/onboarding/whatsapp/session", { method: "POST" }));
    expect(res.status).toBe(502);
  });

  it("sem WAHA e sem Evolution: continua 503 waha_not_configured", async () => {
    vi.stubEnv("EVOLUTION_API_KEY", "");
    const res = await sessionPost(new Request("http://x/api/v1/onboarding/whatsapp/session", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(mocks.conectar).not.toHaveBeenCalled();
  });
});

describe("GET /onboarding/whatsapp/session sem WAHA", () => {
  it("sem conexão: NOT_STARTED", async () => {
    mocks.carregar.mockResolvedValue(null);
    const corpo = (await (await sessionGet()).json()) as { data: { status: string } };
    expect(corpo.data.status).toBe("NOT_STARTED");
  });

  it("com conexão: o estado ao vivo, o nome da instância e o id", async () => {
    mocks.carregar.mockResolvedValue(CANAL);
    mocks.status.mockResolvedValue("WORKING");
    const corpo = (await (await sessionGet()).json()) as { data: Record<string, unknown> };
    expect(corpo.data).toEqual({ status: "WORKING", session: "crm_11111111_onboarding", channel_session_id: "canal-1" });
    expect(mocks.status).toHaveBeenCalledWith({ tag: "admin" }, { tag: "db" }, ORG, CANAL);
  });

  it("Evolution fora do ar: 502", async () => {
    mocks.carregar.mockResolvedValue(CANAL);
    mocks.status.mockRejectedValue(new Error("x"));
    expect((await sessionGet()).status).toBe(502);
  });

  it("sem WAHA e sem Evolution: WAHA_NOT_CONFIGURED, como sempre", async () => {
    vi.stubEnv("EVOLUTION_API_BASE_URL", "");
    const corpo = (await (await sessionGet()).json()) as { data: { status: string } };
    expect(corpo.data.status).toBe("WAHA_NOT_CONFIGURED");
  });
});

describe("GET /onboarding/whatsapp/qr sem WAHA", () => {
  it("serve o PNG da Evolution", async () => {
    mocks.carregar.mockResolvedValue(CANAL);
    mocks.qr.mockResolvedValue(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await qrGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(mocks.qr).toHaveBeenCalledWith({ tag: "admin" }, ORG, CANAL);
  });

  it("sem conexão ou sem QR ainda: 404; Evolution fora do ar: 502", async () => {
    mocks.carregar.mockResolvedValue(null);
    expect((await qrGet()).status).toBe(404);
    mocks.carregar.mockResolvedValue(CANAL);
    mocks.qr.mockResolvedValue(null);
    expect((await qrGet()).status).toBe(404);
    mocks.qr.mockRejectedValue(new Error("x"));
    expect((await qrGet()).status).toBe(502);
  });

  it("sem WAHA e sem Evolution: 503", async () => {
    vi.stubEnv("EVOLUTION_API_KEY", "");
    expect((await qrGet()).status).toBe(503);
  });
});
