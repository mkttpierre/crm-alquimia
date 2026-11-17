import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("apiClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("t1: POST injects Idempotency-Key (uuid) and X-Request-Id headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    await apiClient.post("/x", { a: 1 });
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["X-Request-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("t2: GET injects X-Request-Id but NOT Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    await apiClient.get("/x");
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["X-Request-Id"]).toBeTruthy();
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("t3: 200 response returns parsed JSON", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { hello: "world" } }));
    const result = await apiClient.get<{ data: { hello: string } }>("/x");
    expect(result).toEqual({ data: { hello: "world" } });
  });

  it("t4: 422 response throws ApiError with status, code, and fieldErrors in details", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: {
          code: "validation_error",
          message: "Validation failed",
          details: { fieldErrors: { name: ["Required"] } },
        },
      }),
    );
    await expect(apiClient.post("/x", {})).rejects.toMatchObject({
      status: 422,
      code: "validation_error",
      details: { fieldErrors: { name: ["Required"] } },
    });
  });

  it("t5: 500 response throws ApiError immediately (no retry)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: { code: "internal_error", message: "boom" } }),
    );
    await expect(apiClient.get("/x")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("t6: 429 with Retry-After=1 retries once and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          429,
          { error: { code: "rate_limited", message: "slow down" } },
          { "Retry-After": "1" },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    const result = await apiClient.get<{ data: { ok: boolean } }>("/x");
    expect(result).toEqual({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("t7: opts.idempotencyKey overrides auto-uuid", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    await apiClient.post("/x", { a: 1 }, { idempotencyKey: "custom-key-123" });
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("custom-key-123");
  });

  it("t8: as novas tentativas de UM pedido levam a mesma Idempotency-Key; outro pedido leva chave nova", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    await apiClient.post("/x", { a: 1 });
    await apiClient.post("/x", { a: 1 });
    const chaves = fetchMock.mock.calls.map((c) => (c[1].headers as Record<string, string>)["Idempotency-Key"]);
    expect(chaves[0]).toBe(chaves[1]);
    expect(chaves[2]).not.toBe(chaves[0]);
  });

  it("t9: retryOnNetworkError=false não repete em erro de rede nem em tempo esgotado", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(apiClient.post("/x", { a: 1 }, { retryOnNetworkError: false })).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("t10: retryOnNetworkError=false mantém a nova tentativa em 503 (a chave protege o servidor)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: "service_unavailable", message: "x" } }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    await apiClient.post("/x", { a: 1 }, { retryOnNetworkError: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
