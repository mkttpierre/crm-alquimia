import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { resolveEvolutionCreds } from "@/lib/channels/evolution/credentials";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(async () => ({ ok: true, user: { id: "user", idioma: "pt-BR" }, org: { orgId: "org" } })) }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => ({ id: "user" })), resolveActiveOrg: vi.fn(async () => ({ orgId: "org" })), mfaEmDivida: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/channels/evolution/credentials", () => ({ resolveEvolutionCreds: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const row = { id: "chip", organization_id: "org", provider: "evolution", evolution_instance_name: "chip-gama", waha_session_name: null, archived_at: null, status: "STOPPED" };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
let patches: Record<string, unknown>[];
const ctx = { params: Promise.resolve({ id: "chip" }) };
beforeEach(() => {
  patches = [];
  const db = { from: () => {
    let patch: Record<string, unknown> | undefined;
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }), update: (p: Record<string, unknown>) => { patch = p; return q; }, then: (resolve: (v: unknown) => void) => { if (patch) patches.push(patch); resolve({ error: null }); } };
    return q;
  } };
  vi.mocked(createClient).mockResolvedValue(db as never);
  vi.mocked(resolveEvolutionCreds).mockResolvedValue({ baseUrl: "https://evolution.test", apiKey: "secret", instance: "chip-gama", source: "session" });
});

it("reconecta Evolution e registra estado de leitura do QR", async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("connectionState") ? { instance: { state: "close" } } : String(url).includes("settings/find") ? { syncFullHistory: true } : { base64: "data:image/png;base64,YWJj" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const { POST } = await import("./reconnect/route");
  const res = await POST(new NextRequest("http://localhost", { method: "POST", body: "{}" }), ctx);
  expect(res.status).toBe(200);
  expect((await res.json()).data.status).toBe("SCAN_QR_CODE");
  expect(patches).toContainEqual(expect.objectContaining({ status: "SCAN_QR_CODE" }));
  expect(fetchMock).toHaveBeenCalledWith("https://evolution.test/instance/connect/chip-gama", expect.objectContaining({ headers: expect.objectContaining({ apikey: "secret" }) }));
});

it("QR Evolution devolve bytes PNG", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("settings/find") ? { syncFullHistory: false } : { base64: "data:image/png;base64,YWJj" }))));
  const { GET } = await import("./qr/route");
  const res = await GET(new Request("http://localhost"), ctx);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(await res.text()).toBe("abc");
});

it("ao detectar Evolution aberta, sincroniza WORKING no health check", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instance: { state: "open" } }))));
  const { GET } = await import("./route");
  const res = await GET(new NextRequest("http://localhost"), ctx);
  expect((await res.json()).data.status).toBe("WORKING");
  expect(patches).toContainEqual(expect.objectContaining({ status: "WORKING" }));
});

const WEBHOOK_COMPLETO = { url: "https://crm.test/api/v1/webhooks/evolution/tok", enabled: true, events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "MESSAGES_DELETE", "MESSAGES_EDITED", "SEND_MESSAGE", "CONNECTION_UPDATE", "CALL"] };

it("reconexão de instância já aberta informa WORKING sem pedir novo pareamento", async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request) =>
    Response.json(String(url).includes("webhook/find") ? WEBHOOK_COMPLETO : { instance: { state: "open" } }));
  vi.stubGlobal("fetch", fetchMock);
  const { POST } = await import("./reconnect/route");
  const res = await POST(new NextRequest("http://localhost", { method: "POST", body: "{}" }), ctx);
  const body = await res.json();
  expect(body.data.status).toBe("WORKING");
  expect(body.data.warning).toBeNull();
  expect(patches).toContainEqual(expect.objectContaining({ status: "WORKING" }));
  // Estado + leitura do webhook (já completo: nada a escrever). Nenhum QR, nenhum logout.
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("instância já aberta ganha os eventos novos pela reconexão, sem QR nem logout", async () => {
  const chamadas: Array<{ rota: string; corpo?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    chamadas.push({ rota: `${init?.method} ${path}`, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.includes("connectionState")) return Response.json({ instance: { state: "open" } });
    if (path.includes("webhook/find")) return Response.json({ url: WEBHOOK_COMPLETO.url, enabled: true, events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"] });
    return Response.json({});
  }));
  const { POST } = await import("./reconnect/route");
  const res = await POST(new NextRequest("http://localhost", { method: "POST", body: "{}" }), ctx);
  expect((await res.json()).data.status).toBe("WORKING");
  expect(chamadas.map((c) => c.rota)).toEqual([
    "GET /instance/connectionState/chip-gama",
    "GET /webhook/find/chip-gama",
    "POST /webhook/set/chip-gama",
  ]);
  const webhook = (chamadas[2]!.corpo as { webhook: { url: string; events: string[] } }).webhook;
  expect(webhook.url).toBe(WEBHOOK_COMPLETO.url);
  expect([...webhook.events].sort()).toEqual([...WEBHOOK_COMPLETO.events].sort());
});

it("forçar novo QR solicita connect novamente", async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("connectionState") ? { instance: { state: "close" } } : String(url).includes("settings/find") ? { syncFullHistory: true } : { base64: "data:image/png;base64,YWJj" })));
  vi.stubGlobal("fetch", fetchMock);
  const { POST } = await import("./reconnect/route");
  const res = await POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), ctx);
  expect(res.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledWith("https://evolution.test/instance/connect/chip-gama", expect.anything());
});

it("repareia Evolution aberta somente depois do logout e fechamento", async () => {
  const chamadas: string[] = [];
  let consultas = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    chamadas.push(`${init?.method} ${path}`);
    if (path.includes("connectionState")) return Response.json({ instance: { state: ++consultas === 1 ? "open" : "close" } });
    if (path.includes("settings/find")) return Response.json({ syncFullHistory: true });
    if (path.includes("webhook/find")) return Response.json(WEBHOOK_COMPLETO);
    return Response.json({ base64: "data:image/png;base64,YWJj" });
  }));
  const { POST } = await import("./reconnect/route");
  const res = await POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), ctx);
  expect(res.status).toBe(200);
  expect((await res.json()).data.status).toBe("SCAN_QR_CODE");
  expect(chamadas).toEqual([
    "GET /instance/connectionState/chip-gama",
    // Os eventos entram ANTES do pareamento, para a primeira mensagem já chegar.
    "GET /webhook/find/chip-gama",
    "GET /settings/find/chip-gama",
    "POST /settings/set/chip-gama",
    "DELETE /instance/logout/chip-gama",
    "GET /instance/connectionState/chip-gama",
    "GET /instance/connect/chip-gama",
  ]);
});


it.each(["find", "set"])("falha em settings/%s avisa mas ainda permite parear", async (falha) => {
  let consultas = 0;
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path.includes("connectionState")) return Response.json({ state: ++consultas === 1 ? "open" : "close" });
    if (path.includes(`settings/${falha}`)) return new Response("upstream private error", { status: 500 });
    if (path.includes("settings/find")) return Response.json({ syncFullHistory: true });
    return Response.json({ base64: "data:image/png;base64,YWJj" });
  }));
  const { POST } = await import("./reconnect/route");
  const res = await POST(new NextRequest("http://localhost", { method: "POST", body: '{"force":true}' }), ctx);
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.data.warning).toMatch(/histórico/i);
  expect(paths.indexOf(`/settings/${falha}/chip-gama`)).toBeLessThan(paths.indexOf("/instance/logout/chip-gama"));
  expect(paths.at(-1)).toBe("/instance/connect/chip-gama");
  expect(JSON.stringify(body)).not.toContain("private error");
  expect(JSON.stringify(body)).not.toContain("secret");
});

it("QR JSON entrega só QR e código de pareamento formatado, sem credenciais", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes("settings/find")
    ? { syncFullHistory: false }
    : { base64: "data:image/png;base64,YWJj", pairingCode: "ABCD1234", apikey: "private" })));
  const { GET } = await import("./qr/route");
  const res = await GET(new Request("http://localhost?format=json"), ctx);
  expect(await res.json()).toEqual({ data: { base64: "data:image/png;base64,YWJj", pairing_code: "ABCD-1234", warning: null } });
  expect(res.headers.get("cache-control")).toContain("no-store");
});


it("timeout informa fechamento pendente e nunca chama connect", async () => {
  vi.useFakeTimers();
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.includes("connectionState")) return Response.json({ state: "open" });
    return Response.json({ syncFullHistory: false });
  }));
  const { POST } = await import("./reconnect/route");
  const pending = POST(new NextRequest("http://localhost", { method: "POST", body: '{"force":true}' }), ctx);
  await vi.advanceTimersByTimeAsync(10_000);
  const response = await pending;
  expect(response.status).toBe(502);
  expect((await response.json()).error.message).toMatch(/10 segundos/);
  expect(paths.some((path) => path.includes("/instance/connect/"))).toBe(false);
});

it("logout falho não tenta conectar nem excluir a instância", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.includes("connectionState")) return Response.json({ state: "open" });
    if (path.includes("logout")) return new Response("private", { status: 500 });
    return Response.json({ syncFullHistory: false });
  }));
  const { POST } = await import("./reconnect/route");
  const response = await POST(new NextRequest("http://localhost", { method: "POST", body: '{"force":true}' }), ctx);
  expect(response.status).toBe(502);
  expect(paths.at(-1)).toBe("/instance/logout/chip-gama");
  expect(patches).toHaveLength(0);
});


it("recusa outro tenant sem consultar credenciais nem chamar Evolution", async () => {
  const filtros: Record<string, string> = {};
  const q = { select: () => q, eq: (key: string, value: string) => { filtros[key] = value; return q; },
    maybeSingle: async () => ({ data: filtros.organization_id === "outra-org" ? row : null, error: null }) };
  vi.mocked(createClient).mockResolvedValue({ from: () => q } as never);
  vi.mocked(resolveEvolutionCreds).mockClear();
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const { POST } = await import("./reconnect/route");
  const response = await POST(new NextRequest("http://localhost", { method: "POST", body: '{"force":true,"organization_id":"outra-org"}' }), ctx);
  expect(response.status).toBe(404);
  expect(filtros).toEqual({ organization_id: "org", id: "chip" });
  expect(resolveEvolutionCreds).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("nega reconexão sem permissão de administrador antes de qualquer chamada", async () => {
  vi.mocked(requireRole).mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) } as never);
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const { POST } = await import("./reconnect/route");
  const response = await POST(new NextRequest("http://localhost", { method: "POST", body: '{"force":true}' }), ctx);
  expect(response.status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});
