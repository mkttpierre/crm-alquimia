import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * PRODUTOS NO NEGÓCIO (migration 0249): os itens não vazam entre organizações, herdam a visibilidade do negócio,
 * respeitam o papel, o total é gerado pelo banco e o valor do negócio acompanha a soma sem tocar o quadro à toa.
 *
 * Mesmo caminho da produção: `set role authenticated` + `request.jwt.claims` (conectar como `postgres` não mede RLS).
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

const ORG_A = "b0b0e1e1-0000-4000-8000-00000000000a";
const ORG_B = "b0b0e1e1-0000-4000-8000-00000000000b";
const AGENT_A = "b0b0e1e1-1111-4000-8000-00000000000a";
const VIEWER_A = "b0b0e1e1-1111-4000-8000-00000000000c";
const AGENT_B = "b0b0e1e1-1111-4000-8000-00000000000b";
const PIPE_A = "b0b0e1e1-2222-4000-8000-00000000000a";
const PIPE_B = "b0b0e1e1-2222-4000-8000-00000000000b";
const STAGE_A = "b0b0e1e1-3333-4000-8000-00000000000a";
const STAGE_B = "b0b0e1e1-3333-4000-8000-00000000000b";
const LEAD_A = "b0b0e1e1-4444-4000-8000-00000000000a";
const LEAD_B = "b0b0e1e1-4444-4000-8000-00000000000b";
const PROD_A = "b0b0e1e1-5555-4000-8000-00000000000a";
const PROD_B = "b0b0e1e1-5555-4000-8000-00000000000b";
const ITEM_A = "b0b0e1e1-6666-4000-8000-00000000000a";
const ITEM_B = "b0b0e1e1-6666-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'itens-agent-a@invariant.test'),
      ('${VIEWER_A}', 'itens-viewer-a@invariant.test'),
      ('${AGENT_B}', 'itens-agent-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'itens-inv-a', 'Itens Invariant A', 'Itens A'),
      ('${ORG_B}', 'itens-inv-b', 'Itens Invariant B', 'Itens B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG_A}', 'agent', now()),
      ('${VIEWER_A}', '${ORG_A}', 'viewer', now()),
      ('${AGENT_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE_A}', '${ORG_A}', 'Pipe A', 'itens-pipe-a'), ('${PIPE_B}', '${ORG_B}', 'Pipe B', 'itens-pipe-b') on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG_A}', '${PIPE_A}', 'Novo', 'novo', 1), ('${STAGE_B}', '${ORG_B}', '${PIPE_B}', 'Novo', 'novo', 1)
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, value_cents, currency) values
      ('${LEAD_A}', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'Negócio A', '${AGENT_A}', 1234, 'BRL'),
      ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${STAGE_B}', 'Negócio B', '${AGENT_B}', 0, 'BRL')
      on conflict (id) do nothing;
    insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents) values
      ('${PROD_A}', '${ORG_A}', 'INV-A', 'Produto A', 5000), ('${PROD_B}', '${ORG_B}', 'INV-B', 'Produto B', 7000)
      on conflict (id) do nothing;
    insert into public.crm_lead_items (id, organization_id, lead_id, product_id, nome, quantidade, preco_unit_cents) values
      ('${ITEM_B}', '${ORG_B}', '${LEAD_B}', '${PROD_B}', 'Produto B', 1, 7000)
      on conflict (id) do nothing;
  `);
});

describe("itens do negócio — RLS", () => {
  it("quem vê o negócio cria e lê o item (controle positivo)", () => {
    comoUsuario(
      AGENT_A,
      `insert into public.crm_lead_items (id, organization_id, lead_id, product_id, nome, quantidade, preco_unit_cents) values ('${ITEM_A}', '${ORG_A}', '${LEAD_A}', '${PROD_A}', 'Produto A', 2, 5000) on conflict (id) do nothing;`,
    );
    expect(Number(comoUsuario(AGENT_A, `select count(*) from public.crm_lead_items where id = '${ITEM_A}';`))).toBe(1);
  });

  it("a org A não lê item da org B", () => {
    expect(Number(comoUsuario(AGENT_A, `select count(*) from public.crm_lead_items where id = '${ITEM_B}';`))).toBe(0);
  });

  it("a org A não altera nem apaga item da org B", () => {
    expect(Number(comoUsuario(AGENT_A, `with u as (update public.crm_lead_items set nome = 'invadido' where id = '${ITEM_B}' returning 1) select count(*) from u;`))).toBe(0);
    expect(Number(comoUsuario(AGENT_A, `with d as (delete from public.crm_lead_items where id = '${ITEM_B}' returning 1) select count(*) from d;`))).toBe(0);
    expect(sql(`select nome from public.crm_lead_items where id = '${ITEM_B}';`)).toBe("Produto B");
  });

  it("a org A não grava item em negócio da org B, nem com organization_id da B", () => {
    expect(falhaComo(AGENT_A, `insert into public.crm_lead_items (organization_id, lead_id, nome, preco_unit_cents) values ('${ORG_B}', '${LEAD_B}', 'x', 1);`)).toMatch(/row-level security|violates/i);
    expect(falhaComo(AGENT_A, `insert into public.crm_lead_items (organization_id, lead_id, nome, preco_unit_cents) values ('${ORG_A}', '${LEAD_B}', 'x', 1);`)).toMatch(/foreign key|row-level security|violates/i);
  });

  it("viewer não escreve", () => {
    expect(falhaComo(VIEWER_A, `insert into public.crm_lead_items (organization_id, lead_id, nome, preco_unit_cents) values ('${ORG_A}', '${LEAD_A}', 'x', 1);`)).toMatch(/row-level security|violates/i);
  });
});

describe("itens do negócio — regras do schema", () => {
  it("o total é gerado: quantidade × preço − desconto + acréscimo", () => {
    sql(`update public.crm_lead_items set quantidade = 3, preco_unit_cents = 5000, desconto_cents = 1000, acrescimo_cents = 250 where id = '${ITEM_A}';`);
    expect(sql(`select total_cents from public.crm_lead_items where id = '${ITEM_A}';`)).toBe("14250");
  });

  it("não aceita escrever o total à mão nem total negativo", () => {
    expect(falhaComo(AGENT_A, `update public.crm_lead_items set total_cents = 1 where id = '${ITEM_A}';`)).toMatch(/generated|gerad/i);
    expect(falhaComo(AGENT_A, `update public.crm_lead_items set desconto_cents = 999999999 where id = '${ITEM_A}';`)).toMatch(/check|total_nao_negativo/i);
  });

  it("recusa produto de outra organização", () => {
    expect(falhaComo(AGENT_A, `insert into public.crm_lead_items (organization_id, lead_id, product_id, nome, preco_unit_cents) values ('${ORG_A}', '${LEAD_A}', '${PROD_B}', 'x', 1);`)).toMatch(/foreign key|violates/i);
  });

  it("produto apagado do catálogo deixa o item (só o ponteiro some)", () => {
    sql(`insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents) values ('b0b0e1e1-5555-4000-8000-0000000000ff', '${ORG_A}', 'INV-DEL', 'Some', 100) on conflict (id) do nothing;
         insert into public.crm_lead_items (id, organization_id, lead_id, product_id, nome, preco_unit_cents) values ('b0b0e1e1-6666-4000-8000-0000000000ff', '${ORG_A}', '${LEAD_A}', 'b0b0e1e1-5555-4000-8000-0000000000ff', 'Some', 100) on conflict (id) do nothing;
         delete from public.catalog_products where id = 'b0b0e1e1-5555-4000-8000-0000000000ff';`);
    expect(sql(`select (product_id is null)::text || ':' || nome from public.crm_lead_items where id = 'b0b0e1e1-6666-4000-8000-0000000000ff';`)).toBe("true:Some");
    sql(`delete from public.crm_lead_items where id = 'b0b0e1e1-6666-4000-8000-0000000000ff';`);
  });

  it("apagar o negócio apaga os itens", () => {
    sql(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title) values ('b0b0e1e1-4444-4000-8000-0000000000ee', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'Efêmero') on conflict (id) do nothing;
         insert into public.crm_lead_items (organization_id, lead_id, nome, preco_unit_cents) values ('${ORG_A}', 'b0b0e1e1-4444-4000-8000-0000000000ee', 'Item', 10);
         delete from public.crm_leads where id = 'b0b0e1e1-4444-4000-8000-0000000000ee';`);
    expect(sql(`select count(*) from public.crm_lead_items where lead_id = 'b0b0e1e1-4444-4000-8000-0000000000ee';`)).toBe("0");
  });
});

describe("itens do negócio — valor do negócio derivado", () => {
  it("o valor do negócio vira a soma dos itens na moeda do negócio", () => {
    // ITEM_A = 14250 (teste anterior)
    expect(sql(`select value_cents from public.crm_leads where id = '${LEAD_A}';`)).toBe("14250");
    comoUsuario(AGENT_A, `insert into public.crm_lead_items (organization_id, lead_id, nome, preco_unit_cents) values ('${ORG_A}', '${LEAD_A}', 'Avulso', 750);`);
    expect(sql(`select value_cents from public.crm_leads where id = '${LEAD_A}';`)).toBe("15000");
  });

  it("item em outra moeda não entra na soma", () => {
    sql(`insert into public.crm_lead_items (organization_id, lead_id, nome, preco_unit_cents, currency) values ('${ORG_A}', '${LEAD_A}', 'Dólar', 99999, 'USD');`);
    expect(sql(`select value_cents from public.crm_leads where id = '${LEAD_A}';`)).toBe("15000");
  });

  it("não reescreve o negócio quando o valor não mudou (sem piscar o quadro)", () => {
    const antes = sql(`select updated_at from public.crm_leads where id = '${LEAD_A}';`);
    sql(`update public.crm_lead_items set nome = 'Avulso renomeado' where lead_id = '${LEAD_A}' and nome = 'Avulso';`);
    expect(sql(`select updated_at from public.crm_leads where id = '${LEAD_A}';`)).toBe(antes);
  });

  it("sem itens na moeda do negócio, o valor digitado à mão segue valendo", () => {
    sql(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, value_cents, currency) values ('b0b0e1e1-4444-4000-8000-0000000000dd', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'Manual', 4321, 'BRL') on conflict (id) do nothing;`);
    expect(sql(`select value_cents from public.crm_leads where id = 'b0b0e1e1-4444-4000-8000-0000000000dd';`)).toBe("4321");
  });
});

describe("itens do negócio — função não fica exposta", () => {
  it("as funções novas não são executáveis por anon nem por public", () => {
    const n = sql(`
      select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('fn_recalcular_valor_do_negocio', 'fn_crm_lead_items_sincroniza_valor')
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));`);
    expect(n).toBe("0");
  });
});
