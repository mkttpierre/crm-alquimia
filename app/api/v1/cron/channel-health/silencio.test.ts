import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * O cron `channel-health` chama o alarme de silêncio de entrada — só para conexão
 * que o transporte confirma `WORKING`, passando as OUTRAS conexões da mesma
 * organização (critério do chip irmão), e uma falha nele não derruba o lote.
 */

const silencio = vi.hoisted(() => vi.fn());
const saude = vi.hoisted(() => vi.fn());
const sessoes = vi.hoisted(() => ({ lista: [] as Array<Record<string, unknown>> }));
const adapterFake = vi.hoisted(() => ({
  checkHealth: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/health", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/health")>()),
  sincronizarSaudeDaConexao: saude,
}));
vi.mock("@/lib/channels/silencio-de-entrada", () => ({ sincronizarSilencioDeEntrada: silencio }));
vi.mock("@/lib/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels")>()),
  getAdapter: () => adapterFake,
  resolveSessionRef: () => "instancia-x",
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: sessoes.lista, error: null });
          return () => proxy;
        },
      },
    );
    return { from: () => proxy };
  },
}));

import { POST } from "@/app/api/v1/cron/channel-health/route";

const chamar = async () => {
  const res = await POST(
    new NextRequest("https://crm.exemplo.test/api/v1/cron/channel-health", {
      method: "POST",
      headers: { authorization: "Bearer segredo" },
    }),
  );
  return res.json();
};

const sessao = (id: string, org: string, status = "WORKING") => ({
  id,
  organization_id: org,
  status,
  display_name: id,
  phone_number: null,
  archived_at: null,
  last_status_change_at: "2026-11-05T10:00:00.000Z",
});

beforeEach(() => {
  silencio.mockReset().mockResolvedValue("sem_mudanca");
  saude.mockReset().mockResolvedValue("sem_mudanca");
  adapterFake.checkHealth.mockReset().mockResolvedValue({ reachable: true, status: "WORKING", detail: null });
  sessoes.lista = [sessao("s1", "org-a"), sessao("s2", "org-a"), sessao("s3", "org-b")];
});

describe("channel-health → alarme de silêncio de entrada", () => {
  it("avalia cada conexão WORKING, passando só as OUTRAS da mesma organização", async () => {
    await chamar();
    expect(silencio).toHaveBeenCalledTimes(3);
    const porSessao = Object.fromEntries(silencio.mock.calls.map(([, s, o]) => [s.id, o.outrasSessoesIds]));
    expect(porSessao).toEqual({ s1: ["s2"], s2: ["s1"], s3: [] });
  });

  it("passa a hora da última mudança de status (reconexão zera a contagem)", async () => {
    await chamar();
    expect(silencio.mock.calls[0]![1].desdeEm).toEqual(new Date("2026-11-05T10:00:00.000Z"));
  });

  it("conexão que o transporte NÃO confirma WORKING não passa pelo alarme", async () => {
    adapterFake.checkHealth.mockResolvedValue({ reachable: true, status: "SCAN_QR_CODE", detail: null });
    await chamar();
    expect(silencio).not.toHaveBeenCalled();
  });

  it("transporte inalcançável: não avalia silêncio (não sabemos nem se está de pé)", async () => {
    adapterFake.checkHealth.mockResolvedValue({ reachable: false, status: null, detail: "timeout" });
    await chamar();
    expect(silencio).not.toHaveBeenCalled();
  });

  it("falha no alarme de uma conexão não derruba as outras nem a resposta", async () => {
    silencio.mockRejectedValueOnce(new Error("aviso_nao_gravado: x"));
    const corpo = await chamar();
    expect(silencio).toHaveBeenCalledTimes(3);
    expect(corpo.data.verificadas).toBe(3);
  });

  it("conta os desfechos que mudam algo na resposta do cron", async () => {
    silencio.mockResolvedValueOnce("avisado").mockResolvedValueOnce("resolvido");
    const corpo = await chamar();
    expect(corpo.data).toMatchObject({ silencio_avisado: 1, silencio_resolvido: 1 });
  });
});
