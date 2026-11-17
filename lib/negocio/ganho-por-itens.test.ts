import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { encerraDemanda } from "@/lib/leads/encerramento";

import { marcarGanhoPorProduto, reabrirSeSemItens } from "./ganho-por-itens";

vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ctx = { organization_id: "org-1", actor: { type: "user", id: "u1" }, requestId: "r1", idioma: "pt-BR" } as never;

/** Cliente falso: cada tabela devolve o que o teste combinar e registra os updates. */
function banco(opts: { itens: number; status: string; etapa: string | null; erroUpdate?: boolean }) {
  const updates: Array<Record<string, unknown>> = [];
  const cadeia = (resultado: unknown, final: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "eq"]) c[m] = () => c;
    c.maybeSingle = async () => ({ data: resultado, error: null });
    c.then = (ok: (v: unknown) => unknown) => ok(final);
    return c;
  };
  const db = {
    from(tabela: string) {
      if (tabela === "crm_lead_items") return cadeia(null, { count: opts.itens, error: null });
      if (tabela === "crm_stages") return cadeia(opts.etapa ? { id: opts.etapa } : null, { error: null });
      return {
        ...cadeia({ status: opts.status, pipeline_id: "p1" }, { error: null }),
        update: (v: Record<string, unknown>) => {
          updates.push(v);
          return cadeia(null, { error: opts.erroUpdate ? { message: "x" } : null });
        },
      };
    },
  };
  return { db: db as never, updates };
}

beforeEach(() => vi.clearAllMocks());

describe("marcarGanhoPorProduto", () => {
  it("marca como ganho pela regra do marcar como ganho", async () => {
    vi.mocked(encerraDemanda).mockResolvedValue({ lead: {}, jaEstava: false } as never);
    expect(await marcarGanhoPorProduto({} as never, ctx, "lead-1")).toEqual({ marcado: true });
    expect(encerraDemanda).toHaveBeenCalledWith(expect.anything(), ctx, { leadId: "lead-1", desfecho: "won" });
  });

  it("funil sem etapa de ganho: não lança e devolve o motivo", async () => {
    vi.mocked(encerraDemanda).mockRejectedValue(new ApiError(422, "pipeline_no_won_stage", undefined, "r1", "x"));
    expect(await marcarGanhoPorProduto({} as never, ctx, "lead-1")).toEqual({ marcado: false, motivo: "pipeline_no_won_stage" });
  });

  it("erro inesperado também não lança", async () => {
    vi.mocked(encerraDemanda).mockRejectedValue(new Error("boom"));
    expect(await marcarGanhoPorProduto({} as never, ctx, "lead-1")).toEqual({ marcado: false, motivo: "erro" });
  });
});

describe("reabrirSeSemItens", () => {
  it("sem nenhum produto e negócio ganho: move para a primeira etapa aberta", async () => {
    const { db, updates } = banco({ itens: 0, status: "won", etapa: "etapa-1" });
    expect(await reabrirSeSemItens(db, ctx, "lead-1")).toBe(true);
    expect(updates).toEqual([{ stage_id: "etapa-1" }]);
  });

  it("ainda há produto: não reabre", async () => {
    const { db, updates } = banco({ itens: 2, status: "won", etapa: "etapa-1" });
    expect(await reabrirSeSemItens(db, ctx, "lead-1")).toBe(false);
    expect(updates).toEqual([]);
  });

  it("negócio que não estava ganho: não mexe", async () => {
    const { db, updates } = banco({ itens: 0, status: "open", etapa: "etapa-1" });
    expect(await reabrirSeSemItens(db, ctx, "lead-1")).toBe(false);
    expect(updates).toEqual([]);
  });

  it("funil sem etapa aberta ou update com erro: não lança e devolve false", async () => {
    expect(await reabrirSeSemItens(banco({ itens: 0, status: "won", etapa: null }).db, ctx, "lead-1")).toBe(false);
    expect(await reabrirSeSemItens(banco({ itens: 0, status: "won", etapa: "e", erroUpdate: true }).db, ctx, "lead-1")).toBe(false);
  });
});
