import { describe, expect, it } from "vitest";

import { SEM_PRODUTO, type NegocioGanhoParaFaturar } from "./faturamento";
import {
  calcularPainelDeVendas,
  calcularRecompra,
  tagsDeOrigemDaOrganizacao,
  tempoMedioAteAVenda,
  type EntradaDoPainelDeVendas,
} from "./painel-vendas";

const TZ = "America/Sao_Paulo";
const HOJE = "2026-11-16";
// Este mês: 2026-11-01..2026-11-16 (16 dias). Período anterior de mesmo tamanho: 2026-10-16..2026-10-31.

let seq = 0;
function negocio(over: Partial<NegocioGanhoParaFaturar> & { dia: string; valor: number }): NegocioGanhoParaFaturar {
  seq += 1;
  const { dia, valor, ...resto } = over;
  return {
    lead_id: `lead-${seq}`,
    pipeline_id: "pipe-1",
    closed_at: `${dia}T15:00:00.000Z`,
    value_cents: valor,
    currency: "BRL",
    itens: [],
    ...resto,
  };
}

function entrada(over: Partial<EntradaDoPainelDeVendas> = {}): EntradaDoPainelDeVendas {
  return {
    negocios: [],
    pedidos: [],
    pipelines: new Map([["pipe-1", "Funil"]]),
    moeda: "BRL",
    timezone: TZ,
    desde: "2026-11-01",
    ate: HOJE,
    anterior: { desde: "2026-10-16", ate: "2026-10-31" },
    somenteNegocios: false,
    hoje: HOJE,
    regrasDeOrigem: { produtos: [], por_fonte: {} },
    leads: { atual: { criados: 0, ganhos: 0 }, anterior: { criados: 0, ganhos: 0 } },
    comprasDosContatos: [],
    metaCents: null,
    ...over,
  };
}

describe("cartões: faturamento, vendas e ticket médio contra o período anterior", () => {
  const negocios = [
    negocio({ dia: "2026-11-03", valor: 10_000 }),
    negocio({ dia: "2026-11-10", valor: 20_000 }),
    negocio({ dia: "2026-11-16", valor: 30_000 }),
    negocio({ dia: "2026-10-20", valor: 20_000 }),
    negocio({ dia: "2026-10-30", valor: 20_000 }),
  ];

  it("⭐ soma o período, o anterior, e calcula as variações", () => {
    const p = calcularPainelDeVendas(entrada({ negocios }));
    expect(p.faturamento).toEqual({ atual: 60_000, anterior: 40_000, variacao: 50 });
    expect(p.vendas).toEqual({ atual: 3, anterior: 2, variacao: 50 });
    expect(p.ticket_medio).toEqual({ atual: 20_000, anterior: 20_000, variacao: 0 });
    expect(p.anterior).toEqual({ desde: "2026-10-16", ate: "2026-10-31" });
  });

  it("sem base (anterior zero) não inventa percentual", () => {
    const p = calcularPainelDeVendas(entrada({ negocios: negocios.slice(0, 3) }));
    expect(p.faturamento.variacao).toBeNull();
    expect(p.vendas.variacao).toBeNull();
    expect(p.ticket_medio).toEqual({ atual: 20_000, anterior: null, variacao: null });
  });

  it("sem nenhuma venda: zeros, ticket nulo", () => {
    const p = calcularPainelDeVendas(entrada());
    expect(p.faturamento.atual).toBe(0);
    expect(p.vendas.atual).toBe(0);
    expect(p.ticket_medio.atual).toBeNull();
  });

  it("a série tem um ponto por dia, com o dia de mesma posição do período anterior", () => {
    const p = calcularPainelDeVendas(entrada({ negocios }));
    expect(p.serie).toHaveLength(16);
    expect(p.serie[0]).toMatchObject({ dia: "2026-11-01", total_cents: 0, anterior_cents: 0 });
    // 2026-11-03 é o 3º dia; o 3º do anterior é 2026-10-18 (sem venda).
    expect(p.serie[2]).toMatchObject({ dia: "2026-11-03", total_cents: 10_000, anterior_cents: 0 });
    // 2026-10-20 é o 5º dia do anterior; 2026-11-05 é o 5º do atual.
    expect(p.serie[4]).toMatchObject({ dia: "2026-11-05", total_cents: 0, anterior_cents: 20_000 });
    expect(p.serie.reduce((s, x) => s + x.total_cents, 0)).toBe(p.faturamento.atual);
    expect(p.serie.reduce((s, x) => s + (x.anterior_cents ?? 0), 0)).toBe(p.faturamento.anterior);
  });

  it("o dia é o do FUSO da organização: venda às 22h em São Paulo não vira o dia seguinte", () => {
    // 2026-11-16T01:30Z = 15/11 22:30 em São Paulo.
    const p = calcularPainelDeVendas(entrada({ negocios: [negocio({ dia: "2026-11-16", valor: 5_000, closed_at: "2026-11-16T01:30:00.000Z" })] }));
    expect(p.serie.find((x) => x.dia === "2026-11-15")?.total_cents).toBe(5_000);
    expect(p.serie.find((x) => x.dia === "2026-11-16")?.total_cents).toBe(0);
  });

  it("venda em outra moeda não entra nos totais, e o painel diz quantas ficaram de fora", () => {
    const p = calcularPainelDeVendas(entrada({ negocios: [negocio({ dia: "2026-11-05", valor: 9_000, currency: "USD" }), negocio({ dia: "2026-11-06", valor: 1_000 })] }));
    expect(p.faturamento.atual).toBe(1_000);
    expect(p.ignorados_outra_moeda).toBe(1);
  });

  it("pedido pago da loja entra no total quando a empresa NÃO tem produto interno", () => {
    const pedidos = [{ id: "o1", ordered_at: "2026-11-04T15:00:00.000Z", total_cents: 7_000, currency: "BRL", status: "paid" }];
    const p = calcularPainelDeVendas(entrada({ negocios: [negocio({ dia: "2026-11-05", valor: 1_000 })], pedidos }));
    expect(p.faturamento.atual).toBe(8_000);
    expect(p.vendas.atual).toBe(2);
  });
});

describe("o período de comparação vem de quem chama (achado 7: mesmos dias do mês anterior)", () => {
  it("⭐ compara com o intervalo recebido, não com 'mesmo tamanho na véspera'", () => {
    const negocios = [
      negocio({ dia: "2026-11-03", valor: 10_000 }),
      negocio({ dia: "2026-10-03", valor: 5_000 }), // dentro de 01–16/10
      negocio({ dia: "2026-10-20", valor: 99_000 }), // fora: só entraria no "mesmo tamanho na véspera"
    ];
    const p = calcularPainelDeVendas(entrada({ negocios, anterior: { desde: "2026-10-01", ate: "2026-10-16" } }));
    expect(p.anterior).toEqual({ desde: "2026-10-01", ate: "2026-10-16" });
    expect(p.faturamento).toEqual({ atual: 10_000, anterior: 5_000, variacao: 100 });
  });

  it("anterior mais curto que o período: o dia sem par fica NULO (o gráfico não desenha zero falso)", () => {
    const negocios = [negocio({ dia: "2026-10-31", valor: 7_000 }), negocio({ dia: "2026-09-30", valor: 3_000 })];
    // 'Mês passado' (outubro, 31 dias) contra setembro (30 dias).
    const p = calcularPainelDeVendas(entrada({ negocios, desde: "2026-10-01", ate: "2026-10-31", anterior: { desde: "2026-09-01", ate: "2026-09-30" } }));
    expect(p.serie).toHaveLength(31);
    expect(p.serie[29]).toMatchObject({ dia: "2026-10-30", anterior_cents: 3_000 });
    expect(p.serie[30]).toMatchObject({ dia: "2026-10-31", total_cents: 7_000, anterior_cents: null });
  });

  it("anterior mais longo que o período não vaza dias a mais para a série", () => {
    const p = calcularPainelDeVendas(entrada({ desde: "2026-11-01", ate: "2026-11-02", anterior: { desde: "2026-10-01", ate: "2026-10-05" } }));
    expect(p.serie).toHaveLength(2);
  });
});

describe("SIGILO: produto interno e valor sigiloso", () => {
  const VALOR_DO_PEDIDO_CHEIO = 987_654_321;
  const pedidos = [
    { id: "o1", ordered_at: "2026-11-04T15:00:00.000Z", total_cents: VALOR_DO_PEDIDO_CHEIO, currency: "BRL", status: "paid" },
    { id: "o2", ordered_at: "2026-10-20T15:00:00.000Z", total_cents: VALOR_DO_PEDIDO_CHEIO, currency: "BRL", status: "delivered" },
  ];
  const negocios = [negocio({ dia: "2026-11-05", valor: 1_500, itens: [{ product_id: "p1", nome: "Plano", quantidade: 1, total_cents: 1_500, currency: "BRL" }] })];

  it("⭐ com produto interno, o pedido a preço cheio fica FORA de tudo: total, vendas, ticket, série, produtos e variação", () => {
    const p = calcularPainelDeVendas(entrada({ negocios, pedidos, somenteNegocios: true }));
    expect(p.faturamento).toEqual({ atual: 1_500, anterior: 0, variacao: null });
    expect(p.vendas.atual).toBe(1);
    expect(p.ticket_medio.atual).toBe(1_500);
    expect(p.serie.reduce((s, x) => s + x.total_cents + (x.anterior_cents ?? 0), 0)).toBe(1_500);
    expect(p.produtos.reduce((s, x) => s + x.total_cents, 0)).toBe(1_500);
    expect(p.somente_negocios).toBe(true);
  });

  it("⭐ o valor do pedido nem existe no resultado do painel (nada para a tela mostrar)", () => {
    const p = calcularPainelDeVendas(entrada({ negocios, pedidos, somenteNegocios: true }));
    expect(JSON.stringify(p)).not.toContain(String(VALOR_DO_PEDIDO_CHEIO));
    expect(JSON.stringify(p)).not.toContain("fora_do_total");
  });

  it("⭐ o painel não tem campo de preço de catálogo nem de sigilo para vazar", () => {
    const p = calcularPainelDeVendas(entrada({ negocios, pedidos, somenteNegocios: true }));
    const chaves = JSON.stringify(p);
    for (const proibido of ["preco", "price", "unit_price", "so_interno", "valor_sigiloso", "comissao"]) {
      expect(chaves).not.toContain(proibido);
    }
  });

  it("a meta do mês também conta só negócios nesse modo", () => {
    const p = calcularPainelDeVendas(entrada({ negocios, pedidos, somenteNegocios: true, metaCents: 10_000 }));
    expect(p.mes_corrente_cents).toBe(1_500);
    expect(p.meta?.realizado_cents).toBe(1_500);
  });
});

describe("produtos mais vendidos", () => {
  const item = (nome: string, quantidade: number, total: number, id: string | null = nome) => ({ product_id: id, nome, quantidade, total_cents: total, currency: "BRL" });

  it("ordena por quantidade, depois valor; o que sobra do valor sobre os itens vira 'sem produto'", () => {
    const p = calcularPainelDeVendas(
      entrada({
        negocios: [
          negocio({ dia: "2026-11-02", valor: 13_000, itens: [item("A", 1, 5_000), item("B", 3, 6_000)] }),
          negocio({ dia: "2026-11-03", valor: 4_000, itens: [item("A", 1, 4_000)] }),
        ],
      }),
    );
    expect(p.produtos.map((x) => [x.nome, x.quantidade, x.total_cents])).toEqual([
      ["B", 3, 6_000],
      ["A", 2, 9_000],
    ]);
    expect(p.sem_produto_cents).toBe(2_000);
    expect(p.produtos.some((x) => x.chave === SEM_PRODUTO)).toBe(false);
  });

  it("mostra no máximo 8 produtos", () => {
    const itens = Array.from({ length: 12 }, (_, i) => item(`P${i}`, 1, 100, `id${i}`));
    const p = calcularPainelDeVendas(entrada({ negocios: [negocio({ dia: "2026-11-02", valor: 1_200, itens })] }));
    expect(p.produtos).toHaveLength(8);
  });
});

describe("vendas por origem (tags de origem da organização)", () => {
  const regras = { produtos: [], por_fonte: { meta_ads: "Meta Ads", site: "site", indicacao: "Indicação" } };

  it("⭐ agrupa pela tag de origem, e origem + sem origem fecha com a receita de negócios", () => {
    const negocios = [
      negocio({ dia: "2026-11-02", valor: 1_000, tags: ["META ADS", "VIP"] }),
      negocio({ dia: "2026-11-03", valor: 2_000, tags: ["meta ads"] }),
      negocio({ dia: "2026-11-04", valor: 4_000, tags: ["SITE"] }),
      negocio({ dia: "2026-11-05", valor: 8_000, tags: ["VIP"] }),
      negocio({ dia: "2026-11-06", valor: 16_000 }),
    ];
    const p = calcularPainelDeVendas(entrada({ negocios, regrasDeOrigem: regras }));
    expect(p.origem.configurada).toBe(true);
    expect(p.origem.linhas).toEqual([
      { tag: "META ADS", vendas: 2, total_cents: 3_000 },
      { tag: "SITE", vendas: 1, total_cents: 4_000 },
    ].sort((a, b) => b.total_cents - a.total_cents));
    expect(p.origem.sem_origem).toEqual({ vendas: 2, total_cents: 24_000 });
    const somado = p.origem.linhas.reduce((s, l) => s + l.total_cents, 0) + p.origem.sem_origem.total_cents;
    expect(somado).toBe(p.faturamento.atual);
  });

  it("negócio com duas tags de origem conta UMA vez (a primeira na ordem das regras)", () => {
    const p = calcularPainelDeVendas(entrada({ negocios: [negocio({ dia: "2026-11-02", valor: 1_000, tags: ["SITE", "META ADS"] })], regrasDeOrigem: regras }));
    expect(p.origem.linhas).toEqual([{ tag: "META ADS", vendas: 1, total_cents: 1_000 }]);
  });

  it("só conta venda do período e da moeda", () => {
    const p = calcularPainelDeVendas(
      entrada({
        negocios: [negocio({ dia: "2026-10-20", valor: 5_000, tags: ["SITE"] }), negocio({ dia: "2026-11-02", valor: 6_000, tags: ["SITE"], currency: "USD" })],
        regrasDeOrigem: regras,
      }),
    );
    expect(p.origem.linhas).toEqual([]);
    expect(p.origem.sem_origem).toEqual({ vendas: 0, total_cents: 0 });
  });

  it("sem regras de origem cadastradas: não configurada, nada agrupado por tag solta", () => {
    const p = calcularPainelDeVendas(entrada({ negocios: [negocio({ dia: "2026-11-02", valor: 1_000, tags: ["META ADS"] })] }));
    expect(p.origem.configurada).toBe(false);
    expect(p.origem.linhas).toEqual([]);
  });

  it("passando de 8 origens, o resto vira 'OUTRAS' e a soma continua fechando", () => {
    const por_fonte = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, `ORIGEM ${i}`]));
    const negocios = Array.from({ length: 10 }, (_, i) => negocio({ dia: "2026-11-02", valor: (i + 1) * 100, tags: [`ORIGEM ${i}`] }));
    const p = calcularPainelDeVendas(entrada({ negocios, regrasDeOrigem: { produtos: [], por_fonte } }));
    expect(p.origem.linhas).toHaveLength(9);
    expect(p.origem.linhas.at(-1)?.tag).toBe("OUTRAS");
    expect(p.origem.linhas.reduce((s, l) => s + l.total_cents, 0)).toBe(p.faturamento.atual);
  });

  it("tagsDeOrigemDaOrganizacao: valores de por_fonte, em maiúsculas, sem repetir", () => {
    expect(tagsDeOrigemDaOrganizacao({ produtos: [], por_fonte: { a: "Meta Ads", b: "META ADS", c: " site " } })).toEqual(["META ADS", "SITE"]);
  });
});

describe("conversão lead → venda", () => {
  it("⭐ taxa do período, a do anterior e a variação", () => {
    const p = calcularPainelDeVendas(entrada({ leads: { atual: { criados: 50, ganhos: 5 }, anterior: { criados: 40, ganhos: 2 } } }));
    expect(p.conversao.leads).toBe(50);
    expect(p.conversao.ganhos).toBe(5);
    expect(p.conversao.taxa.atual).toBeCloseTo(0.1);
    expect(p.conversao.taxa.anterior).toBeCloseTo(0.05);
    expect(p.conversao.taxa.variacao).toBe(100);
  });

  it("sem leads no período não divide por zero: taxa nula", () => {
    const p = calcularPainelDeVendas(entrada());
    expect(p.conversao.taxa).toEqual({ atual: null, anterior: null, variacao: null });
  });
});

describe("tempo médio até a venda", () => {
  it("média entre created_at e closed_at; negócio sem data de nascimento fica de fora", () => {
    const h = (n: number) => n * 3_600_000;
    const ms = tempoMedioAteAVenda([
      { created_at: "2026-11-01T00:00:00.000Z", closed_at: "2026-11-02T00:00:00.000Z" },
      { created_at: "2026-11-01T00:00:00.000Z", closed_at: "2026-11-01T12:00:00.000Z" },
      { created_at: null, closed_at: "2026-11-05T00:00:00.000Z" },
    ]);
    expect(ms).toBe(h(18));
  });

  it("sem nenhum negócio com created_at: nulo; data impossível (venda antes do lead) é ignorada", () => {
    expect(tempoMedioAteAVenda([])).toBeNull();
    expect(tempoMedioAteAVenda([{ created_at: "2026-11-02T00:00:00.000Z", closed_at: "2026-11-01T00:00:00.000Z" }])).toBeNull();
  });

  it("entra no painel, com a variação contra o anterior", () => {
    const p = calcularPainelDeVendas(
      entrada({
        negocios: [
          negocio({ dia: "2026-11-05", valor: 1, created_at: "2026-11-04T15:00:00.000Z" }), // 24 h
          negocio({ dia: "2026-10-20", valor: 1, created_at: "2026-10-18T15:00:00.000Z" }), // 48 h
        ],
      }),
    );
    expect(p.tempo_ate_a_venda_ms).toEqual({ atual: 86_400_000, anterior: 172_800_000, variacao: -50 });
  });
});

describe("recompra", () => {
  const compra = (contact: string, lead: string, closed_at: string) => ({ contact_id: contact, lead_id: lead, closed_at });

  it("⭐ cliente com outra compra antes do período, ou duas dentro dele, é recompra; compra única não é", () => {
    const doPeriodo = [{ contact_id: "a" }, { contact_id: "b" }, { contact_id: "c" }, { contact_id: "c" }, { contact_id: null }];
    const r = calcularRecompra(
      doPeriodo,
      [
        compra("a", "a1", "2026-09-01T15:00:00.000Z"), // antes
        compra("a", "a2", "2026-11-05T15:00:00.000Z"),
        compra("b", "b1", "2026-11-06T15:00:00.000Z"), // só esta
        compra("c", "c1", "2026-11-07T15:00:00.000Z"), // duas dentro
        compra("c", "c2", "2026-11-08T15:00:00.000Z"),
      ],
      "2026-11-16",
      TZ,
    );
    expect(r).toEqual({ clientes: 3, recompradores: 2, taxa: 2 / 3 });
  });

  it("compra DEPOIS do fim do período não faz o cliente do período virar recompra", () => {
    const r = calcularRecompra([{ contact_id: "a" }], [compra("a", "a1", "2026-11-05T15:00:00.000Z"), compra("a", "a2", "2026-12-20T15:00:00.000Z")], "2026-11-16", TZ);
    expect(r.recompradores).toBe(0);
  });

  it("a mesma venda repetida na leitura não conta como duas", () => {
    const r = calcularRecompra([{ contact_id: "a" }], [compra("a", "a1", "2026-11-05T15:00:00.000Z"), compra("a", "a1", "2026-11-05T15:00:00.000Z")], "2026-11-16", TZ);
    expect(r.recompradores).toBe(0);
  });

  it("sem cliente com cadastro: taxa nula", () => {
    expect(calcularRecompra([{ contact_id: null }], [], "2026-11-16", TZ)).toEqual({ clientes: 0, recompradores: 0, taxa: null });
  });

  it("entra no painel, e a do período anterior usa o fim DELE (compra do período atual não conta para trás)", () => {
    const p = calcularPainelDeVendas(
      entrada({
        negocios: [
          negocio({ dia: "2026-10-20", valor: 1, contact_id: "a", lead_id: "a1" }),
          negocio({ dia: "2026-11-05", valor: 1, contact_id: "a", lead_id: "a2" }),
        ],
        comprasDosContatos: [compra("a", "a1", "2026-10-20T15:00:00.000Z"), compra("a", "a2", "2026-11-05T15:00:00.000Z")],
      }),
    );
    expect(p.recompra).toMatchObject({ clientes: 1, recompradores: 1 });
    expect(p.recompra.taxa).toEqual({ atual: 1, anterior: 0, variacao: null });
  });
});

describe("meta do mês", () => {
  it("é do MÊS CORRENTE, seja qual for o período escolhido", () => {
    const negocios = [negocio({ dia: "2026-11-02", valor: 40_000 }), negocio({ dia: "2026-10-28", valor: 99_000 })];
    // Período "mês passado": 2026-10-01..2026-10-31.
    const p = calcularPainelDeVendas(entrada({ negocios, desde: "2026-10-01", ate: "2026-10-31", metaCents: 100_000 }));
    expect(p.faturamento.atual).toBe(99_000);
    expect(p.mes_corrente_cents).toBe(40_000);
    expect(p.meta).toMatchObject({ meta_cents: 100_000, realizado_cents: 40_000, percentual: 40 });
  });

  it("sem meta definida: nulo", () => {
    expect(calcularPainelDeVendas(entrada()).meta).toBeNull();
  });
});
