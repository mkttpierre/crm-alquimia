/**
 * O carregamento do painel "Vendas e faturamento": o que se lê, com qual organização, e que NADA sigiloso é lido.
 *
 * O banco é um dublê que grava cada consulta (tabela, colunas, filtros) e responde por tabela. Prova-se a orquestração e o
 * contrato de leitura; o Postgres de verdade não entra (RLS e SQL são do `test:db`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { carregarPainelDeVendas, type DependenciasDoPainel } from "./carregar-painel-vendas";
import { repositorioFaturamentoSupabase } from "./repositorio-faturamento";
import { repositorioPainelDeVendasSupabase } from "./repositorio-painel-vendas";

const ORG = "11111111-aaaa-4aaa-8aaa-111111111111";

interface Registro {
  tabela: string;
  select: unknown[] | undefined;
  ops: unknown[][];
}

type Resposta = { data?: unknown; count?: number | null; error?: { message: string } | null };

function bancoFalso(responder: (r: Registro) => Resposta) {
  const registros: Registro[] = [];
  const db = {
    from(tabela: string) {
      const reg: Registro = { tabela, select: undefined, ops: [] };
      registros.push(reg);
      const proxy: unknown = new Proxy(
        {},
        {
          get(_alvo, prop: string) {
            if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve({ error: null, ...responder(reg) });
            return (...args: unknown[]) => {
              if (prop === "select") reg.select = args;
              else reg.ops.push([prop, ...args]);
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { db: db as unknown as SupabaseClient, registros };
}

const filtro = (r: Registro, nome: string, coluna: string) => r.ops.find((o) => o[0] === nome && o[1] === coluna);

const GANHOS = [
  { id: "l1", pipeline_id: "pipe-1", closed_at: "2026-11-05T15:00:00.000Z", value_cents: 10_000, currency: "BRL", title: "A", owner_user_id: null, owner_kind: null, created_at: "2026-11-04T15:00:00.000Z", contact_id: "c1", tags: ["META ADS"] },
  { id: "l2", pipeline_id: "pipe-1", closed_at: "2026-10-10T15:00:00.000Z", value_cents: 5_000, currency: "BRL", title: "B", owner_user_id: null, owner_kind: null, created_at: "2026-10-09T15:00:00.000Z", contact_id: "c2", tags: [] },
  { id: "l3", pipeline_id: "pipe-1", closed_at: "2026-11-06T15:00:00.000Z", value_cents: 2_000, currency: "BRL", title: "C", owner_user_id: null, owner_kind: null, created_at: "2026-11-01T15:00:00.000Z", contact_id: null, tags: [] },
];

function montar(opts: { internos?: boolean; pedidos?: unknown[] } = {}) {
  const { db, registros } = bancoFalso((r) => {
    const colunas = String(r.select?.[0] ?? "");
    switch (r.tabela) {
      case "organizations":
        if (colunas.includes("timezone")) return { data: { timezone: "America/Sao_Paulo" } };
        if (colunas.includes("meta_mensal_cents")) return { data: { meta_mensal_cents: 1_000_000 } };
        if (colunas.includes("settings")) return { data: { settings: { origem: { produtos: [], por_fonte: { meta: "Meta Ads" } } } } };
        return { data: null };
      case "crm_leads":
        if ((r.select?.[1] as { head?: boolean } | undefined)?.head) return { count: filtro(r, "eq", "status") ? 4 : 40 };
        if (colunas.startsWith("id, pipeline_id")) return { data: GANHOS };
        if (colunas.startsWith("id, contact_id")) {
          return { data: [{ id: "l1", contact_id: "c1", closed_at: "2026-11-05T15:00:00.000Z" }, { id: "x0", contact_id: "c1", closed_at: "2026-08-01T15:00:00.000Z" }] };
        }
        return { data: [] };
      case "orders":
        return { data: opts.pedidos ?? [] };
      case "crm_pipelines":
        return { data: [{ id: "pipe-1", name: "Funil" }] };
      case "catalog_products":
        return { data: opts.internos ? [{ id: "p-interno" }] : [] };
      default:
        return { data: [] };
    }
  });
  const deps: DependenciasDoPainel = {
    faturamento: repositorioFaturamentoSupabase(db),
    painel: repositorioPainelDeVendasSupabase(db),
    regrasDeOrigem: async () => ({ produtos: [], por_fonte: { meta: "Meta Ads" } }),
    moeda: "BRL",
    agora: new Date("2026-11-16T15:00:00.000Z"),
  };
  return { deps, registros };
}

describe("carregarPainelDeVendas", () => {
  it("⭐ monta o painel do mês com a MESMA conta da tela Faturamento", async () => {
    const { deps } = montar();
    const r = await carregarPainelDeVendas(deps, ORG, "mes");
    expect(r.periodo).toEqual({ chave: "mes", desde: "2026-11-01", ate: "2026-11-16" });
    expect(r.hoje).toBe("2026-11-16");
    expect(r.painel.anterior).toEqual({ desde: "2026-10-01", ate: "2026-10-16" });
    expect(r.timezone).toBe("America/Sao_Paulo");
    expect(r.painel.faturamento).toEqual({ atual: 12_000, anterior: 5_000, variacao: 140 });
    expect(r.painel.vendas.atual).toBe(2);
    expect(r.painel.meta).toMatchObject({ meta_cents: 1_000_000, realizado_cents: 12_000 });
    expect(r.painel.origem.linhas).toEqual([{ tag: "META ADS", vendas: 1, total_cents: 10_000 }]);
    expect(r.painel.conversao.taxa.atual).toBeCloseTo(4 / 40);
    expect(r.truncado).toBe(false);
  });

  it("recompra: o universo é quem comprou nos dois períodos (contato do negócio, sem contato fica de fora)", async () => {
    const { deps, registros } = montar();
    const r = await carregarPainelDeVendas(deps, ORG, "mes");
    const consulta = registros.find((x) => x.tabela === "crm_leads" && String(x.select?.[0]).startsWith("id, contact_id"));
    expect(consulta?.ops.find((o) => o[0] === "in")?.[2]).toEqual(["c1", "c2"]);
    expect(r.painel.recompra.clientes).toBe(1);
    expect(r.painel.recompra.recompradores).toBe(1);
  });

  it("⭐ toda consulta leva a organização da SESSÃO", async () => {
    const { deps, registros } = montar();
    await carregarPainelDeVendas(deps, ORG, "7d");
    const semOrg = registros.filter((r) => {
      if (r.tabela === "organizations") return !filtro(r, "eq", "id") || filtro(r, "eq", "id")?.[2] !== ORG;
      return filtro(r, "eq", "organization_id")?.[2] !== ORG;
    });
    expect(semOrg.map((r) => r.tabela)).toEqual([]);
  });

  it("os leads são contados com os limites do dia civil no fuso (fim exclusivo), no período e no anterior", async () => {
    const { deps, registros } = montar();
    await carregarPainelDeVendas(deps, ORG, "mes");
    const contagens = registros.filter((r) => r.tabela === "crm_leads" && (r.select?.[1] as { head?: boolean } | undefined)?.head && !filtro(r, "eq", "status"));
    const faixas = contagens.map((r) => [filtro(r, "gte", "created_at")?.[2], filtro(r, "lt", "created_at")?.[2]]);
    expect(faixas).toContainEqual(["2026-11-01T03:00:00.000Z", "2026-11-17T03:00:00.000Z"]);
    // O anterior de "Este mês" são os MESMOS dias do mês anterior: 01–16/10.
    expect(faixas).toContainEqual(["2026-10-01T03:00:00.000Z", "2026-10-17T03:00:00.000Z"]);
  });

  it("⭐ SIGILO: nenhuma consulta do painel lê preço de catálogo, comissão ou valor_sigiloso", async () => {
    const { deps, registros } = montar({ internos: true });
    await carregarPainelDeVendas(deps, ORG, "90d");
    const lidas = registros.flatMap((r) => (typeof r.select?.[0] === "string" ? [`${r.tabela}: ${r.select[0]}`] : []));
    expect(lidas.length).toBeGreaterThan(3);
    for (const linha of lidas) expect(linha).not.toMatch(/preco|price|valor_sigiloso|so_interno|comiss/i);
    // O catálogo só é perguntado "existe produto interno?": a coluna lida é o id.
    expect(registros.filter((r) => r.tabela === "catalog_products").map((r) => r.select?.[0])).toEqual(["id"]);
  });

  it("⭐ SIGILO: com produto interno, o pedido da loja (preço cheio) não entra no total nem aparece no resultado", async () => {
    const pedidos = [{ id: "o1", ordered_at: "2026-11-07T15:00:00.000Z", total_cents: 987_654_321, currency: "BRL", status: "paid" }];
    const { deps } = montar({ internos: true, pedidos });
    const r = await carregarPainelDeVendas(deps, ORG, "mes");
    expect(r.painel.somente_negocios).toBe(true);
    expect(r.painel.faturamento.atual).toBe(12_000);
    expect(JSON.stringify(r)).not.toContain("987654321");
  });

  it("sem produto interno o pedido pago entra no total (a mesma regra do Faturamento)", async () => {
    const pedidos = [{ id: "o1", ordered_at: "2026-11-07T15:00:00.000Z", total_cents: 7_000, currency: "BRL", status: "paid" }];
    const { deps } = montar({ pedidos });
    expect((await carregarPainelDeVendas(deps, ORG, "mes")).painel.faturamento.atual).toBe(19_000);
  });

  it("a janela de leitura cobre o mês corrente mesmo quando o período é 'mês passado' (a meta é do mês de hoje)", async () => {
    const { deps, registros } = montar();
    const r = await carregarPainelDeVendas(deps, ORG, "mes-passado");
    expect(r.periodo).toMatchObject({ desde: "2026-10-01", ate: "2026-10-31" });
    expect(r.painel.anterior).toEqual({ desde: "2026-09-01", ate: "2026-09-30" });
    const ganhos = registros.find((x) => x.tabela === "crm_leads" && String(x.select?.[0]).startsWith("id, pipeline_id"));
    // Início da janela: o mês retrasado inteiro (1º de setembro, menos a folga de fuso); fim: hoje (novembro) + folga de fuso.
    expect(String(ganhos?.ops.find((o) => o[0] === "gte")?.[2])).toMatch(/^2026-08-31/);
    expect(String(ganhos?.ops.find((o) => o[0] === "lt")?.[2])).toMatch(/^2026-11-19/);
    expect(r.painel.meta?.realizado_cents).toBe(12_000);
  });
});

describe("repositorioPainelDeVendasSupabase", () => {
  it("meta: aceita número e texto (bigint do PostgREST), recusa zero e erro", async () => {
    const meta = async (resposta: Resposta) => repositorioPainelDeVendasSupabase(bancoFalso(() => resposta).db).metaMensal(ORG);
    expect(await meta({ data: { meta_mensal_cents: 5_000_000 } })).toBe(5_000_000);
    expect(await meta({ data: { meta_mensal_cents: "5000000" } })).toBe(5_000_000);
    expect(await meta({ data: { meta_mensal_cents: null } })).toBeNull();
    expect(await meta({ data: { meta_mensal_cents: 0 } })).toBeNull();
    expect(await meta({ data: null })).toBeNull();
    // Banco que ainda não recebeu a 0262: o painel segue sem meta.
    expect(await meta({ data: null, error: { message: 'column "meta_mensal_cents" does not exist' } })).toBeNull();
  });

  it("compras dos contatos: lê em lotes de 100 contatos e pagina", async () => {
    const contatos = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const { db, registros } = bancoFalso(() => ({ data: [] }));
    const r = await repositorioPainelDeVendasSupabase(db).comprasDosContatos(ORG, contatos, "2026-11-19T00:00:00.000Z");
    expect(r).toEqual({ compras: [], truncado: false });
    expect(registros).toHaveLength(3);
    expect(registros.map((x) => (x.ops.find((o) => o[0] === "in")?.[2] as string[]).length)).toEqual([100, 100, 50]);
  });

  it("compras dos contatos: sem contato nenhum não consulta", async () => {
    const { db, registros } = bancoFalso(() => ({ data: [] }));
    await repositorioPainelDeVendasSupabase(db).comprasDosContatos(ORG, [], "2026-11-19T00:00:00.000Z");
    expect(registros).toHaveLength(0);
  });

  it("erro de leitura propaga (o painel mostra 'não consegui carregar', não um número parcial)", async () => {
    const { db } = bancoFalso(() => ({ data: null, error: { message: "boom" } }));
    await expect(repositorioPainelDeVendasSupabase(db).comprasDosContatos(ORG, ["c1"], "2026-11-19T00:00:00.000Z")).rejects.toMatchObject({ message: "boom" });
    await expect(repositorioPainelDeVendasSupabase(db).contarLeads(ORG, { de: "a", ate: "b" })).rejects.toMatchObject({ message: "boom" });
  });
});
