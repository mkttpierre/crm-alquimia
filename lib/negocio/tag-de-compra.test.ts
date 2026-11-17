// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/leads/regras-de-origem", () => ({ carregarRegrasDeOrigem: vi.fn() }));

import { carregarRegrasDeOrigem } from "@/lib/leads/regras-de-origem";
import { logger } from "@/lib/logger";
import { acrescentarTagsDeCompra } from "./tag-de-compra";

const ORG = "org-1";
const LEAD = "lead-1";
const PROD = "55555555-5555-4555-8555-555555555555";
const ctx = { organization_id: ORG };

interface Opcoes {
  tags?: string[] | null;
  nomesDoCatalogo?: string[];
  erroUpdate?: string;
}

/** Supabase de mentira: registra cada update e cada filtro `eq`, e nunca devolve preço. */
function supabaseFalso(opts: Opcoes = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const filtros: Array<[string, unknown]> = [];
  const tabelas: string[] = [];
  const selecionadas: string[] = [];
  const from = (tabela: string) => {
    tabelas.push(tabela);
    const elo: Record<string, unknown> = {};
    elo.select = (cols: string) => {
      selecionadas.push(`${tabela}:${cols}`);
      return elo;
    };
    elo.eq = (col: string, val: unknown) => {
      filtros.push([col, val]);
      return elo;
    };
    elo.in = () => Promise.resolve({ data: (opts.nomesDoCatalogo ?? []).map((nome) => ({ nome })), error: null });
    elo.maybeSingle = () => Promise.resolve({ data: { tags: opts.tags === undefined ? [] : opts.tags }, error: null });
    elo.update = (v: Record<string, unknown>) => {
      updates.push(v);
      const cad: Record<string, unknown> = {};
      cad.eq = (col: string, val: unknown) => {
        filtros.push([col, val]);
        return cad;
      };
      cad.then = (res: (x: unknown) => void) => res({ error: opts.erroUpdate ? { message: opts.erroUpdate } : null });
      return cad;
    };
    return elo;
  };
  return { db: { from } as never, updates, filtros, tabelas, selecionadas };
}

const regras = (produtos: string[]) => ({ produtos, por_fonte: {} });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(carregarRegrasDeOrigem).mockResolvedValue(regras(["ouro"]));
});

describe("acrescentarTagsDeCompra", () => {
  it('nome "5 MESES (OURO)" com regras.produtos ["ouro"] grava COMPROU OURO e mantém as tags existentes', async () => {
    const x = supabaseFalso({ tags: ["quente", "vip"] });
    await acrescentarTagsDeCompra(x.db, ctx, LEAD, [{ product_id: null, nome: "5 MESES (OURO)" }]);
    expect(x.updates).toEqual([{ tags: ["quente", "vip", "COMPROU OURO"] }]);
    expect(carregarRegrasDeOrigem).toHaveBeenCalledWith(x.db, ORG);
  });

  it("usa só organization_id do ctx: todo filtro de leitura e escrita carrega a org", async () => {
    const x = supabaseFalso({ tags: [] });
    await acrescentarTagsDeCompra(x.db, ctx, LEAD, [{ nome: "Kit Ouro" }]);
    expect(x.updates).toHaveLength(1);
    expect(x.filtros).toContainEqual(["organization_id", ORG]);
    expect(x.filtros).toContainEqual(["id", LEAD]);
  });

  it("item do catálogo: lê o nome do produto (nunca o preço) e grava a tag", async () => {
    const x = supabaseFalso({ tags: [], nomesDoCatalogo: ["12 MESES (OURO)"] });
    await acrescentarTagsDeCompra(x.db, ctx, LEAD, [{ product_id: PROD, nome: null }]);
    expect(x.updates).toEqual([{ tags: ["COMPROU OURO"] }]);
    expect(x.tabelas).toContain("catalog_products");
    expect(x.selecionadas.join("|")).not.toMatch(/preco|price/);
  });

  it("sem regras.produtos não grava nada nem consulta o banco", async () => {
    vi.mocked(carregarRegrasDeOrigem).mockResolvedValue(regras([]));
    const x = supabaseFalso({ tags: ["quente"] });
    await acrescentarTagsDeCompra(x.db, ctx, LEAD, [{ nome: "5 MESES (OURO)" }]);
    expect(x.updates).toEqual([]);
    expect(x.tabelas).toEqual([]);
  });

  it("tag já existente não duplica (compara sem caixa) e não faz update", async () => {
    const x = supabaseFalso({ tags: ["comprou ouro", "quente"] });
    await acrescentarTagsDeCompra(x.db, ctx, LEAD, [{ nome: "5 MESES (OURO)" }]);
    expect(x.updates).toEqual([]);
  });

  it("duas vendas do mesmo produto na mesma chamada geram uma tag só", async () => {
    const x = supabaseFalso({ tags: [] });
    await acrescentarTagsDeCompra(x.db, ctx, LEAD, [{ nome: "3 MESES (OURO)" }, { nome: "5 MESES (OURO)" }]);
    expect(x.updates).toEqual([{ tags: ["COMPROU OURO"] }]);
  });

  it("lead sem tags (null) parte de lista vazia", async () => {
    const x = supabaseFalso({ tags: null });
    await acrescentarTagsDeCompra(x.db, ctx, LEAD, [{ nome: "5 MESES (OURO)" }]);
    expect(x.updates).toEqual([{ tags: ["COMPROU OURO"] }]);
  });

  it("falha do update é registrada e não lança", async () => {
    const x = supabaseFalso({ tags: [], erroUpdate: "rls" });
    await expect(acrescentarTagsDeCompra(x.db, ctx, LEAD, [{ nome: "5 MESES (OURO)" }])).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("update falhou"), expect.objectContaining({ lead_id: LEAD, error: "rls" }));
  });

  it("exceção em qualquer ponto (supabase ou regras) não lança", async () => {
    const quebrado = { from: () => { throw new Error("boom"); } } as never;
    await expect(acrescentarTagsDeCompra(quebrado, ctx, LEAD, [{ nome: "5 MESES (OURO)" }])).resolves.toBeUndefined();
    vi.mocked(carregarRegrasDeOrigem).mockRejectedValue(new Error("regras"));
    await expect(acrescentarTagsDeCompra(supabaseFalso().db, ctx, LEAD, [{ nome: "x" }])).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
