import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * REGISTRAR VENDA (migration 0251): `fn_registrar_venda` é UMA transação — negócio aberto (ou novo) + linhas de produto +
 * ganho na data informada — e roda com a RLS de quem chama.
 *
 * Mesmo caminho da produção: `set role authenticated` + `request.jwt.claims` (conectar como `postgres` não mede RLS).
 * Esta suíte precisa de Postgres real; roda via `pnpm test:db` (scripts/test-db.sh).
 *
 * Cobre: venda sem negócio aberto, com negócio aberto e recompra; valor editado por linha; data passada e futura;
 * idempotência (tabela de chaves, também ao reabrir o negócio); alvo previsto; falha no meio sem venda pela metade;
 * isolamento entre organizações; papel de leitura; produto interno; sigilo ao mover item; nenhum envio nem agendamento.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function comoUsuario(userId: string, corpo: string): string {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${corpo}
  `);
  return out.split("\n").at(-1) ?? "";
}

function falhaComo(userId: string, corpo: string): string {
  try {
    comoUsuario(userId, corpo);
    return "";
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? e);
  }
}

const ORG_A = "c1c1e1e1-0000-4000-8000-00000000000a";
const ORG_B = "c1c1e1e1-0000-4000-8000-00000000000b";
const AGENT_A = "c1c1e1e1-1111-4000-8000-00000000000a";
const VIEWER_A = "c1c1e1e1-1111-4000-8000-00000000000c";
const AGENT_B = "c1c1e1e1-1111-4000-8000-00000000000b";
const PIPE_A = "c1c1e1e1-2222-4000-8000-00000000000a";
const PIPE_B = "c1c1e1e1-2222-4000-8000-00000000000b";
const NOVO_A = "c1c1e1e1-3333-4000-8000-00000000000a";
const GANHO_A = "c1c1e1e1-3333-4000-8000-00000000001a";
const NOVO_B = "c1c1e1e1-3333-4000-8000-00000000000b";
const GANHO_B = "c1c1e1e1-3333-4000-8000-00000000001b";
const PROD_INTERNO = "c1c1e1e1-5555-4000-8000-00000000000a";
const PROD_LOJA = "c1c1e1e1-5555-4000-8000-00000000000c";
const PROD_B = "c1c1e1e1-5555-4000-8000-00000000000b";
const C_SEM_NEGOCIO = "c1c1e1e1-6666-4000-8000-000000000001";
const C_COM_NEGOCIO = "c1c1e1e1-6666-4000-8000-000000000002";
const C_RECOMPRA = "c1c1e1e1-6666-4000-8000-000000000003";
const C_ATOMICO = "c1c1e1e1-6666-4000-8000-000000000004";
const C_IDEM = "c1c1e1e1-6666-4000-8000-000000000005";
const C_DATAS = "c1c1e1e1-6666-4000-8000-000000000006";
const C_B = "c1c1e1e1-6666-4000-8000-00000000000b";
const LEAD_ABERTO = "c1c1e1e1-4444-4000-8000-000000000002";
const LEAD_ATOMICO = "c1c1e1e1-4444-4000-8000-000000000004";
const LEAD_GANHO_ANTIGO = "c1c1e1e1-4444-4000-8000-000000000003";
const LEAD_B = "c1c1e1e1-4444-4000-8000-00000000000b";

/** Chama a função como o usuário e devolve o jsonb como objeto. */
function vender(userId: string, org: string, contato: string | null, lead: string | null, quando: string, itens: unknown[], chave: string | null, previsto: string | null = null) {
  const arg = (v: string | null) => (v === null ? "null" : `'${v}'`);
  const json = comoUsuario(
    userId,
    `select public.fn_registrar_venda(${arg(org)}, ${arg(contato)}, ${arg(lead)}, ${quando}, '${JSON.stringify(itens)}'::jsonb, ${arg(chave)}, ${arg(previsto)})::text;`,
  );
  return JSON.parse(json) as Record<string, unknown>;
}

const linha = (produto: string, preco: number, extra: Record<string, unknown> = {}) => ({ product_id: produto, quantidade: 1, preco_unit_cents: preco, desconto_cents: 0, ...extra });
const contar = (tabela: string, where: string) => Number(sql(`select count(*) from public.${tabela} where ${where};`));

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'venda-agent-a@invariant.test'),
      ('${VIEWER_A}', 'venda-viewer-a@invariant.test'),
      ('${AGENT_B}', 'venda-agent-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'venda-inv-a', 'Venda Invariant A', 'Venda A'),
      ('${ORG_B}', 'venda-inv-b', 'Venda Invariant B', 'Venda B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG_A}', 'agent', now()),
      ('${VIEWER_A}', '${ORG_A}', 'viewer', now()),
      ('${AGENT_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    -- Criar a organização semeia um funil padrão: sai de cena (arquivado, não padrão) para o funil do teste ser o padrão.
    update public.crm_pipelines set is_default = false, is_archived = true where organization_id in ('${ORG_A}', '${ORG_B}') and id not in ('${PIPE_A}', '${PIPE_B}');
    -- position -1: o funil do teste vem antes de qualquer funil semeado junto da organização.
    insert into public.crm_pipelines (id, organization_id, name, slug, is_default, position) values
      ('${PIPE_A}', '${ORG_A}', 'Funil A', 'venda-pipe-a', true, -1), ('${PIPE_B}', '${ORG_B}', 'Funil B', 'venda-pipe-b', true, -1)
      on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won) values
      ('${NOVO_A}', '${ORG_A}', '${PIPE_A}', 'Novo', 'novo', 1, false),
      ('${GANHO_A}', '${ORG_A}', '${PIPE_A}', 'Ganho', 'ganho', 9, true),
      ('${NOVO_B}', '${ORG_B}', '${PIPE_B}', 'Novo', 'novo', 1, false),
      ('${GANHO_B}', '${ORG_B}', '${PIPE_B}', 'Ganho', 'ganho', 9, true)
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name) values
      ('${C_SEM_NEGOCIO}', '${ORG_A}', 'Sem Negocio'), ('${C_COM_NEGOCIO}', '${ORG_A}', 'Com Negocio'),
      ('${C_RECOMPRA}', '${ORG_A}', 'Recompra'), ('${C_ATOMICO}', '${ORG_A}', 'Atomico'),
      ('${C_IDEM}', '${ORG_A}', 'Idem'), ('${C_DATAS}', '${ORG_A}', 'Datas'), ('${C_B}', '${ORG_B}', 'Contato B')
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, currency) values
      ('${LEAD_ABERTO}', '${ORG_A}', '${PIPE_A}', '${NOVO_A}', '${C_COM_NEGOCIO}', 'Negocio aberto', 'BRL'),
      ('${LEAD_ATOMICO}', '${ORG_A}', '${PIPE_A}', '${NOVO_A}', '${C_ATOMICO}', 'Negocio atomico', 'BRL'),
      ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${NOVO_B}', '${C_B}', 'Negocio B', 'BRL')
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, currency, status, closed_at) values
      ('${LEAD_GANHO_ANTIGO}', '${ORG_A}', '${PIPE_A}', '${GANHO_A}', '${C_RECOMPRA}', 'Compra antiga', 'BRL', 'won', now() - interval '30 days')
      on conflict (id) do nothing;
    insert into public.catalog_products (id, organization_id, codigo, nome, marca, preco_cents, so_interno, controla_estoque) values
      ('${PROD_INTERNO}', '${ORG_A}', 'VENDA-INT', '1 MES (PLANO)', 'Plano', 12000, true, false),
      ('${PROD_LOJA}', '${ORG_A}', 'VENDA-LOJA', 'Produto da loja', 'Loja', 5000, false, false),
      ('${PROD_B}', '${ORG_B}', 'VENDA-B', 'Produto B', 'B', 7000, true, false)
      on conflict (id) do nothing;
  `);
});

describe("produto interno — coluna", () => {
  it("so_interno existe, é not null e o default é falso (nada que já existe vira interno)", () => {
    expect(sql(`select is_nullable || '/' || column_default from information_schema.columns where table_name = 'catalog_products' and column_name = 'so_interno';`)).toBe("NO/false");
    expect(sql(`select so_interno from public.catalog_products where id = '${PROD_LOJA}';`)).toBe("f");
  });

  it("a consulta do MCP (so_interno = false) não enxerga o plano interno nem o preço dele", () => {
    expect(contar("catalog_products", `organization_id = '${ORG_A}' and ativo and so_interno = false and id = '${PROD_INTERNO}'`)).toBe(0);
    expect(contar("catalog_products", `organization_id = '${ORG_A}' and ativo and so_interno = false and id = '${PROD_LOJA}'`)).toBe(1);
  });
});

describe("registrar venda — negócio", () => {
  it("sem negócio aberto: abre um no funil padrão, grava a linha com o valor EDITADO e ganha", () => {
    const r = vender(AGENT_A, ORG_A, C_SEM_NEGOCIO, null, "now()", [linha(PROD_INTERNO, 9990)], null);
    expect(r).toMatchObject({ criado: true, ja_registrada: false, total_cents: 9990 });
    const lead = String(r.lead_id);
    expect(sql(`select status || '/' || pipeline_id || '/' || value_cents || '/' || owner_user_id from public.crm_leads where id = '${lead}';`)).toBe(`won/${PIPE_A}/9990/${AGENT_A}`);
    expect(sql(`select organization_id from public.crm_leads where id = '${lead}';`)).toBe(ORG_A);
    // o preço da linha é o do corpo (9990), não o do cadastro (12000); nome e sku são snapshot do cadastro
    expect(sql(`select preco_unit_cents || '/' || nome || '/' || sku || '/' || total_cents from public.crm_lead_items where lead_id = '${lead}';`)).toBe("9990/1 MES (PLANO)/VENDA-INT/9990");
  });

  it("com negócio aberto: usa o MESMO negócio (não cria outro) e ele vira ganho", () => {
    const antes = contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C_COM_NEGOCIO}'`);
    const r = vender(AGENT_A, ORG_A, C_COM_NEGOCIO, null, "now()", [linha(PROD_INTERNO, 12000), linha(PROD_LOJA, 5000, { quantidade: 2, desconto_cents: 1000 })], null);
    expect(r).toMatchObject({ criado: false, lead_id: LEAD_ABERTO, total_cents: 12000 + 2 * 5000 - 1000 });
    expect(contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C_COM_NEGOCIO}'`)).toBe(antes);
    expect(sql(`select status from public.crm_leads where id = '${LEAD_ABERTO}';`)).toBe("won");
    expect(contar("crm_lead_items", `lead_id = '${LEAD_ABERTO}'`)).toBe(2);
  });

  it("recompra: quem já comprou e não tem negócio aberto ganha um negócio NOVO (o antigo não é tocado)", () => {
    const r = vender(AGENT_A, ORG_A, C_RECOMPRA, null, "now()", [linha(PROD_INTERNO, 12000)], null);
    expect(r).toMatchObject({ criado: true });
    expect(r.lead_id).not.toBe(LEAD_GANHO_ANTIGO);
    expect(contar("crm_leads", `contact_id = '${C_RECOMPRA}' and status = 'won'`)).toBe(2);
    expect(contar("crm_lead_items", `lead_id = '${LEAD_GANHO_ANTIGO}'`)).toBe(0);
  });

  it("a venda deixa o evento lead.won (e lead.created quando abriu negócio) no event_log, na mesma transação", () => {
    const r = vender(AGENT_A, ORG_A, C_DATAS, null, "now()", [linha(PROD_LOJA, 100)], null);
    expect(contar("event_log", `organization_id = '${ORG_A}' and event_type = 'lead.won' and entity_id = '${r.lead_id}'`)).toBeGreaterThanOrEqual(1);
    expect(contar("event_log", `organization_id = '${ORG_A}' and event_type = 'lead.created' and entity_id = '${r.lead_id}'`)).toBe(1);
  });
});

describe("registrar venda — data", () => {
  it("data passada vale: closed_at é a data informada (é o dia em que o Faturamento conta)", () => {
    const r = vender(AGENT_A, ORG_A, C_DATAS, null, "now() - interval '3 days'", [linha(PROD_LOJA, 100)], null);
    expect(Number(sql(`select extract(epoch from now() - closed_at)::int / 86400 from public.crm_leads where id = '${r.lead_id}';`))).toBe(3);
  });

  it("data futura é recusada e não grava nada", () => {
    const antes = contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C_DATAS}'`);
    expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', '${C_DATAS}', null, now() + interval '2 days', '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, null);`)).toMatch(/venda:data_futura/);
    expect(contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C_DATAS}'`)).toBe(antes);
  });
});

describe("registrar venda — idempotência", () => {
  it("a mesma chave devolve a mesma venda e NÃO duplica negócio nem itens", () => {
    const itens = [linha(PROD_INTERNO, 12000)];
    const a = vender(AGENT_A, ORG_A, C_IDEM, null, "now()", itens, "clique-duplo-1");
    const b = vender(AGENT_A, ORG_A, C_IDEM, null, "now()", itens, "clique-duplo-1");
    expect(a).toMatchObject({ ja_registrada: false });
    expect(b).toMatchObject({ ja_registrada: true, lead_id: a.lead_id });
    expect(contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C_IDEM}'`)).toBe(1);
    expect(contar("crm_lead_items", `lead_id = '${a.lead_id}'`)).toBe(1);
  });

  it("a chave é única por organização (chave primária da tabela de chaves) e não colide entre organizações", () => {
    expect(sql(`select count(*) from pg_constraint where conrelid = 'public.crm_venda_chaves'::regclass and contype = 'p';`)).toBe("1");
    expect(sql(`select count(*) from information_schema.columns where table_name = 'crm_leads' and column_name = 'registro_venda_key';`)).toBe("0");
    const b = vender(AGENT_B, ORG_B, C_B, null, "now()", [linha(PROD_B, 7000)], "clique-duplo-1");
    expect(b).toMatchObject({ ja_registrada: false, lead_id: LEAD_B });
  });
});

describe("registrar venda — idempotência ao reabrir o negócio", () => {
  const C = "c1c1e1e1-6666-4000-8000-0000000000d2";

  it("vende (K1), reabre, vende de novo (K2): retentar K1 devolve a venda de K1 e NÃO duplica nada", () => {
    sql(`insert into public.contacts (id, organization_id, name) values ('${C}', '${ORG_A}', 'Reabre') on conflict (id) do nothing;`);
    const k1 = vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 1000)], "reabre-k1");
    expect(k1).toMatchObject({ ja_registrada: false, criado: true });
    const lead = String(k1.lead_id);
    // reabrir: o negócio volta para uma etapa aberta (o gatilho de etapa devolve o status a open)
    sql(`update public.crm_leads set stage_id = '${NOVO_A}' where id = '${lead}';`);
    expect(sql(`select status from public.crm_leads where id = '${lead}';`)).toBe("open");

    const k2 = vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 2000)], "reabre-k2");
    expect(k2).toMatchObject({ ja_registrada: false, criado: false, lead_id: lead });
    expect(contar("crm_lead_items", `lead_id = '${lead}'`)).toBe(2);

    // as DUAS chaves seguem registradas (a segunda não substituiu a primeira)
    expect(contar("crm_venda_chaves", `organization_id = '${ORG_A}' and lead_id = '${lead}' and chave in ('reabre-k1', 'reabre-k2')`)).toBe(2);

    const retentativa = vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 1000)], "reabre-k1");
    expect(retentativa).toMatchObject({ ja_registrada: true, lead_id: lead });
    expect(contar("crm_lead_items", `lead_id = '${lead}'`)).toBe(2);
    expect(contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C}'`)).toBe(1);
    // e K2 também continua devolvendo a mesma venda
    expect(vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 2000)], "reabre-k2")).toMatchObject({ ja_registrada: true, lead_id: lead });
  });
});

describe("crm_venda_chaves — RLS e imutabilidade", () => {
  it("tem RLS ligada e a coluna antiga não existe mais", () => {
    expect(sql("select relrowsecurity from pg_class where oid = 'public.crm_venda_chaves'::regclass;")).toBe("t");
  });

  it("a org B não lê as chaves da A (e a A lê as suas)", () => {
    vender(AGENT_A, ORG_A, C_SEM_NEGOCIO, null, "now()", [linha(PROD_LOJA, 100)], "rls-chave-1");
    expect(comoUsuario(AGENT_B, `select count(*) from public.crm_venda_chaves where organization_id = '${ORG_A}';`)).toBe("0");
    expect(Number(comoUsuario(AGENT_A, `select count(*) from public.crm_venda_chaves where organization_id = '${ORG_A}' and chave = 'rls-chave-1';`))).toBe(1);
  });

  it("viewer não grava chave; ninguém altera nem apaga uma chave (sem policy de update/delete)", () => {
    const lead = sql(`select lead_id from public.crm_venda_chaves where chave = 'rls-chave-1' and organization_id = '${ORG_A}';`);
    expect(falhaComo(VIEWER_A, `insert into public.crm_venda_chaves (organization_id, chave, lead_id) values ('${ORG_A}', 'viewer-1', '${lead}');`)).toMatch(/row-level security|violates/i);
    expect(comoUsuario(AGENT_A, `with u as (update public.crm_venda_chaves set chave = 'trocada' where organization_id = '${ORG_A}' returning 1) select count(*) from u;`)).toBe("0");
    expect(comoUsuario(AGENT_A, `with d as (delete from public.crm_venda_chaves where organization_id = '${ORG_A}' returning 1) select count(*) from d;`)).toBe("0");
    expect(contar("crm_venda_chaves", `organization_id = '${ORG_A}' and chave = 'rls-chave-1'`)).toBe(1);
  });

  it("agent da org A não grava chave apontando para negócio da org B", () => {
    expect(falhaComo(AGENT_A, `insert into public.crm_venda_chaves (organization_id, chave, lead_id) values ('${ORG_A}', 'cruzada-1', '${LEAD_B}');`)).not.toBe("");
    expect(contar("crm_venda_chaves", `chave = 'cruzada-1'`)).toBe(0);
  });
});

describe("registrar venda — o negócio mostrado é o que ganha (alvo previsto)", () => {
  const novoContato = (id: string, nome: string) => sql(`insert into public.contacts (id, organization_id, name) values ('${id}', '${ORG_A}', '${nome}') on conflict (id) do nothing;`);
  const novoNegocioAberto = (id: string, contato: string) =>
    sql(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, currency) values ('${id}', '${ORG_A}', '${PIPE_A}', '${NOVO_A}', '${contato}', 'Alvo', 'BRL') on conflict (id) do nothing;`);

  it("o negócio previsto ainda é o alvo: a venda segue normalmente", () => {
    const C = "c1c1e1e1-6666-4000-8000-0000000000e1";
    const L = "c1c1e1e1-4444-4000-8000-0000000000e2";
    novoContato(C, "Previsto ok");
    novoNegocioAberto(L, C);
    expect(vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 100)], null, L)).toMatchObject({ lead_id: L, criado: false });
  });

  it("o negócio mostrado foi encerrado por outro operador: recusa com venda:alvo_mudou e NADA é gravado (não cai em outro, não abre novo)", () => {
    const C = "c1c1e1e1-6666-4000-8000-0000000000e3";
    const L = "c1c1e1e1-4444-4000-8000-0000000000e4";
    novoContato(C, "Alvo mudou");
    novoNegocioAberto(L, C);
    sql(`update public.crm_leads set stage_id = '${GANHO_A}' where id = '${L}';`); // outro operador ganhou o negócio
    const leads = contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C}'`);
    const itens = contar("crm_lead_items", `organization_id = '${ORG_A}'`);
    const erro = falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', '${C}', null, now(), '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, 'alvo-mudou-1', '${L}');`);
    expect(erro).toMatch(/venda:alvo_mudou/);
    expect(contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C}'`)).toBe(leads);
    expect(contar("crm_lead_items", `organization_id = '${ORG_A}'`)).toBe(itens);
    expect(contar("crm_venda_chaves", `chave = 'alvo-mudou-1'`)).toBe(0);
  });

  it("o quadro previu \"novo\" e apareceu um negócio aberto: recusa; previu \"novo\" e não há nenhum: abre o novo", () => {
    const C = "c1c1e1e1-6666-4000-8000-0000000000e5";
    novoContato(C, "Previu novo");
    expect(vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 100)], null, "novo")).toMatchObject({ criado: true });
    const C2 = "c1c1e1e1-6666-4000-8000-0000000000e6";
    novoContato(C2, "Previu novo 2");
    novoNegocioAberto("c1c1e1e1-4444-4000-8000-0000000000e7", C2);
    expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', '${C2}', null, now(), '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, null, 'novo');`)).toMatch(/venda:alvo_mudou/);
  });

  it("previsão que não é id nem \"novo\" é entrada inválida; sem previsão (null) não há conferência", () => {
    const C = "c1c1e1e1-6666-4000-8000-0000000000e8";
    novoContato(C, "Sem previsao");
    expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', '${C}', null, now(), '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, null, 'qualquer-coisa');`)).toMatch(/venda:entrada_invalida/);
    expect(vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 100)], null)).toMatchObject({ ja_registrada: false });
  });

  it("repetir a chave devolve a venda mesmo que o alvo previsto tenha deixado de valer (a retentativa não é recusada)", () => {
    const C = "c1c1e1e1-6666-4000-8000-0000000000e9";
    novoContato(C, "Retentativa");
    const a = vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 100)], "retentativa-1", "novo");
    const b = vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 100)], "retentativa-1", "novo");
    expect(b).toMatchObject({ ja_registrada: true, lead_id: a.lead_id });
  });
});

describe("registrar venda — não fala com o lead e não arma nada que fale", () => {
  it("o negócio novo emite lead.created MARCADO com a origem (o motor de automações o reconhece) e nenhum lead.stage_changed", () => {
    const C = "c1c1e1e1-6666-4000-8000-0000000000f5";
    sql(`insert into public.contacts (id, organization_id, name) values ('${C}', '${ORG_A}', 'Sem envio') on conflict (id) do nothing;`);
    const r = vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_INTERNO, 12000)], null);
    const lead = String(r.lead_id);
    expect(sql(`select metadata->>'origem' from public.event_log where organization_id = '${ORG_A}' and event_type = 'lead.created' and entity_id = '${lead}';`)).toBe("registrar_venda");
    // sem mudança de etapa emitida: o gatilho de etapa do follow-up e as regras de "mudou de etapa" não têm o que consumir
    expect(contar("event_log", `organization_id = '${ORG_A}' and event_type = 'lead.stage_changed' and (entity_id = '${lead}' or payload->>'lead_id' = '${lead}')`)).toBe(0);
    // os únicos eventos da venda são os de criação e ganho (e o ganho não leva o valor, testado acima)
    expect(sql(`select string_agg(distinct event_type, ',' order by event_type) from public.event_log where organization_id = '${ORG_A}' and (entity_id = '${lead}' or payload->>'lead_id' = '${lead}');`)).toBe("lead.created,lead.won");
  });

  it("a venda não grava mensagem, envio de disparo, inscrição de follow-up nem job na fila para o contato", () => {
    const C = "c1c1e1e1-6666-4000-8000-0000000000f6";
    sql(`insert into public.contacts (id, organization_id, name) values ('${C}', '${ORG_A}', 'Sem envio 2') on conflict (id) do nothing;`);
    const medir = () => [
      contar("messages", `organization_id = '${ORG_A}' and contact_id = '${C}'`),
      contar("job_queue", `organization_id = '${ORG_A}' and contact_id = '${C}'`),
      contar("followup_enrollments", `organization_id = '${ORG_A}' and contact_id = '${C}'`),
      contar("disparo_envios", `organization_id = '${ORG_A}' and lead_id in (select id from public.crm_leads where contact_id = '${C}')`),
    ];
    const antes = medir();
    vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_INTERNO, 12000), linha(PROD_LOJA, 500)], "sem-envio-1");
    expect(medir()).toEqual(antes);
  });
});

describe("registrar venda — falha no meio não deixa venda pela metade", () => {
  it("segunda linha com produto inexistente: nada é gravado, o negócio segue aberto e sem itens", () => {
    const inexistente = "c1c1e1e1-5555-4000-8000-0000000000ee";
    const msg = falhaComo(
      AGENT_A,
      `select public.fn_registrar_venda('${ORG_A}', '${C_ATOMICO}', null, now(), '[${JSON.stringify(linha(PROD_INTERNO, 12000))},${JSON.stringify(linha(inexistente, 100))}]'::jsonb, 'atomico-1');`,
    );
    expect(msg).toMatch(/venda:produto_nao_encontrado/);
    expect(sql(`select status from public.crm_leads where id = '${LEAD_ATOMICO}';`)).toBe("open");
    expect(contar("crm_lead_items", `lead_id = '${LEAD_ATOMICO}'`)).toBe(0);
    expect(contar("crm_venda_chaves", `chave = 'atomico-1'`)).toBe(0);
    expect(contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C_ATOMICO}'`)).toBe(1);
  });

  it("funil sem etapa de ganho: recusa e desfaz o negócio recém-criado e as linhas", () => {
    const pipeSemGanho = "c1c1e1e1-2222-4000-8000-0000000000f1";
    const etapa = "c1c1e1e1-3333-4000-8000-0000000000f1";
    const contato = "c1c1e1e1-6666-4000-8000-0000000000f1";
    sql(`
      insert into public.crm_pipelines (id, organization_id, name, slug, is_default) values ('${pipeSemGanho}', '${ORG_B}', 'Sem ganho', 'venda-sem-ganho', false) on conflict (id) do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won) values ('${etapa}', '${ORG_B}', '${pipeSemGanho}', 'Novo', 'novo', 1, false) on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, name) values ('${contato}', '${ORG_B}', 'Sem Ganho') on conflict (id) do nothing;
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title) values ('c1c1e1e1-4444-4000-8000-0000000000f1', '${ORG_B}', '${pipeSemGanho}', '${etapa}', '${contato}', 'aberto sem ganho') on conflict (id) do nothing;
    `);
    const msg = falhaComo(AGENT_B, `select public.fn_registrar_venda('${ORG_B}', '${contato}', null, now(), '[${JSON.stringify(linha(PROD_B, 7000))}]'::jsonb, null);`);
    expect(msg).toMatch(/venda:pipeline_no_won_stage/);
    expect(contar("crm_lead_items", `lead_id = 'c1c1e1e1-4444-4000-8000-0000000000f1'`)).toBe(0);
    expect(sql(`select status from public.crm_leads where id = 'c1c1e1e1-4444-4000-8000-0000000000f1';`)).toBe("open");
  });
});

describe("registrar venda — isolamento e papel", () => {
  it("a org A não registra venda em contato da org B", () => {
    expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', '${C_B}', null, now(), '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, null);`)).toMatch(/venda:contato_nao_encontrado/);
  });

  it("a org A não usa a organização B como alvo, nem com contato da B", () => {
    const antes = contar("crm_lead_items", `organization_id = '${ORG_B}'`);
    expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_B}', '${C_B}', null, now(), '[${JSON.stringify(linha(PROD_B, 100))}]'::jsonb, 'invasao-1');`)).not.toBe("");
    expect(contar("crm_lead_items", `organization_id = '${ORG_B}'`)).toBe(antes);
    expect(contar("crm_venda_chaves", `chave = 'invasao-1'`)).toBe(0);
  });

  it("a org A não usa produto da org B na linha", () => {
    expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', '${C_SEM_NEGOCIO}', null, now(), '[${JSON.stringify(linha(PROD_B, 100))}]'::jsonb, null);`)).toMatch(/venda:produto_nao_encontrado/);
  });

  it("a org A não ganha negócio da org B passando o id dele", () => {
    const antes = contar("crm_lead_items", `lead_id = '${LEAD_B}'`);
    expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', null, '${LEAD_B}', now(), '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, null);`)).toMatch(/venda:negocio_nao_encontrado/);
    expect(contar("crm_lead_items", `lead_id = '${LEAD_B}'`)).toBe(antes);
  });

  it("viewer não registra venda (RLS) e nada fica gravado", () => {
    const antes = contar("crm_leads", `organization_id = '${ORG_A}'`);
    expect(falhaComo(VIEWER_A, `select public.fn_registrar_venda('${ORG_A}', '${C_SEM_NEGOCIO}', null, now(), '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, null);`)).toMatch(/row-level security|violates/i);
    expect(contar("crm_leads", `organization_id = '${ORG_A}'`)).toBe(antes);
  });

  it("anon não executa a função (revogada de public e anon)", () => {
    expect(sql(`select has_function_privilege('anon', 'public.fn_registrar_venda(uuid, uuid, uuid, timestamptz, jsonb, text, text)', 'EXECUTE');`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated', 'public.fn_registrar_venda(uuid, uuid, uuid, timestamptz, jsonb, text, text)', 'EXECUTE');`)).toBe("t");
  });
});

const MIGRATION_0251 = readFileSync(join(process.cwd(), "supabase/migrations/20261108100000_0251_produto_interno_e_registrar_venda.sql"), "utf8");

describe("valor sigiloso — a marca é do banco e é pegajosa", () => {
  const sigiloso = (lead: string) => sql(`select valor_sigiloso from public.crm_leads where id = '${lead}';`);
  const novoNegocio = (id: string, contato: string) =>
    sql(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, currency)
         values ('${id}', '${ORG_A}', '${PIPE_A}', '${NOVO_A}', '${contato}', 'Sigilo ${id.slice(-4)}', 'BRL') on conflict (id) do nothing;`);

  it("a coluna existe, é not null e o default é falso: negócio comum nasce público", () => {
    expect(sql(`select is_nullable || '/' || column_default from information_schema.columns where table_name = 'crm_leads' and column_name = 'valor_sigiloso';`)).toBe("NO/false");
    novoNegocio("c1c1e1e1-4444-4000-8000-0000000000a0", C_SEM_NEGOCIO);
    expect(sigiloso("c1c1e1e1-4444-4000-8000-0000000000a0")).toBe("f");
  });

  it("toda venda registrada marca o negócio, inclusive a que tem só item AVULSO (sem chave de idempotência)", () => {
    const r = vender(AGENT_A, ORG_A, C_DATAS, null, "now()", [{ nome: "Brinde avulso", quantidade: 1, preco_unit_cents: 500, desconto_cents: 0 }], null);
    expect(sigiloso(String(r.lead_id))).toBe("t");
    expect(contar("crm_venda_chaves", `lead_id = '${r.lead_id}'`)).toBe(0);
  });

  it("o evento lead.won de uma venda registrada NÃO leva value_cents (o event_log alimenta webhooks de saída)", () => {
    const r = vender(AGENT_A, ORG_A, C_DATAS, null, "now()", [linha(PROD_LOJA, 7777)], null);
    expect(sql(`select payload ? 'value_cents' from public.event_log where organization_id = '${ORG_A}' and event_type = 'lead.won' and entity_id = '${r.lead_id}' order by created_at desc limit 1;`)).toBe("f");
    expect(sql(`select count(*) from public.event_log where event_type = 'lead.won' and entity_id = '${r.lead_id}' and payload::text like '%7777%';`)).toBe("0");
  });

  it("item de produto INTERNO adicionado pela aba Produtos (insert direto, sem a venda) marca o negócio; item da loja não", () => {
    const A = "c1c1e1e1-4444-4000-8000-0000000000a1";
    const B = "c1c1e1e1-4444-4000-8000-0000000000b1";
    novoNegocio(A, C_SEM_NEGOCIO);
    novoNegocio(B, C_SEM_NEGOCIO);
    comoUsuario(AGENT_A, `insert into public.crm_lead_items (organization_id, lead_id, product_id, nome, preco_unit_cents) values ('${ORG_A}', '${B}', '${PROD_LOJA}', 'Loja', 5000);`);
    expect(sigiloso(B)).toBe("f");
    comoUsuario(AGENT_A, `insert into public.crm_lead_items (organization_id, lead_id, product_id, nome, preco_unit_cents) values ('${ORG_A}', '${A}', '${PROD_INTERNO}', 'Plano', 12000);`);
    expect(sigiloso(A)).toBe("t");
  });

  it("trocar a linha para um produto interno também marca", () => {
    const L = "c1c1e1e1-4444-4000-8000-0000000000c1";
    novoNegocio(L, C_SEM_NEGOCIO);
    comoUsuario(AGENT_A, `insert into public.crm_lead_items (id, organization_id, lead_id, product_id, nome, preco_unit_cents) values ('c1c1e1e1-6666-4000-8000-0000000000c1', '${ORG_A}', '${L}', '${PROD_LOJA}', 'Loja', 5000);`);
    expect(sigiloso(L)).toBe("f");
    comoUsuario(AGENT_A, `update public.crm_lead_items set product_id = '${PROD_INTERNO}' where id = 'c1c1e1e1-6666-4000-8000-0000000000c1';`);
    expect(sigiloso(L)).toBe("t");
  });

  describe("linha que MUDA de negócio (update de lead_id) leva o sigilo junto", () => {
    const A1 = "c1c1e1e1-4444-4000-8000-0000000000b2";
    const A2 = "c1c1e1e1-4444-4000-8000-0000000000b3";
    const A3 = "c1c1e1e1-4444-4000-8000-0000000000b4";
    const A4 = "c1c1e1e1-4444-4000-8000-0000000000b5";
    const A5 = "c1c1e1e1-4444-4000-8000-0000000000b6";
    const I = (n: number) => `c1c1e1e1-6666-4000-8000-0000000000b${n}`;
    const mover = (item: string, destino: string) => comoUsuario(AGENT_A, `update public.crm_lead_items set lead_id = '${destino}' where id = '${item}';`);
    const inserir = (item: string, lead: string, produto: string | null) =>
      comoUsuario(AGENT_A, `insert into public.crm_lead_items (id, organization_id, lead_id, product_id, nome, preco_unit_cents) values ('${item}', '${ORG_A}', '${lead}', ${produto ? `'${produto}'` : "null"}, 'Linha', 7000);`);

    it("linha de produto INTERNO movida para outro negócio marca o destino (o valor dele passa a incluir a comissão)", () => {
      novoNegocio(A1, C_SEM_NEGOCIO);
      novoNegocio(A2, C_SEM_NEGOCIO);
      inserir(I(1), A1, PROD_INTERNO);
      expect([sigiloso(A1), sigiloso(A2)]).toEqual(["t", "f"]);
      mover(I(1), A2);
      expect(sigiloso(A2)).toBe("t");
      expect(sql(`select value_cents from public.crm_leads where id = '${A2}';`)).toBe("7000");
    });

    it("linha AVULSA vinda de um negócio sigiloso (item de venda registrada) também leva o sigilo ao destino", () => {
      novoNegocio(A3, C_SEM_NEGOCIO);
      novoNegocio(A4, C_SEM_NEGOCIO);
      sql(`update public.crm_leads set valor_sigiloso = true where id = '${A3}';`);
      inserir(I(2), A3, null);
      expect(sigiloso(A4)).toBe("f");
      mover(I(2), A4);
      expect(sigiloso(A4)).toBe("t");
    });

    it("controle: linha da LOJA, ou avulsa de negócio comum, movida entre negócios comuns NÃO marca ninguém", () => {
      novoNegocio(A5, C_SEM_NEGOCIO);
      const B1 = "c1c1e1e1-4444-4000-8000-0000000000b7";
      const B2 = "c1c1e1e1-4444-4000-8000-0000000000b8";
      novoNegocio(B1, C_SEM_NEGOCIO);
      novoNegocio(B2, C_SEM_NEGOCIO);
      inserir(I(3), B1, PROD_LOJA);
      inserir(I(4), B1, null);
      mover(I(3), A5);
      mover(I(4), B2);
      expect([sigiloso(A5), sigiloso(B1), sigiloso(B2)]).toEqual(["f", "f", "f"]);
    });

    it("o gatilho dispara em update de lead_id (e não só de product_id)", () => {
      expect(sql(`select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_crm_lead_items_sigilo' and tgrelid = 'public.crm_lead_items'::regclass;`)).toMatch(/UPDATE OF product_id, lead_id/);
    });
  });

  it("pegajosa: nem apagar a linha, nem apagar o produto, nem um update explícito devolvem o negócio a público", () => {
    const L = "c1c1e1e1-4444-4000-8000-0000000000d1";
    const PROD = "c1c1e1e1-5555-4000-8000-0000000000d1";
    sql(`insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents, so_interno, controla_estoque) values ('${PROD}', '${ORG_A}', 'VENDA-PEG', 'Plano pegajoso', 9000, true, false) on conflict (id) do nothing;`);
    novoNegocio(L, C_SEM_NEGOCIO);
    comoUsuario(AGENT_A, `insert into public.crm_lead_items (id, organization_id, lead_id, product_id, nome, preco_unit_cents) values ('c1c1e1e1-6666-4000-8000-0000000000d1', '${ORG_A}', '${L}', '${PROD}', 'Plano', 9000);`);
    expect(sigiloso(L)).toBe("t");
    comoUsuario(AGENT_A, `delete from public.crm_lead_items where id = 'c1c1e1e1-6666-4000-8000-0000000000d1';`);
    expect(sigiloso(L)).toBe("t");
    sql(`delete from public.catalog_products where id = '${PROD}';`);
    expect(sigiloso(L)).toBe("t");
    comoUsuario(AGENT_A, `update public.crm_leads set valor_sigiloso = false where id = '${L}';`);
    expect(sigiloso(L)).toBe("t");
    // e pelo dono do banco também: a marca não é uma opção do usuário
    sql(`update public.crm_leads set valor_sigiloso = false where id = '${L}';`);
    expect(sigiloso(L)).toBe("t");
  });

  it("produto que VIRA interno com linhas já gravadas marca os negócios dele", () => {
    const L = "c1c1e1e1-4444-4000-8000-0000000000e1";
    const PROD = "c1c1e1e1-5555-4000-8000-0000000000e1";
    sql(`insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents, so_interno, controla_estoque) values ('${PROD}', '${ORG_A}', 'VENDA-VIRA', 'Vira interno', 9000, false, false) on conflict (id) do nothing;`);
    novoNegocio(L, C_SEM_NEGOCIO);
    comoUsuario(AGENT_A, `insert into public.crm_lead_items (organization_id, lead_id, product_id, nome, preco_unit_cents) values ('${ORG_A}', '${L}', '${PROD}', 'Era da loja', 9000);`);
    expect(sigiloso(L)).toBe("f");
    sql(`update public.catalog_products set so_interno = true where id = '${PROD}';`);
    expect(sigiloso(L)).toBe("t");
  });

  it("backfill idempotente: reaplicar a migration marca quem já tinha linha interna ou chave de venda, e não mexe no resto", () => {
    const L = "c1c1e1e1-4444-4000-8000-0000000000f2";
    const K = "c1c1e1e1-4444-4000-8000-0000000000f3";
    const P = "c1c1e1e1-4444-4000-8000-0000000000f4";
    novoNegocio(L, C_SEM_NEGOCIO);
    novoNegocio(K, C_SEM_NEGOCIO);
    novoNegocio(P, C_SEM_NEGOCIO);
    // estado de ANTES da migration: linha interna e chave gravadas sem a marca (gatilhos desligados nesta sessão)
    sql(`set session_replication_role = replica;
         insert into public.crm_lead_items (organization_id, lead_id, product_id, nome, preco_unit_cents) values ('${ORG_A}', '${L}', '${PROD_INTERNO}', 'Antiga', 100);
         insert into public.crm_venda_chaves (organization_id, chave, lead_id) values ('${ORG_A}', 'legado-1', '${K}');
         reset session_replication_role;`);
    expect([sigiloso(L), sigiloso(K), sigiloso(P)]).toEqual(["f", "f", "f"]);
    sql(MIGRATION_0251);
    expect([sigiloso(L), sigiloso(K), sigiloso(P)]).toEqual(["t", "t", "f"]);
    // segunda reaplicação: nada muda
    sql(MIGRATION_0251);
    expect([sigiloso(L), sigiloso(K), sigiloso(P)]).toEqual(["t", "t", "f"]);
  });
});

describe("qual negócio a venda vai usar (a mesma regra para a prévia e para a operação)", () => {
  it("devolve o negócio aberto do contato, ou nulo quando não há (a venda abriria um novo)", () => {
    const L = "c1c1e1e1-4444-4000-8000-0000000000aa";
    const C = "c1c1e1e1-6666-4000-8000-0000000000aa";
    sql(`insert into public.contacts (id, organization_id, name) values ('${C}', '${ORG_A}', 'Previa') on conflict (id) do nothing;`);
    expect(comoUsuario(AGENT_A, `select coalesce(public.fn_escolher_negocio_da_venda('${ORG_A}', '${C}', null, false)::text, 'nulo');`)).toBe("nulo");
    sql(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title) values ('${L}', '${ORG_A}', '${PIPE_A}', '${NOVO_A}', '${C}', 'Previa') on conflict (id) do nothing;`);
    expect(comoUsuario(AGENT_A, `select public.fn_escolher_negocio_da_venda('${ORG_A}', '${C}', null, false)::text;`)).toBe(L);
    expect(comoUsuario(AGENT_A, `select public.fn_escolher_negocio_da_venda('${ORG_A}', null, '${L}', false)::text;`)).toBe(L);
    // a prévia é a MESMA escolha que a operação faz
    const r = vender(AGENT_A, ORG_A, C, null, "now()", [linha(PROD_LOJA, 100)], null);
    expect(r.lead_id).toBe(L);
    // ganho: some da escolha
    expect(comoUsuario(AGENT_A, `select coalesce(public.fn_escolher_negocio_da_venda('${ORG_A}', '${C}', null, false)::text, 'nulo');`)).toBe("nulo");
  });

  it("não enxerga negócio de outra organização", () => {
    expect(comoUsuario(AGENT_A, `select coalesce(public.fn_escolher_negocio_da_venda('${ORG_B}', '${C_B}', null, false)::text, 'nulo');`)).toBe("nulo");
  });
});

describe("data da venda — dia civil no fuso da organização, sem folga", () => {
  it("o último segundo do dia de hoje (no fuso da organização) vale; o primeiro do dia seguinte não", () => {
    const tz = sql(`select timezone from public.organizations where id = '${ORG_A}';`) || "America/Sao_Paulo";
    const inicioDeAmanha = `(((now() at time zone '${tz}')::date + 1)::timestamp at time zone '${tz}')`;
    const fimDeHoje = `${inicioDeAmanha} - interval '1 second'`;
    const C = "c1c1e1e1-6666-4000-8000-0000000000bb";
    sql(`insert into public.contacts (id, organization_id, name) values ('${C}', '${ORG_A}', 'Fuso') on conflict (id) do nothing;`);
    const antes = contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C}'`);
    expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', '${C}', null, ${inicioDeAmanha}, '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, null);`)).toMatch(/venda:data_futura/);
    expect(contar("crm_leads", `organization_id = '${ORG_A}' and contact_id = '${C}'`)).toBe(antes);
    const r = vender(AGENT_A, ORG_A, C, null, fimDeHoje, [linha(PROD_LOJA, 100)], null);
    expect(r).toMatchObject({ ja_registrada: false });
  });

  it("o fuso é o da ORGANIZAÇÃO, não o do servidor: em Kiritimati (UTC+14) o dia de lá já é o de amanhã para quem está em UTC", () => {
    const C = "c1c1e1e1-6666-4000-8000-0000000000bc";
    sql(`insert into public.contacts (id, organization_id, name) values ('${C}', '${ORG_A}', 'Fuso2') on conflict (id) do nothing;`);
    const tzAntes = sql(`select timezone from public.organizations where id = '${ORG_A}';`);
    try {
      sql(`update public.organizations set timezone = 'Pacific/Kiritimati' where id = '${ORG_A}';`);
      const inicioDeAmanhaLa = `(((now() at time zone 'Pacific/Kiritimati')::date + 1)::timestamp at time zone 'Pacific/Kiritimati')`;
      expect(falhaComo(AGENT_A, `select public.fn_registrar_venda('${ORG_A}', '${C}', null, ${inicioDeAmanhaLa}, '[${JSON.stringify(linha(PROD_LOJA, 100))}]'::jsonb, null);`)).toMatch(/venda:data_futura/);
      const fimDeHojeLa = `${inicioDeAmanhaLa} - interval '1 second'`;
      expect(vender(AGENT_A, ORG_A, C, null, fimDeHojeLa, [linha(PROD_LOJA, 100)], null)).toMatchObject({ ja_registrada: false });
    } finally {
      sql(`update public.organizations set timezone = '${tzAntes || "America/Sao_Paulo"}' where id = '${ORG_A}';`);
    }
  });
});
