// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { logger } from "@/lib/logger";

import { tagsDeCompra } from "@/lib/leads/tag-de-origem";
import { acrescentarTagsDeCompra } from "@/lib/negocio/tag-de-compra";

const regras = { produtos: ["alfa", "beta", "gama", "delta"], por_fonte: {} };

describe("tagsDeCompra (função pura)", () => {
  it("usa a chave de produtos contida no nome", () => {
    expect(tagsDeCompra(["Plano 60 dias ALFA"], regras, [])).toEqual(["COMPROU ALFA"]);
  });
  it("sem chave conhecida, só COMPROU (nunca o nome do produto)", () => {
    expect(tagsDeCompra(["Kit Verão"], regras, [])).toEqual(["COMPROU"]);
    expect(tagsDeCompra(["Venda online"], regras, [])).toEqual(["COMPROU"]);
    expect(tagsDeCompra(["12 MESES (SONO)🌙"], regras, [])).toEqual(["COMPROU"]);
  });
  it("COMPROU solto não sai se já há COMPROU <P>, no lead ou na mesma venda", () => {
    expect(tagsDeCompra(["Venda online"], regras, ["COMPROU BETA"])).toEqual([]);
    expect(tagsDeCompra(["Alfa", "Venda online"], regras, [])).toEqual(["COMPROU ALFA"]);
  });
  it("kit com duas chaves gera as duas tags", () => {
    expect(tagsDeCompra(["Delta + Gama"], regras, [])).toEqual(["COMPROU GAMA", "COMPROU DELTA"]);
  });
  it("não repete, nem as que o lead já tem", () => {
    expect(tagsDeCompra(["Alfa 30", "alfa 60", "Beta"], regras, ["comprou beta"])).toEqual(["COMPROU ALFA"]);
  });
  it("organização sem regra de produtos: nada", () => {
    expect(tagsDeCompra(["Alfa"], { produtos: [], por_fonte: {} }, [])).toEqual([]);
  });
});

function db(opts: { settings: unknown; tags: string[]; nomes: string[]; erroUpdate?: string }) {
  const updates: Array<Record<string, unknown>> = [];
  const selecionadas: string[] = [];
  const from = (tabela: string) => {
    const elo: Record<string, unknown> = {};
    elo.select = (cols: string) => {
      selecionadas.push(`${tabela}:${cols}`);
      return elo;
    };
    elo.eq = () => elo;
    elo.in = () => Promise.resolve({ data: opts.nomes.map((nome) => ({ nome })), error: null });
    elo.update = (v: Record<string, unknown>) => {
      updates.push(v);
      const cad: Record<string, unknown> = {};
      cad.eq = () => cad;
      cad.then = (res: (x: unknown) => void) => res({ error: opts.erroUpdate ? { message: opts.erroUpdate } : null });
      return cad;
    };
    elo.maybeSingle = () =>
      Promise.resolve({
        data: tabela === "organizations" ? { settings: opts.settings } : { tags: opts.tags },
        error: null,
      });
    return elo;
  };
  return { db: { from } as never, updates, selecionadas };
}

const ctx = { organization_id: "org", actor: { type: "user", id: "u" }, requestId: "r" } as never;
const P = "55555555-5555-4555-8555-555555555555";

describe("acrescentarTagsDeCompra", () => {
  it("grava as tags preservando as existentes, sem ler preço", async () => {
    const x = db({ settings: { origem: { produtos: ["alfa"], por_fonte: {} } }, tags: ["quente"], nomes: ["Plano Alfa"] });
    await acrescentarTagsDeCompra(x.db, ctx, "lead", [{ product_id: P, nome: null } as never]);
    expect(x.updates).toEqual([{ tags: ["quente", "COMPROU ALFA"] }]);
    expect(x.selecionadas.join("|")).not.toMatch(/preco/);
  });
  it("erro no update é registrado, sem lançar", async () => {
    const x = db({ settings: { origem: { produtos: ["alfa"], por_fonte: {} } }, tags: [], nomes: ["Alfa"], erroUpdate: "rls" });
    await expect(acrescentarTagsDeCompra(x.db, ctx, "lead", [{ product_id: P, nome: null } as never])).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
  it("falha não lança", async () => {
    const quebrado = { from: () => { throw new Error("x"); } } as never;
    await expect(acrescentarTagsDeCompra(quebrado, ctx, "lead", [])).resolves.toBeUndefined();
  });
});
