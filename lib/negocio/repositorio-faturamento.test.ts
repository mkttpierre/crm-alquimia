import { describe, expect, it } from "vitest";

import { repositorioFaturamentoSupabase } from "./repositorio-faturamento";

const ORG = "11111111-1111-4111-8111-111111111111";
const JANELA = { de: "2026-10-31T00:00:00.000Z", ate: "2026-12-01T00:00:00.000Z" };
/** O `max_rows` do PostgREST deste projeto (supabase/config.toml): a resposta é cortada aqui, em silêncio. */
const MAX_ROWS = 1000;

type Linha = Record<string, unknown>;

/**
 * Banco de mentira que se comporta como o PostgREST: aplica `eq`/`in`/`gte`/`lt`, ordena, respeita `range(de, ate)` E CORTA
 * a resposta em `max_rows` — o defeito que este arquivo prova é exatamente o de ler sem `range` e achar que veio tudo.
 */
function bancoCom(tabelas: Record<string, Linha[]>) {
  const pedidos: Array<{ tabela: string; range: [number, number] | null }> = [];
  const db = {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      const ordem: string[] = [];
      let faixa: [number, number] | null = null;
      let limite: number | null = null;
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.eq = (c: string, v: unknown) => (filtros.push((l) => l[c] === v), cadeia);
      cadeia.in = (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), cadeia);
      cadeia.gte = (c: string, v: string) => (filtros.push((l) => String(l[c]) >= v), cadeia);
      cadeia.lt = (c: string, v: string) => (filtros.push((l) => String(l[c]) < v), cadeia);
      cadeia.gt = cadeia.neq = cadeia.is = () => cadeia;
      cadeia.order = (c: string) => (ordem.push(c), cadeia);
      cadeia.range = (de: number, ate: number) => ((faixa = [de, ate]), cadeia);
      cadeia.limit = (n: number) => ((limite = n), cadeia);
      const executar = () => {
        pedidos.push({ tabela, range: faixa });
        let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        for (const c of [...ordem].reverse()) linhas = [...linhas].sort((a, b) => String(a[c]).localeCompare(String(b[c])));
        if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
        if (limite !== null) linhas = linhas.slice(0, limite);
        return { data: linhas.slice(0, MAX_ROWS), error: null };
      };
      cadeia.maybeSingle = async () => ({ data: executar().data[0] ?? null, error: null });
      cadeia.then = (res: (v: unknown) => unknown) => res(executar());
      return cadeia;
    },
  };
  return { db: db as never, pedidos };
}

const ganho = (id: string) => ({ id, pipeline_id: "p1", closed_at: "2026-11-05T15:00:00Z", value_cents: 1000, currency: "BRL", title: id, owner_user_id: null, owner_kind: null, status: "won", organization_id: ORG });
const item = (lead: string, n: number) => ({ id: `item-${String(n).padStart(6, "0")}`, lead_id: lead, product_id: null, nome: `Item ${n}`, quantidade: 1, total_cents: 100, currency: "BRL", organization_id: ORG, created_at: "2026-11-05T15:00:00Z" });

describe("repositório de faturamento — itens dos negócios ganhos", () => {
  it("NÃO perde item pelo max_rows de 1000: lê a lista inteira, em páginas, com ordem estável", async () => {
    const itens = Array.from({ length: 2500 }, (_, i) => item(i % 2 === 0 ? "l1" : "l2", i));
    const { db, pedidos } = bancoCom({ crm_leads: [ganho("l1"), ganho("l2")], crm_lead_items: itens });
    const r = await repositorioFaturamentoSupabase(db).carregar(ORG, JANELA);
    const total = r.negocios.reduce((s, n) => s + n.itens.length, 0);
    expect(total).toBe(2500);
    expect(r.truncado).toBe(false);
    // páginas de verdade: mais de uma leitura da tabela de itens, cada uma com faixa
    const leituras = pedidos.filter((p) => p.tabela === "crm_lead_items");
    expect(leituras.length).toBeGreaterThan(1);
    expect(leituras.every((p) => p.range !== null)).toBe(true);
  });

  it("um negócio com 1500 itens (mais que o max_rows sozinho) volta com os 1500", async () => {
    const itens = Array.from({ length: 1500 }, (_, i) => item("l1", i));
    const { db } = bancoCom({ crm_leads: [ganho("l1")], crm_lead_items: itens });
    const r = await repositorioFaturamentoSupabase(db).carregar(ORG, JANELA);
    expect(r.negocios[0]!.itens).toHaveLength(1500);
  });

  it("se mesmo assim passar do teto de leitura, AVISA (truncado) em vez de entregar número incompleto como inteiro", async () => {
    const itens = Array.from({ length: 20_100 }, (_, i) => item("l1", i));
    const { db } = bancoCom({ crm_leads: [ganho("l1")], crm_lead_items: itens });
    const r = await repositorioFaturamentoSupabase(db).carregar(ORG, JANELA);
    expect(r.truncado).toBe(true);
  });
});

describe("repositório de faturamento — a organização tem produto interno?", () => {
  it("sim quando existe produto so_interno na organização", async () => {
    const { db } = bancoCom({ crm_leads: [], catalog_products: [{ id: "p", organization_id: ORG, so_interno: true }] });
    expect((await repositorioFaturamentoSupabase(db).carregar(ORG, JANELA)).temProdutoInterno).toBe(true);
  });

  it("não quando só há produtos da loja, ou o produto interno é de outra organização", async () => {
    const outra = "99999999-9999-4999-8999-999999999999";
    const { db } = bancoCom({ crm_leads: [], catalog_products: [{ id: "p", organization_id: ORG, so_interno: false }, { id: "q", organization_id: outra, so_interno: true }] });
    expect((await repositorioFaturamentoSupabase(db).carregar(ORG, JANELA)).temProdutoInterno).toBe(false);
  });
});
