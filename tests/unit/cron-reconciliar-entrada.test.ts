/**
 * Rota `/api/v1/cron/reconciliar-entrada`: borda fina da reconciliação de entrada.
 * Auth igual aos outros crons (Bearer do segredo interno, falha fechada); `dry_run=1` e
 * `horas=<n>` vêm da query (nada de organização no corpo); auditoria só quando houve efeito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "segredo-do-teste";
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-do-teste", INTERNAL_SECRET: "" } }));
const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditou(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const reconciliar = vi.fn();
vi.mock("@/lib/channels/evolution/reconciliacao", () => ({
  HORAS_MAXIMO: 168,
  reconciliarEntrada: (...a: unknown[]) => reconciliar(...a),
}));

import { GET, POST } from "@/app/api/v1/cron/reconciliar-entrada/route";

function req(query = "", autorizado = true) {
  return {
    headers: new Headers(autorizado ? { authorization: `Bearer ${SEGREDO}` } : {}),
    nextUrl: new URL(`http://app/api/v1/cron/reconciliar-entrada${query}`),
  } as never;
}

const resultado = (recuperadas: number) => ({
  dry_run: false,
  horas: 24,
  sessoes: [],
  total_lidas: 3,
  total_ausentes: recuperadas,
  total_recuperadas: recuperadas,
});

beforeEach(() => {
  auditou.mockReset();
  reconciliar.mockReset();
  reconciliar.mockResolvedValue(resultado(0));
});

describe("rota de reconciliação de entrada", () => {
  it("sem segredo: 403 e nada roda", async () => {
    const r = await GET(req("", false));
    expect(r.status).toBe(403);
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it("padrão: janela padrão, gravando", async () => {
    const r = await POST(req());
    expect(r.status).toBe(200);
    expect(reconciliar.mock.calls[0]![1]).toMatchObject({ dryRun: false, horas: undefined });
  });

  it("dry_run=1&horas=168 chegam à reconciliação", async () => {
    await GET(req("?dry_run=1&horas=168"));
    expect(reconciliar.mock.calls[0]![1]).toMatchObject({ dryRun: true, horas: 168 });
  });

  it("horas inválida: 400, nada roda", async () => {
    for (const q of ["?horas=0", "?horas=abc", "?horas=169", "?horas=2.5"]) {
      const r = await GET(req(q));
      expect(r.status, q).toBe(400);
    }
    expect(reconciliar).not.toHaveBeenCalled();
  });

  it("audita só quando recuperou (rodada vazia e dry_run não auditam)", async () => {
    await GET(req());
    expect(auditou).not.toHaveBeenCalled();
    reconciliar.mockResolvedValue({ ...resultado(2), dry_run: true, total_recuperadas: 0 });
    await GET(req("?dry_run=1"));
    expect(auditou).not.toHaveBeenCalled();
    reconciliar.mockResolvedValue(resultado(2));
    await GET(req());
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]![0]).toMatchObject({ action: "message.reconcile_run" });
  });

  it("falha da reconciliação inteira: 500 sem vazar detalhe", async () => {
    reconciliar.mockRejectedValue(new Error("sessoes_ilegiveis: x"));
    const r = await GET(req());
    expect(r.status).toBe(500);
  });
});
