import { afterEach, expect, it, vi } from "vitest";
import { conectarInstancia } from "./client";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("ao conectar preserva as configurações e desativa syncFullHistory", async () => {
  const creds = { baseUrl: "https://evolution.test", apiKey: "test", instance: "chip", source: "session" as const };
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("/settings/find/")) return Response.json({ rejectCall: true, groupsIgnore: true, msgCall: "ocupado", alwaysOnline: false, readMessages: false, readStatus: true, syncFullHistory: true, wavoipToken: "not-for-settings-set" });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  await conectarInstancia(creds);
  const chamada = fetchMock.mock.calls.find(([url]) => String(url).includes("/settings/set/"));
  expect(chamada).toBeDefined();
  const init = (chamada as unknown as [string, RequestInit])[1];
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ rejectCall: true, groupsIgnore: true, msgCall: "ocupado", alwaysOnline: false, readMessages: false, readStatus: true, syncFullHistory: false });
});


it("limita a espera total por close mesmo quando a consulta trava", async () => {
  vi.useFakeTimers();
  const inicio = Date.now();
  // AbortSignal.timeout usa relógio nativo no Node; a consulta simulada consome
  // os 5s por tentativa, enquanto o orçamento total deve impedir uma terceira.
  vi.stubGlobal("fetch", vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return Response.json({ state: "open" });
  }));
  const { aguardarInstanciaFechada } = await import("./client");
  try {
    const result = aguardarInstanciaFechada({ baseUrl: "https://evolution.test", apiKey: "test", instance: "chip", source: "session" });
    const assertion = expect(result).rejects.toThrow("evolution_logout_timeout");
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(Date.now() - inicio).toBe(10000);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
