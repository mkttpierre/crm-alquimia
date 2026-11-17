import { describe, expect, it } from "vitest";

import { repositorioItensSupabase } from "./repositorio-itens";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "33333333-3333-4333-8333-333333333333";

/** PostgREST de mentira: devolve no máximo `TETO` linhas por consulta (como `max_rows` do Supabase), respeitando `range`. */
const TETO = 1000;

function dbComItens(total: number) {
  const todas = Array.from({ length: total }, (_, i) => ({
    id: `item-${String(i).padStart(5, "0")}`,
    lead_id: LEAD,
    nome: `Linha ${i}`,
    // vários itens no MESMO instante: só `id` desempata
    created_at: `2026-11-01T00:00:${String(Math.floor(i / 50)).padStart(2, "0")}Z`,
    total_cents: 100,
  }));
  const consultas: Array<{ ordem: string[]; faixa: [number, number] | null }> = [];
  const db = {
    from: () => {
      const estado = { ordem: [] as string[], faixa: null as [number, number] | null };
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.eq = () => cadeia;
      cadeia.order = (coluna: string) => {
        estado.ordem.push(coluna);
        return cadeia;
      };
      cadeia.range = (de: number, ate: number) => {
        estado.faixa = [de, ate];
        return cadeia;
      };
      cadeia.then = (res: (v: unknown) => unknown) => {
        consultas.push({ ...estado });
        const [de, ate] = estado.faixa ?? [0, TETO - 1];
        const fim = Math.min(ate, de + TETO - 1);
        return res({ data: todas.slice(de, fim + 1), error: null });
      };
      return cadeia;
    },
  };
  return { db: db as never, consultas, todas };
}

describe("repositorioItensSupabase.listar — todas as linhas, não só a primeira página", () => {
  it("com mais linhas que o teto de uma consulta, devolve TODAS, sem repetir nem pular", async () => {
    const { db, todas } = dbComItens(2500);
    const itens = await repositorioItensSupabase(db).listar(ORG, LEAD);
    expect(itens).toHaveLength(2500);
    expect(itens.map((i) => i.id)).toEqual(todas.map((i) => i.id));
    expect(new Set(itens.map((i) => i.id)).size).toBe(2500);
  });

  it("a ordem é ESTÁVEL entre páginas: created_at e, para desempatar, id", async () => {
    const { db, consultas } = dbComItens(1500);
    await repositorioItensSupabase(db).listar(ORG, LEAD);
    expect(consultas.length).toBeGreaterThanOrEqual(2);
    for (const c of consultas) expect(c.ordem).toEqual(["created_at", "id"]);
  });

  it("negócio pequeno: uma consulta só (sem custo extra)", async () => {
    const { db, consultas } = dbComItens(3);
    expect(await repositorioItensSupabase(db).listar(ORG, LEAD)).toHaveLength(3);
    expect(consultas).toHaveLength(1);
  });

  it("múltiplo exato do tamanho da página: a consulta de conferência volta vazia e para", async () => {
    const { db } = dbComItens(1000);
    expect(await repositorioItensSupabase(db).listar(ORG, LEAD)).toHaveLength(1000);
  });
});
