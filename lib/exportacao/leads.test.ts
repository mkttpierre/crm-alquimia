// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bancoFalso, type Linha } from "@/tests/helpers/postgrest-falso";

import { prepararExportacaoDeLeads } from "./leads";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const FUNIL = "f1";
const OUTRO_FUNIL = "f2";
const USUARIO = "u1";
const AGENTE = "a1";
const t = (texto: string) => texto;

const CONTATO_MARIA = { display_name: "Maria", name: "Maria Silva", phone_number: "+5511999990001", tags: ["vip"], is_anonymized: false };

function lead(n: number, extra: Linha = {}): Linha {
  return {
    id: `l-${String(n).padStart(6, "0")}`,
    organization_id: ORG,
    contact_id: "ct1",
    pipeline_id: FUNIL,
    stage_id: "e1",
    status: "open",
    title: `Negócio ${n}`,
    owner_kind: null,
    owner_user_id: null,
    owner_agent_id: null,
    value_cents: 123456,
    valor_sigiloso: false,
    tags: ["quente"],
    custom_fields: {},
    created_at: "2026-11-01T12:00:00.000Z",
    updated_at: "2026-11-02T12:00:00.000Z",
    contacts: CONTATO_MARIA,
    ...extra,
  };
}

const BASE = {
  crm_pipelines: [
    { id: FUNIL, organization_id: ORG, name: "Vendas" },
    { id: OUTRO_FUNIL, organization_id: ORG, name: "Pós-venda" },
  ],
  crm_stages: [
    { id: "e1", organization_id: ORG, pipeline_id: FUNIL, name: "Novo" },
    { id: "e2", organization_id: ORG, pipeline_id: OUTRO_FUNIL, name: "Acompanhar" },
  ],
  ai_agents: [{ id: AGENTE, organization_id: ORG, name: "Ana IA" }],
};

const donos = async (_org: string, ids: ReadonlyArray<string>) =>
  new Map<string, string | null>(ids.map((i) => [i, i === USUARIO ? "Carlos Gestor" : null]));

async function preparar(
  tabelas: Record<string, Linha[]>,
  filtros: Parameters<typeof prepararExportacaoDeLeads>[2] = {},
  opcoes: { falharEm?: string } = {},
) {
  const { db, consultas } = bancoFalso({ ...BASE, ...tabelas }, opcoes);
  const prep = await prepararExportacaoDeLeads(db, ORG, filtros, t, donos);
  return { prep, consultas };
}

async function tudo(prep: { paginas: () => AsyncGenerator<string[][]> }): Promise<string[][]> {
  const linhas: string[][] = [];
  for await (const pagina of prep.paginas()) linhas.push(...pagina);
  return linhas;
}

describe("exportação de leads — colunas", () => {
  it("cabeçalho na ordem da decisão + uma coluna por chave de campo personalizado", async () => {
    const { prep } = await preparar({
      crm_leads: [lead(1, { custom_fields: { origem_da_campanha: "ads", cidade: "Recife" } })],
    });
    expect(prep.cabecalho).toEqual([
      "Nome",
      "Telefone",
      "Funil",
      "Etapa",
      "Dono",
      "Valor",
      "Etiquetas",
      "Criado em",
      "Última atualização",
      "cidade",
      "origem_da_campanha",
    ]);
  });

  it("linha completa: contato, funil e etapa por nome, dono, valor em reais, etiquetas com |", async () => {
    const { prep } = await preparar({
      crm_leads: [lead(1, { owner_kind: "user", owner_user_id: USUARIO, custom_fields: { cidade: "Recife" } })],
    });
    const [linha] = await tudo(prep);
    const col = (n: string) => prep.cabecalho.indexOf(n);
    expect(linha![col("Nome")]).toBe("Maria");
    expect(linha![col("Telefone")]).toBe("+5511999990001");
    expect(linha![col("Funil")]).toBe("Vendas");
    expect(linha![col("Etapa")]).toBe("Novo");
    expect(linha![col("Dono")]).toBe("Carlos Gestor");
    expect(linha![col("Valor")]).toBe("1234,56");
    expect(linha![col("Etiquetas")]).toBe("quente");
    expect(linha![col("Criado em")]).toBe("2026-11-01T12:00:00.000Z");
    expect(linha![col("Última atualização")]).toBe("2026-11-02T12:00:00.000Z");
    expect(linha![col("cidade")]).toBe("Recife");
  });

  it("dono que é agente de IA sai pelo nome do agente", async () => {
    const { prep } = await preparar({
      crm_leads: [lead(1, { owner_kind: "ai", owner_agent_id: AGENTE })],
    });
    const [linha] = await tudo(prep);
    expect(linha![prep.cabecalho.indexOf("Dono")]).toBe("Ana IA");
  });

  it("sem dono, a célula é vazia; negócio sem contato usa o título como nome", async () => {
    const { prep } = await preparar({
      crm_leads: [lead(1, { contact_id: null, contacts: null, title: "Reforma da Silva" })],
    });
    const [linha] = await tudo(prep);
    expect(linha![prep.cabecalho.indexOf("Dono")]).toBe("");
    expect(linha![prep.cabecalho.indexOf("Nome")]).toBe("Reforma da Silva");
    expect(linha![prep.cabecalho.indexOf("Telefone")]).toBe("");
  });

  it("valor nulo (negócio sem valor) é célula vazia, não 0,00", async () => {
    const { prep } = await preparar({ crm_leads: [lead(1, { value_cents: null })] });
    const [linha] = await tudo(prep);
    expect(linha![prep.cabecalho.indexOf("Valor")]).toBe("");
  });
});

describe("exportação de leads — a comissão do dono NUNCA sai", () => {
  it("negócio com valor_sigiloso: valor vazio", async () => {
    const { prep } = await preparar({
      crm_leads: [lead(1, { valor_sigiloso: true, value_cents: 99900 }), lead(2, { valor_sigiloso: false, value_cents: 5000 })],
    });
    const [sigiloso, aberto] = await tudo(prep);
    const v = prep.cabecalho.indexOf("Valor");
    expect(sigiloso![v]).toBe("");
    expect(aberto![v]).toBe("50,00");
  });

  it("FALHA FECHADO: linha sem a marca valor_sigiloso é tratada como sigilosa", async () => {
    const semMarca = lead(1, { value_cents: 77700 });
    delete semMarca.valor_sigiloso;
    const { prep } = await preparar({ crm_leads: [semMarca] });
    const [linha] = await tudo(prep);
    expect(linha![prep.cabecalho.indexOf("Valor")]).toBe("");
  });

  it("campos personalizados com nome de dinheiro somem do negócio sigiloso, e a coluna não nasce se só ele a tem", async () => {
    const { prep } = await preparar({
      crm_leads: [
        lead(1, { valor_sigiloso: true, custom_fields: { valor_proposta: "R$ 900", cidade: "Recife" } }),
        lead(2, { valor_sigiloso: false, custom_fields: { desconto_acordado: "10%" } }),
      ],
    });
    const linhas = await tudo(prep);
    expect(prep.cabecalho).toContain("cidade");
    expect(prep.cabecalho).toContain("desconto_acordado");
    expect(prep.cabecalho).not.toContain("valor_proposta");
    expect(JSON.stringify(linhas[0])).not.toContain("R$ 900");
  });

  // I1: a regra é a canônica do repo (CAMPO_DE_DINHEIRO: cents|amount|price|preco|valor|total), não uma regex própria.
  it.each(["total", "total_cents", "ganho_cents", "Preco_Final", "amount_paid"])(
    "campo personalizado %s some do negócio sigiloso (regra canônica de dinheiro)",
    async (chave) => {
      const { prep } = await preparar({
        crm_leads: [lead(1, { valor_sigiloso: true, custom_fields: { [chave]: "7777", cidade: "Recife" } })],
      });
      const linhas = await tudo(prep);
      expect(prep.cabecalho).not.toContain(chave);
      expect(JSON.stringify(linhas)).not.toContain("7777");
    },
  );

  it("objeto aninhado: o campo de dinheiro de dentro some e o resto fica", async () => {
    const { prep } = await preparar({
      crm_leads: [
        lead(1, {
          valor_sigiloso: true,
          custom_fields: { proposta: { preco_cents: 88800, itens: [{ nome: "Site", total: 5 }], nota: "ok" } },
        }),
      ],
    });
    const [linha] = await tudo(prep);
    const celula = linha![prep.cabecalho.indexOf("proposta")]!;
    expect(celula).toContain("ok");
    expect(celula).toContain("Site");
    expect(celula).not.toContain("88800");
    expect(celula).not.toContain("preco_cents");
    expect(celula).not.toContain("total");
  });

  it("negócio NÃO sigiloso mantém os campos de dinheiro (só o sigiloso é filtrado)", async () => {
    const { prep } = await preparar({
      crm_leads: [lead(1, { valor_sigiloso: false, custom_fields: { total_cents: 4500, proposta: { preco_cents: 1 } } })],
    });
    const [linha] = await tudo(prep);
    expect(linha![prep.cabecalho.indexOf("total_cents")]).toBe("4500");
    expect(linha![prep.cabecalho.indexOf("proposta")]).toContain("preco_cents");
  });

  it("não pede ao banco nenhuma tabela de produto ou item (preço de plano interno)", async () => {
    const { consultas } = await preparar({
      crm_leads: [lead(1)],
      catalog_products: [{ id: "p1", organization_id: ORG, so_interno: true, preco_cents: 1 }],
      crm_lead_items: [],
    });
    expect(consultas.map((c) => c.tabela)).not.toContain("catalog_products");
    expect(consultas.map((c) => c.tabela)).not.toContain("crm_lead_items");
  });
});

describe("exportação de leads — escopo e filtros", () => {
  it("ISOLAMENTO: só leads da organização", async () => {
    const { prep } = await preparar({
      crm_leads: [lead(1), lead(2, { organization_id: OUTRA_ORG, title: "Da Outra Org", contacts: { ...CONTATO_MARIA, display_name: "Da Outra Org" } })],
    });
    const linhas = await tudo(prep);
    expect(linhas).toHaveLength(1);
    expect(JSON.stringify(linhas)).not.toContain("Da Outra Org");
  });

  it("filtro de funil: só os negócios daquele funil", async () => {
    const { prep } = await preparar(
      { crm_leads: [lead(1), lead(2, { pipeline_id: OUTRO_FUNIL, stage_id: "e2" })] },
      { pipeline: OUTRO_FUNIL },
    );
    const linhas = await tudo(prep);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]![prep.cabecalho.indexOf("Funil")]).toBe("Pós-venda");
  });

  it("busca e tag valem sobre o CONTATO, com a mesma regra da tela de Leads (filtroDaBusca)", async () => {
    const ana = { display_name: "Ana Souza", name: null, phone_number: "+5511911110000", tags: ["vip"], is_anonymized: false };
    const bruno = { display_name: "Bruno", name: null, phone_number: "+5511922220000", tags: [], is_anonymized: false };
    const { prep, consultas } = await preparar(
      { crm_leads: [lead(1, { contacts: ana }), lead(2, { contacts: bruno }), lead(3, { contacts: ana, title: "Outro da Ana" })] },
      { busca: "ana" },
    );
    expect(await tudo(prep)).toHaveLength(2);
    // Com busca, o contato é obrigatório (inner join): senão o filtro só esconderia o contato e o negócio ficaria.
    expect(consultas.some((c) => /contacts!inner/.test(c.colunas))).toBe(true);

    const porTag = await preparar(
      { crm_leads: [lead(1, { contacts: ana }), lead(2, { contacts: bruno })] },
      { tag: "vip" },
    );
    expect(await tudo(porTag.prep)).toHaveLength(1);
  });

  it("sem busca nem tag, negócio sem contato também sai (junção à esquerda)", async () => {
    const { prep, consultas } = await preparar({ crm_leads: [lead(1), lead(2, { contact_id: null, contacts: null })] });
    expect(await tudo(prep)).toHaveLength(2);
    expect(consultas.some((c) => /contacts!inner/.test(c.colunas))).toBe(false);
  });

  it("contato anonimizado sai anonimizado, sem campos personalizados do contato nem do negócio com dado pessoal do contato", async () => {
    const anon = { display_name: "Cliente Anonimizado #3", name: "Cliente Anonimizado #3", phone_number: null, tags: [], is_anonymized: true };
    const { prep } = await preparar({ crm_leads: [lead(1, { contacts: anon })] });
    const [linha] = await tudo(prep);
    expect(linha![prep.cabecalho.indexOf("Nome")]).toBe("Cliente Anonimizado #3");
    expect(linha![prep.cabecalho.indexOf("Telefone")]).toBe("");
  });

  it("negócio de contato anonimizado não leva campos personalizados (nem cria a coluna por causa dele)", async () => {
    const anon = { display_name: "Cliente Anonimizado #3", name: null, phone_number: "+5511900000000", tags: [], is_anonymized: true };
    const { prep } = await preparar({
      crm_leads: [lead(1, { contacts: anon, custom_fields: { endereco: "Rua Secreta 10" } })],
    });
    const linhas = await tudo(prep);
    expect(prep.cabecalho).not.toContain("endereco");
    expect(JSON.stringify(linhas)).not.toContain("Rua Secreta");
    // Mesmo que sobre telefone na linha, o contato anonimizado não o entrega.
    expect(JSON.stringify(linhas)).not.toContain("+5511900000000");
  });
});

describe("exportação de leads — volume", () => {
  it("lê MAIS de 1.000 negócios com .range(), sem repetir nem pular", async () => {
    const todos = Array.from({ length: 2300 }, (_, i) => lead(i + 1));
    const { prep, consultas } = await preparar({ crm_leads: todos });
    const tamanhos: number[] = [];
    const titulos = new Set<string>();
    for await (const pagina of prep.paginas()) {
      tamanhos.push(pagina.length);
      for (const l of pagina) titulos.add(l[0]! + "|" + l[7]);
    }
    expect(tamanhos).toEqual([1000, 1000, 300]);
    const faixas = consultas.filter((c) => c.tabela === "crm_leads" && c.faixa).map((c) => c.faixa);
    expect(faixas).toContainEqual([1000, 1999]);
    expect(consultas.filter((c) => c.tabela === "crm_leads" && c.faixa).every((c) => c.ordem.includes("id"))).toBe(true);
  });

  it("erro do banco na descoberta das colunas rejeita antes de qualquer byte", async () => {
    await expect(preparar({ crm_leads: [lead(1)] }, {}, { falharEm: "crm_leads" })).rejects.toThrow("banco caiu");
  });
});

describe("exportação de leads — intervalo de última compra (de/ate), I2", () => {
  const contato = (nome: string) => ({ ...CONTATO_MARIA, display_name: nome });

  it("só saem os negócios dos contatos que a regra da tela de Leads deixa no intervalo", async () => {
    const { db } = bancoFalso({
      ...BASE,
      crm_leads: [
        lead(1, { contact_id: "ct1", contacts: contato("Ana"), custom_fields: { so_da_ana: "x" } }),
        lead(2, { contact_id: "ct2", contacts: contato("Bruno"), custom_fields: { so_do_bruno: "y" } }),
        lead(3, { contact_id: null, contacts: null, title: "Sem contato" }),
      ],
    });
    const chamadas: Array<[string, unknown]> = [];
    const noIntervalo = async (org: string, filtros: unknown) => {
      chamadas.push([org, filtros]);
      return new Set(["ct2"]);
    };
    const prep = await prepararExportacaoDeLeads(db, ORG, { de: "2026-03-01", ate: "2026-03-31" }, t, donos, noIntervalo);
    const linhas = await tudo(prep);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]![0]).toBe("Bruno");
    // A coluna de campo personalizado de quem ficou de fora nem nasce.
    expect(prep.cabecalho).toContain("so_do_bruno");
    expect(prep.cabecalho).not.toContain("so_da_ana");
    expect(chamadas).toEqual([[ORG, { de: "2026-03-01", ate: "2026-03-31" }]]);
  });

  it("repassa busca, etiqueta e funil junto com o intervalo, e não consulta nada sem de/ate", async () => {
    const { db } = bancoFalso({ ...BASE, crm_leads: [lead(1)] });
    const chamadas: unknown[] = [];
    const noIntervalo = async (_org: string, filtros: unknown) => {
      chamadas.push(filtros);
      return new Set(["ct1"]);
    };
    await prepararExportacaoDeLeads(db, ORG, { busca: "maria", tag: "vip", pipeline: FUNIL, ate: "2026-03-31" }, t, donos, noIntervalo);
    expect(chamadas).toEqual([{ busca: "maria", tag: "vip", pipeline: FUNIL, ate: "2026-03-31" }]);

    chamadas.length = 0;
    const prep = await prepararExportacaoDeLeads(db, ORG, { pipeline: FUNIL }, t, donos, noIntervalo);
    expect(chamadas).toEqual([]);
    expect(await tudo(prep)).toHaveLength(1);
  });

  it("MAIS de 1.000 negócios no intervalo continuam saindo paginados e inteiros", async () => {
    const { db } = bancoFalso({ ...BASE, crm_leads: Array.from({ length: 2100 }, (_, i) => lead(i + 1)) });
    const prep = await prepararExportacaoDeLeads(db, ORG, { de: "2026-01-01" }, t, donos, async () => new Set(["ct1"]));
    expect(await tudo(prep)).toHaveLength(2100);
  });
});
