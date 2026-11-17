import { describe, expect, it } from "vitest";

import {
  calcularFaturamento, calcularPainel, chaveDoPeriodo, consultaSchema, janelaDeBusca, periodoAnterior, variacaoPercentual,
  type NegocioGanhoParaFaturar, type PedidoParaFaturar,
} from "./faturamento";

const TZ = "America/Sao_Paulo";

const negocio = (
  id: string, closed_at: string, value_cents: number | null, extra: Partial<NegocioGanhoParaFaturar> = {},
): NegocioGanhoParaFaturar => ({
  lead_id: id, pipeline_id: "pipe-1", closed_at, value_cents, currency: "BRL", itens: [], ...extra,
});
const pedido = (id: string, ordered_at: string, total_cents: number, extra: Partial<PedidoParaFaturar> = {}): PedidoParaFaturar => ({
  id, ordered_at, total_cents, currency: "BRL", status: "paid", ...extra,
});
const base = { pipelines: new Map([["pipe-1", "Kit"], ["pipe-2", "Recompra"]]), moeda: "BRL", timezone: TZ };

describe("chaveDoPeriodo", () => {
  it("respeita o fuso da organização: 01:30 UTC ainda é o dia anterior em São Paulo", () => {
    expect(chaveDoPeriodo("2026-11-06T01:30:00Z", "dia", TZ)).toBe("2026-11-05");
    expect(chaveDoPeriodo("2026-11-06T12:00:00Z", "dia", TZ)).toBe("2026-11-06");
  });
  it("semana começa na segunda-feira", () => {
    // 06/11/2026 é sexta-feira → segunda 02/11
    expect(chaveDoPeriodo("2026-11-06T12:00:00Z", "semana", TZ)).toBe("2026-11-02");
    expect(chaveDoPeriodo("2026-11-08T15:00:00Z", "semana", TZ)).toBe("2026-11-02");
    expect(chaveDoPeriodo("2026-11-09T15:00:00Z", "semana", TZ)).toBe("2026-11-09");
  });
  it("mês", () => {
    expect(chaveDoPeriodo("2026-11-30T12:00:00Z", "mes", TZ)).toBe("2026-11");
  });
});

describe("calcularFaturamento", () => {
  it("soma negócios ganhos e pedidos pagos; ticket médio = total ÷ vendas", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-01", ate: "2026-11-07", granularidade: "dia",
      negocios: [negocio("a", "2026-11-02T15:00:00Z", 10000), negocio("b", "2026-11-03T15:00:00Z", 5000)],
      pedidos: [pedido("p1", "2026-11-03T18:00:00Z", 6000)],
    });
    expect(r.total_cents).toBe(21000);
    expect(r.receita_negocios_cents).toBe(15000);
    expect(r.receita_pedidos_cents).toBe(6000);
    expect(r.numero_de_vendas).toBe(3);
    expect(r.ticket_medio_cents).toBe(7000);
  });

  it("série por dia preenche os dias sem venda com zero, em ordem", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-01", ate: "2026-11-04", granularidade: "dia",
      negocios: [negocio("a", "2026-11-02T15:00:00Z", 10000)], pedidos: [],
    });
    expect(r.serie).toEqual([
      { chave: "2026-11-01", total_cents: 0, vendas: 0 },
      { chave: "2026-11-02", total_cents: 10000, vendas: 1 },
      { chave: "2026-11-03", total_cents: 0, vendas: 0 },
      { chave: "2026-11-04", total_cents: 0, vendas: 0 },
    ]);
  });

  it("série por semana e por mês agrupa", () => {
    const entrada = {
      ...base, desde: "2026-10-26", ate: "2026-11-15",
      negocios: [negocio("a", "2026-10-28T15:00:00Z", 100), negocio("b", "2026-11-03T15:00:00Z", 200), negocio("c", "2026-11-12T15:00:00Z", 400)],
      pedidos: [],
    };
    const semanas = calcularFaturamento({ ...entrada, granularidade: "semana" }).serie;
    expect(semanas.map((s) => [s.chave, s.total_cents])).toEqual([["2026-10-26", 100], ["2026-11-02", 200], ["2026-11-09", 400]]);
    const meses = calcularFaturamento({ ...entrada, granularidade: "mes" }).serie;
    expect(meses.map((s) => [s.chave, s.total_cents])).toEqual([["2026-10", 100], ["2026-11", 600]]);
  });

  it("deixa de fora o que cai fora do período no fuso da organização", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-02", ate: "2026-11-02", granularidade: "dia",
      // 03/11 01:00 UTC = 02/11 22:00 em São Paulo (dentro); 02/11 01:00 UTC = 01/11 22:00 (fora)
      negocios: [negocio("dentro", "2026-11-03T01:00:00Z", 100), negocio("fora", "2026-11-02T01:00:00Z", 900)],
      pedidos: [],
    });
    expect(r.total_cents).toBe(100);
  });

  it("pedido pendente, cancelado e reembolsado não entram", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-01", ate: "2026-11-30", granularidade: "mes", negocios: [],
      pedidos: [pedido("1", "2026-11-02T15:00:00Z", 100, { status: "pending" }), pedido("2", "2026-11-02T15:00:00Z", 100, { status: "cancelled" }), pedido("3", "2026-11-02T15:00:00Z", 100, { status: "refunded" }), pedido("4", "2026-11-02T15:00:00Z", 100, { status: "shipped" })],
    });
    expect(r.total_cents).toBe(100);
    expect(r.numero_de_vendas).toBe(1);
  });

  it("por produto soma os itens dos negócios ganhos; o que não tem item vai para 'sem produto'", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-01", ate: "2026-11-30", granularidade: "mes", pedidos: [],
      negocios: [
        negocio("a", "2026-11-02T15:00:00Z", 12000, { itens: [
          { product_id: "prod-1", nome: "Kit A", quantidade: 2, total_cents: 9000, currency: "BRL" },
          { product_id: null, nome: "Frete", quantidade: 1, total_cents: 1000, currency: "BRL" },
        ] }),
        negocio("b", "2026-11-03T15:00:00Z", 3000),
        negocio("c", "2026-11-04T15:00:00Z", 5000, { itens: [{ product_id: "prod-1", nome: "Kit A", quantidade: 1, total_cents: 5000, currency: "BRL" }] }),
      ],
    });
    expect(r.por_produto).toEqual([
      { chave: "prod-1", nome: "Kit A", quantidade: 3, total_cents: 14000 },
      { chave: "__sem_produto__", nome: null, quantidade: 0, total_cents: 5000 },
      { chave: "avulso:frete", nome: "Frete", quantidade: 1, total_cents: 1000 },
    ]);
    expect(r.por_produto.reduce((s, p) => s + p.total_cents, 0)).toBe(r.receita_negocios_cents);
  });

  it("por pipeline só conta negócios, com o nome do funil, do maior para o menor", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-01", ate: "2026-11-30", granularidade: "mes",
      negocios: [negocio("a", "2026-11-02T15:00:00Z", 1000), negocio("b", "2026-11-03T15:00:00Z", 4000, { pipeline_id: "pipe-2" }), negocio("c", "2026-11-04T15:00:00Z", 500)],
      pedidos: [pedido("p", "2026-11-05T15:00:00Z", 99999)],
    });
    expect(r.por_pipeline).toEqual([
      { pipeline_id: "pipe-2", nome: "Recompra", total_cents: 4000, vendas: 1 },
      { pipeline_id: "pipe-1", nome: "Kit", total_cents: 1500, vendas: 2 },
    ]);
  });

  it("outra moeda fica fora e é contada; negócio ganho sem valor conta como venda de zero", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-01", ate: "2026-11-30", granularidade: "mes", pedidos: [],
      negocios: [negocio("usd", "2026-11-02T15:00:00Z", 5000, { currency: "USD" }), negocio("zero", "2026-11-03T15:00:00Z", null)],
    });
    expect(r.total_cents).toBe(0);
    expect(r.numero_de_vendas).toBe(1);
    expect(r.ignorados_outra_moeda).toBe(1);
  });

  it("sem venda não há ticket médio", () => {
    const r = calcularFaturamento({ ...base, desde: "2026-11-01", ate: "2026-11-02", granularidade: "dia", negocios: [], pedidos: [] });
    expect(r.ticket_medio_cents).toBeNull();
    expect(r.total_cents).toBe(0);
  });
});

describe("consultaSchema", () => {
  it("padrão: últimos 30 dias, por dia", () => {
    const r = consultaSchema.parse({});
    expect(r.granularidade).toBe("dia");
  });
  it("recusa data fora do formato, intervalo invertido e período acima de 2 anos", () => {
    expect(consultaSchema.safeParse({ desde: "06/11/2026", ate: "2026-11-06" }).success).toBe(false);
    expect(consultaSchema.safeParse({ desde: "2026-11-06", ate: "2026-11-01" }).success).toBe(false);
    expect(consultaSchema.safeParse({ desde: "2020-01-01", ate: "2026-11-06" }).success).toBe(false);
    expect(consultaSchema.safeParse({ desde: "2026-11-01", ate: "2026-11-06", granularidade: "ano" }).success).toBe(false);
    expect(consultaSchema.safeParse({ desde: "2026-02-30", ate: "2026-03-01" }).success).toBe(false);
  });
});

describe("janelaDeBusca", () => {
  it("alarga um dia antes e dois depois para cobrir qualquer fuso", () => {
    expect(janelaDeBusca("2026-11-02", "2026-11-04")).toEqual({ de: "2026-11-01T00:00:00.000Z", ate: "2026-11-07T00:00:00.000Z" });
  });
});

// ── painel (dashboard): comparação, atendentes e vendas do período ────────────────────────────────────────────────
describe("periodoAnterior", () => {
  it("é o período de MESMO tamanho que termina na véspera do início", () => {
    expect(periodoAnterior("2026-11-08", "2026-11-14")).toEqual({ desde: "2026-11-01", ate: "2026-11-07" });
    expect(periodoAnterior("2026-11-01", "2026-11-30")).toEqual({ desde: "2026-10-02", ate: "2026-10-31" });
  });
  it("um dia só olha o dia anterior; atravessa virada de mês e de ano", () => {
    expect(periodoAnterior("2026-11-08", "2026-11-08")).toEqual({ desde: "2026-11-07", ate: "2026-11-07" });
    expect(periodoAnterior("2026-01-03", "2026-01-05")).toEqual({ desde: "2025-12-31", ate: "2026-01-02" });
  });
});

describe("variacaoPercentual", () => {
  it("cresceu, caiu, ficou igual (uma casa decimal)", () => {
    expect(variacaoPercentual(120, 100)).toBe(20);
    expect(variacaoPercentual(80, 100)).toBe(-20);
    expect(variacaoPercentual(100, 100)).toBe(0);
    expect(variacaoPercentual(1, 3)).toBe(-66.7);
  });
  it("sem base de comparação (anterior zero) não inventa percentual", () => {
    expect(variacaoPercentual(500, 0)).toBeNull();
    expect(variacaoPercentual(0, 0)).toBeNull();
  });
  it("zerou: -100%", () => {
    expect(variacaoPercentual(0, 100)).toBe(-100);
  });
});

describe("por_atendente", () => {
  const dono = (id: string, closed_at: string, valor: number, extra: Record<string, unknown> = {}) => negocio(id, closed_at, valor, extra);
  const entrada = {
    ...base, desde: "2026-11-01", ate: "2026-11-30", granularidade: "mes" as const, pedidos: [],
    nomesDosAtendentes: new Map([["u1", "Ana"], ["u2", "Bia"]]),
    negocios: [
      dono("a", "2026-11-02T15:00:00Z", 10000, { owner_user_id: "u1", owner_kind: "user" }),
      dono("b", "2026-11-03T15:00:00Z", 5000, { owner_user_id: "u2", owner_kind: "user" }),
      dono("c", "2026-11-04T15:00:00Z", 7000, { owner_user_id: "u2", owner_kind: "user" }),
      dono("d", "2026-11-05T15:00:00Z", 900, { owner_user_id: null, owner_kind: "ai" }),
      dono("e", "2026-11-06T15:00:00Z", 100, { owner_user_id: null, owner_kind: null }),
    ],
  };

  it("conta vendas e valor por atendente, mais vendas primeiro (empate: maior valor)", () => {
    const r = calcularFaturamento(entrada);
    expect(r.por_atendente.map((a) => [a.nome, a.vendas, a.total_cents])).toEqual([["Bia", 2, 12000], ["Ana", 1, 10000], [null, 1, 900], [null, 1, 100]]);
  });

  it("separa o agente de IA de quem não tem atendente", () => {
    const r = calcularFaturamento(entrada);
    expect(r.por_atendente.map((a) => a.tipo)).toEqual(["usuario", "usuario", "ia", "sem_atendente"]);
  });

  it("pedido da loja não tem atendente e não entra aqui", () => {
    const r = calcularFaturamento({ ...entrada, negocios: [], pedidos: [pedido("p", "2026-11-05T15:00:00Z", 500)] });
    expect(r.por_atendente).toEqual([]);
  });
});

describe("vendas do período", () => {
  it("lista negócios ganhos e pedidos pagos, a mais recente primeiro, com funil, atendente e produtos", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-01", ate: "2026-11-30", granularidade: "mes",
      nomesDosAtendentes: new Map([["u1", "Ana"]]),
      negocios: [
        negocio("a", "2026-11-02T15:00:00Z", 12000, { titulo: "Venda — Maria", owner_user_id: "u1", owner_kind: "user", itens: [
          { product_id: "p1", nome: "12 MESES (BETA)", quantidade: 1, total_cents: 12000, currency: "BRL" },
        ] }),
        negocio("b", "2026-11-04T15:00:00Z", 6000, { titulo: "Venda — João", itens: [
          { product_id: "p2", nome: "3 MESES (BETA)", quantidade: 2, total_cents: 6000, currency: "BRL" },
        ] }),
      ],
      pedidos: [pedido("pd1", "2026-11-03T15:00:00Z", 3000)],
    });
    expect(r.vendas.map((v) => [v.tipo, v.id])).toEqual([["negocio", "b"], ["pedido", "pd1"], ["negocio", "a"]]);
    expect(r.vendas[2]).toMatchObject({ lead_id: "a", titulo: "Venda — Maria", valor_cents: 12000, funil: "Kit", pipeline_id: "pipe-1", atendente_id: "u1", atendente_nome: "Ana", produtos: ["12 MESES (BETA)"] });
    expect(r.vendas[0]!.produtos).toEqual(["2× 3 MESES (BETA)"]);
    expect(r.vendas[1]).toMatchObject({ tipo: "pedido", lead_id: null, funil: null, atendente_id: null });
  });

  it("fora do período e de outra moeda não entram; a soma da lista fecha com o total", () => {
    const r = calcularFaturamento({
      ...base, desde: "2026-11-02", ate: "2026-11-02", granularidade: "dia", pedidos: [],
      negocios: [negocio("dentro", "2026-11-02T15:00:00Z", 100), negocio("fora", "2026-11-09T15:00:00Z", 900), negocio("usd", "2026-11-02T15:00:00Z", 900, { currency: "USD" })],
    });
    expect(r.vendas.map((v) => v.id)).toEqual(["dentro"]);
    expect(r.vendas.reduce((s, v) => s + v.valor_cents, 0)).toBe(r.total_cents);
  });

  it("corta em 200 linhas e avisa, sem mexer nos totais", () => {
    const muitos = Array.from({ length: 205 }, (_, i) => negocio(`n${i}`, `2026-11-02T${String(10 + (i % 10)).padStart(2, "0")}:00:00Z`, 100));
    const r = calcularFaturamento({ ...base, desde: "2026-11-01", ate: "2026-11-30", granularidade: "mes", pedidos: [], negocios: muitos });
    expect(r.vendas).toHaveLength(200);
    expect(r.vendas_cortadas).toBe(true);
    expect(r.numero_de_vendas).toBe(205);
    expect(r.total_cents).toBe(20500);
  });
});

describe("calcularPainel", () => {
  it("traz o período anterior de mesmo tamanho para os cartões compararem", () => {
    const r = calcularPainel({
      ...base, desde: "2026-11-08", ate: "2026-11-14", granularidade: "dia", pedidos: [],
      negocios: [
        negocio("atual1", "2026-11-09T15:00:00Z", 10000), negocio("atual2", "2026-11-10T15:00:00Z", 5000),
        negocio("ant1", "2026-11-02T15:00:00Z", 6000),
        negocio("muito-antes", "2026-10-20T15:00:00Z", 99999),
      ],
    });
    expect(r.total_cents).toBe(15000);
    expect(r.anterior).toEqual({ desde: "2026-11-01", ate: "2026-11-07", total_cents: 6000, numero_de_vendas: 1, ticket_medio_cents: 6000 });
  });

  it("período anterior sem vendas: zeros e ticket nulo", () => {
    const r = calcularPainel({ ...base, desde: "2026-11-08", ate: "2026-11-14", granularidade: "dia", pedidos: [], negocios: [negocio("a", "2026-11-09T15:00:00Z", 100)] });
    expect(r.anterior).toMatchObject({ total_cents: 0, numero_de_vendas: 0, ticket_medio_cents: null });
  });
});

describe("organização com produto interno: o total conta só negócios ganhos", () => {
  const entrada = {
    ...base, desde: "2026-11-01", ate: "2026-11-30", granularidade: "dia" as const,
    negocios: [negocio("a", "2026-11-02T15:00:00Z", 10000, { titulo: "Venda A" }), negocio("b", "2026-11-03T15:00:00Z", 5000, { titulo: "Venda B" })],
    pedidos: [pedido("p1", "2026-11-02T18:00:00Z", 7000), pedido("p2", "2026-11-04T18:00:00Z", 3000), pedido("p3", "2026-11-05T18:00:00Z", 999, { status: "cancelled" }), pedido("fora", "2026-12-05T18:00:00Z", 888)],
  };

  it("sem o modo (organização sem produto interno) o comportamento é o de sempre: pedidos entram na soma", () => {
    const r = calcularFaturamento(entrada);
    expect(r.total_cents).toBe(25000);
    expect(r.numero_de_vendas).toBe(4);
    expect(r.fora_do_total).toBeNull();
    expect(r.somente_negocios).toBe(false);
  });

  it("com o modo: total, vendas, ticket, série e lista são SÓ dos negócios ganhos", () => {
    const r = calcularFaturamento({ ...entrada, somenteNegocios: true });
    expect(r.somente_negocios).toBe(true);
    expect(r.total_cents).toBe(15000);
    expect(r.receita_negocios_cents).toBe(15000);
    expect(r.receita_pedidos_cents).toBe(0);
    expect(r.numero_de_vendas).toBe(2);
    expect(r.ticket_medio_cents).toBe(7500);
    expect(r.serie.reduce((s, p) => s + p.total_cents, 0)).toBe(15000);
    expect(r.serie.reduce((s, p) => s + p.vendas, 0)).toBe(2);
    expect(r.vendas.every((v) => v.tipo === "negocio")).toBe(true);
    expect(r.vendas.reduce((s, v) => s + v.valor_cents, 0)).toBe(15000);
  });

  it("os pedidos pagos do período aparecem à parte, 'fora do total' (cancelado e de outro período não)", () => {
    const r = calcularFaturamento({ ...entrada, somenteNegocios: true });
    expect(r.fora_do_total).toEqual({ pedidos_cents: 10000, pedidos: 2 });
  });

  it("o painel compara com o período anterior pela MESMA regra (só negócios nos dois lados)", () => {
    const r = calcularPainel({
      ...base, desde: "2026-11-08", ate: "2026-11-14", granularidade: "dia", somenteNegocios: true,
      negocios: [negocio("atual", "2026-11-09T15:00:00Z", 10000), negocio("ant", "2026-11-02T15:00:00Z", 4000)],
      pedidos: [pedido("pa", "2026-11-09T18:00:00Z", 9000), pedido("pb", "2026-11-02T18:00:00Z", 8000)],
    });
    expect(r.total_cents).toBe(10000);
    expect(r.anterior).toMatchObject({ total_cents: 4000, numero_de_vendas: 1 });
  });

  it("pedido em outra moeda não entra nem no 'fora do total'", () => {
    const r = calcularFaturamento({ ...entrada, somenteNegocios: true, pedidos: [pedido("usd", "2026-11-02T18:00:00Z", 5000, { currency: "USD" })] });
    expect(r.fora_do_total).toEqual({ pedidos_cents: 0, pedidos: 0 });
    expect(r.ignorados_outra_moeda).toBe(1);
  });
});
