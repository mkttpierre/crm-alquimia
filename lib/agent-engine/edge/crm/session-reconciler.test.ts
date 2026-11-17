import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createLogger } from "../../obs/logger";

import {
  deveRetomarSessao,
  reconcileSessions,
  redriveQueued,
  reiniciarEstadoDoWatchdogParaTeste,
} from "./session-reconciler";

afterEach(() => vi.restoreAllMocks());

/**
 * A regra que decide se o watchdog RELIGA a sessão. Religar FAILED é o que o
 * vigia de saúde recusa (pode ser banimento); SCAN_QR_CODE e STARTING já têm
 * dono. Só STOPPED: credencial no disco, sessão parada depois de restart.
 */
describe("deveRetomarSessao", () => {
  it("retoma só STOPPED", () => {
    expect(deveRetomarSessao("STOPPED")).toBe(true);
    expect(deveRetomarSessao("stopped")).toBe(true);
  });

  it.each(["WORKING", "STARTING", "SCAN_QR_CODE", "FAILED", ""])(
    "não religa %s — ou já está no ar, ou precisa de humano",
    (status) => {
      expect(deveRetomarSessao(status)).toBe(false);
    },
  );
});

describe("redrive pré-go-live", () => {
  it("não envia se a releitura da configuração falha", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "message-test", organization_id: "org-test", body: "Resposta de teste",
        waha_session_name: "session-test", phone_number: "+5511999998888",
        wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: "0" }] })
      .mockRejectedValueOnce(new Error("banco indisponível"));

    expect(await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger())).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("m.organization_id = $2"), ["message-test", "org-test"]);
  });
});

describe("reconcileSessions: WAHA ausente", () => {
  const cfg = {
    wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
    intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
  };
  const logDeTeste = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it("sem sessão WAHA vigiável não vai ao WAHA e não avisa", async () => {
    reiniciarEstadoDoWatchdogParaTeste();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const query = vi.fn().mockResolvedValue({ rows: [{ existe: false }] });
    const log = logDeTeste();

    for (let i = 0; i < 3; i += 1) {
      expect(await reconcileSessions({ query } as unknown as pg.Pool, cfg, log)).toBe(0);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    // a sessão-casca do histórico importado (sem_envio) não conta como sessão WAHA
    expect(query.mock.calls[0]?.[0]).toContain("sem_envio");
  });

  it("com sessão e WAHA fora do ar avisa na queda, não a cada tick, e anuncia a volta", async () => {
    reiniciarEstadoDoWatchdogParaTeste();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const query = vi.fn().mockResolvedValue({ rows: [{ existe: true }] });
    const log = logDeTeste();
    const pool = { query } as unknown as pg.Pool;

    await reconcileSessions(pool, cfg, log);
    await reconcileSessions(pool, cfg, log);
    await reconcileSessions(pool, cfg, log);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValue(new Response("[]", { status: 200 }));
    await reconcileSessions(pool, cfg, log);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("WAHA voltou"), {});
  });
});


it.each([true, "true"])("redrive nao envia quando o lead e marcado enquanto aguarda: %s", async (marca) => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ id: "m", organization_id: "o", body: "teste", waha_session_name: "s", phone_number: "+5511999998888", wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null }] })
    .mockResolvedValueOnce({ rows: [{ n: "0" }] })
    .mockResolvedValueOnce({ rows: [{ metadata: {}, phone_number: "+5511999998888", is_blocked: false, lead_custom_fields: [{ nao_contatar: marca }] }] });
  const count = await redriveQueued({ query } as unknown as pg.Pool, { wahaBaseUrl: "http://localhost", wahaApiKey: "test", intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0 }, createLogger());
  expect(count).toBe(0);
  expect(send).not.toHaveBeenCalled();
  // Sai da fila como falha definitiva, para não ocupar o lote para sempre.
  expect(query).toHaveBeenCalledWith(expect.stringContaining("error_code = 'nao_contatar'"), ["m", "o"]);
});
