import { execFile, execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov } from "./gov-helpers";

/**
 * FUNIS DO OPERADOR (migration 0248): não vazam entre organizações, respeitam o papel, recusam valor fora da regra,
 * seguram o modelo que está em uso e semeiam o funil de valores uma vez só.
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

/** Roda como o usuário; devolve a última linha (contagem) ou lança com a mensagem do Postgres. */
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

const ORG_A = "f0a11e1e-0000-4000-8000-00000000000a";
const ORG_B = "f0a11e1e-0000-4000-8000-00000000000b";
const AGENT_A = "f0a11e1e-1111-4000-8000-00000000000a";
const MANAGER_A = "f0a11e1e-1111-4000-8000-00000000000d";
const AGENT_B = "f0a11e1e-1111-4000-8000-00000000000b";
const FUNIL_A = "f0a11e1e-2222-4000-8000-00000000000a";
const FUNIL_B = "f0a11e1e-2222-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'funil-agent-a@invariant.test'),
      ('${MANAGER_A}', 'funil-mgr-a@invariant.test'),
      ('${AGENT_B}', 'funil-agent-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'funil-inv-a', 'Funil Invariant A', 'Funil A'),
      ('${ORG_B}', 'funil-inv-b', 'Funil Invariant B', 'Funil B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG_A}', 'agent', now()),
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;

    -- Os 7 modelos do funil de valores nas DUAS orgs (o seed precisa deles) + um funil compartilhado por org.
    insert into public.message_templates (organization_id, title, body, shortcut)
    select o.org, 'Valores ' || n, 'Texto ' || n, '/valores-' || n
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) o(org), generate_series(1, 7) n
     where not exists (select 1 from public.message_templates t where t.organization_id = o.org and t.shortcut = '/valores-' || n);

    insert into public.operator_funnels (id, organization_id, nome, atalho) values
      ('${FUNIL_A}', '${ORG_A}', 'Funil A', 'funil-a'),
      ('${FUNIL_B}', '${ORG_B}', 'Funil B', 'funil-b')
      on conflict do nothing;
    insert into public.operator_funnel_steps (organization_id, funnel_id, position, template_id, atraso_ms)
    select f.organization_id, f.id, 1, (select t.id from public.message_templates t where t.organization_id = f.organization_id and t.shortcut = '/valores-1' limit 1), 0
      from public.operator_funnels f where f.id in ('${FUNIL_A}', '${FUNIL_B}')
       and not exists (select 1 from public.operator_funnel_steps s where s.funnel_id = f.id);
  `);
});

describe("funis do operador — RLS", () => {
  it("quem é da org lê o próprio funil (controle positivo)", () => {
    expect(Number(comoUsuario(AGENT_A, `select count(*) from public.operator_funnels where id = '${FUNIL_A}';`))).toBe(1);
    expect(Number(comoUsuario(AGENT_A, `select count(*) from public.operator_funnel_steps where funnel_id = '${FUNIL_A}';`))).toBe(1);
  });

  it("a org A não lê funil nem passo da org B", () => {
    expect(Number(comoUsuario(AGENT_A, `select count(*) from public.operator_funnels where id = '${FUNIL_B}';`))).toBe(0);
    expect(Number(comoUsuario(AGENT_A, `select count(*) from public.operator_funnel_steps where funnel_id = '${FUNIL_B}';`))).toBe(0);
  });

  it("a org A não escreve na org B", () => {
    const linhas = comoUsuario(AGENT_A, `with u as (update public.operator_funnels set nome = 'invadido' where id = '${FUNIL_B}' returning 1) select count(*) from u;`);
    expect(Number(linhas)).toBe(0);
  });

  it("agent não altera funil compartilhado; manager altera", () => {
    expect(Number(comoUsuario(AGENT_A, `with u as (update public.operator_funnels set nome = 'agent mexeu' where id = '${FUNIL_A}' returning 1) select count(*) from u;`))).toBe(0);
    expect(Number(comoUsuario(MANAGER_A, `with u as (update public.operator_funnels set nome = 'Funil A' where id = '${FUNIL_A}' returning 1) select count(*) from u;`))).toBe(1);
  });
});

describe("funis do operador — regras do schema", () => {
  it("recusa passo com modelo de outra organização", () => {
    const modeloB = sql(`select template_id from public.operator_funnel_steps where funnel_id = '${FUNIL_B}' limit 1;`);
    expect(falhaComo(MANAGER_A, `insert into public.operator_funnel_steps (organization_id, funnel_id, position, template_id) values ('${ORG_A}', '${FUNIL_A}', 99, '${modeloB}');`)).toMatch(/foreign key/i);
  });
  it("recusa atraso acima de 10 min e presença fora do vocabulário", () => {
    expect(falhaComo(MANAGER_A, `update public.operator_funnel_steps set atraso_ms = 600001 where funnel_id = '${FUNIL_A}';`)).toMatch(/check/i);
    expect(falhaComo(MANAGER_A, `update public.operator_funnel_steps set presenca = 'falando' where funnel_id = '${FUNIL_A}';`)).toMatch(/check/i);
    expect(falhaComo(MANAGER_A, `update public.operator_funnel_steps set presenca_ms = 25001 where funnel_id = '${FUNIL_A}';`)).toMatch(/check/i);
  });

  it("apagar modelo usado num passo é recusado pela FK", () => {
    const erro = falhaComo(
      MANAGER_A,
      `delete from public.message_templates where id = (select template_id from public.operator_funnel_steps where funnel_id = '${FUNIL_A}' limit 1);`,
    );
    expect(erro).toMatch(/foreign key|violates/i);
  });

  it("disparo_envios aceita presença válida e recusa fora do vocabulário", () => {
    expect(sql(`select count(*) from pg_constraint where conname in ('disparo_envios_presenca_check','disparo_envios_presenca_ms_check');`)).toBe("2");
  });
});

describe("funis do operador — seed do funil de valores", () => {
  it("re-aplicar o seed não duplica funil nem passos", () => {
    const seed = execFileSync("node", [
      "-e",
      `const s=require('fs').readFileSync('supabase/migrations/20261106120000_0248_funis_do_operador.sql','utf8');process.stdout.write(s.slice(s.indexOf('-- 4 · seed')))`,
    ], { encoding: "utf8" });
    sql(seed);
    sql(seed);
    expect(sql(`select count(*) from public.operator_funnels where organization_id = '${ORG_A}' and atalho = 'funil-valores';`)).toBe("1");
    expect(sql(`select count(*) from public.operator_funnel_steps s join public.operator_funnels f on f.id = s.funnel_id where f.organization_id = '${ORG_A}' and f.atalho = 'funil-valores';`)).toBe("7");
    expect(sql(`select string_agg(atraso_ms::text, ',' order by position) from public.operator_funnel_steps s join public.operator_funnels f on f.id = s.funnel_id where f.organization_id = '${ORG_A}' and f.atalho = 'funil-valores';`)).toBe("0,3000,3000,3000,3000,3000,3000");
  });

  it("org cujos /valores-1..7 são pessoais não ganha o funil de valores", () => {
    const ORG_C = "f0a11e1e-0000-4000-8000-00000000000c";
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_C}', 'funil-inv-c', 'Funil Invariant C', 'Funil C') on conflict (id) do nothing;
      insert into public.message_templates (organization_id, title, body, shortcut, owner_user_id)
      select '${ORG_C}', 'Pessoal ' || n, 'texto', '/valores-' || n, '${AGENT_A}'
        from generate_series(1, 7) n
       where not exists (select 1 from public.message_templates t where t.organization_id = '${ORG_C}' and t.shortcut = '/valores-' || n);
    `);
    const seed = execFileSync("node", [
      "-e",
      `const s=require('fs').readFileSync('supabase/migrations/20261106120000_0248_funis_do_operador.sql','utf8');process.stdout.write(s.slice(s.indexOf('-- 4 · seed')))`,
    ], { encoding: "utf8" });
    sql(seed);
    expect(sql(`select count(*) from public.operator_funnels where organization_id = '${ORG_C}';`)).toBe("0");
  });
});

describe("funis do operador — salvar em uma transação e privacidade dos modelos (0248)", () => {
  const modelo = (org: string, atalho: string) => sql(`select id from public.message_templates where organization_id = '${org}' and shortcut = '${atalho}' limit 1;`);
  const passos = (...ids: string[]) =>
    `'${JSON.stringify(ids.map((id) => ({ template_id: id, atraso_ms: 0, presenca: "nenhuma", presenca_ms: 0 })))}'::jsonb`;
  const salvar = (userId: string, funil: string | null, atalho: string, compartilhado: boolean, p: string) =>
    comoUsuario(userId, `select public.fn_salvar_funil_do_operador(${funil ? `'${funil}'` : "null"}, '${ORG_A}', 'Teste', '${atalho}', '{}', false, ${compartilhado}, ${p});`);
  const estadoDoFunilA = () =>
    sql(`select nome || '|' || (select count(*) from public.operator_funnel_steps where funnel_id = f.id) from public.operator_funnels f where f.id = '${FUNIL_A}';`);

  it("cria funil e passos juntos e devolve o id", () => {
    const id = salvar(MANAGER_A, null, "inv-cria", true, passos(modelo(ORG_A, "/valores-2"), modelo(ORG_A, "/valores-3")));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sql(`select count(*) from public.operator_funnel_steps where funnel_id = '${id}';`)).toBe("2");
    expect(sql(`select owner_user_id is null from public.operator_funnels where id = '${id}';`)).toBe("t");
  });

  it("falha no meio não deixa nada pela metade: metadados e passos antigos intactos", () => {
    const antes = estadoDoFunilA();
    const erro = falhaComo(MANAGER_A, `select public.fn_salvar_funil_do_operador('${FUNIL_A}', '${ORG_A}', 'MUDOU', 'funil-a', '{}', false, true, ${passos(modelo(ORG_A, "/valores-1"), modelo(ORG_B, "/valores-1"))});`);
    expect(erro).toMatch(/funnel_modelo_pessoal/);
    expect(estadoDoFunilA()).toBe(antes);
  });

  it("modelo de outra organização é recusado ao salvar", () => {
    expect(falhaComo(MANAGER_A, `select public.fn_salvar_funil_do_operador(null, '${ORG_A}', 'X', 'inv-outra-org', '{}', false, true, ${passos(modelo(ORG_B, "/valores-1"))});`)).toMatch(/funnel_modelo_pessoal/);
  });

  it("funil compartilhado não aceita modelo pessoal; funil pessoal aceita o do próprio dono", () => {
    sql(`insert into public.message_templates (organization_id, title, body, shortcut, owner_user_id)
         select '${ORG_A}', 'Pessoal do agent', 'segredo', '/pessoal-inv', '${AGENT_A}'
          where not exists (select 1 from public.message_templates where organization_id = '${ORG_A}' and shortcut = '/pessoal-inv');`);
    const pessoal = modelo(ORG_A, "/pessoal-inv");
    expect(falhaComo(MANAGER_A, `select public.fn_salvar_funil_do_operador(null, '${ORG_A}', 'X', 'inv-compart-pessoal', '{}', false, true, ${passos(pessoal)});`)).toMatch(/funnel_modelo_pessoal/);
    const id = salvar(AGENT_A, null, "inv-pessoal-ok", false, passos(pessoal, modelo(ORG_A, "/valores-4")));
    expect(sql(`select owner_user_id = '${AGENT_A}' from public.operator_funnels where id = '${id}';`)).toBe("t");
  });

  it("agent não compartilha um funil pessoal (o dono não muda)", () => {
    const id = salvar(AGENT_A, null, "inv-nao-compartilha", false, passos(modelo(ORG_A, "/valores-1")));
    expect(falhaComo(AGENT_A, `select public.fn_salvar_funil_do_operador('${id}', '${ORG_A}', 'X', 'inv-nao-compartilha', '{}', false, true, ${passos(modelo(ORG_A, "/valores-1"))});`)).not.toBe("");
    expect(sql(`select owner_user_id = '${AGENT_A}' from public.operator_funnels where id = '${id}';`)).toBe("t");
  });

  it("as funções nascem fechadas para anon; o enfileirar só serve ao service_role", () => {
    const pode = (papel: string, fn: string) => sql(`select has_function_privilege('${papel}', '${fn}', 'execute');`);
    const salvarFn = "public.fn_salvar_funil_do_operador(uuid, uuid, text, text, text[], boolean, boolean, jsonb)";
    const filaFn = "public.fn_enfileirar_funil_do_operador(uuid, uuid, jsonb)";
    expect(pode("anon", salvarFn)).toBe("f");
    expect(pode("authenticated", salvarFn)).toBe("t");
    expect(pode("anon", filaFn)).toBe("f");
    expect(pode("authenticated", filaFn)).toBe("f");
    expect(pode("service_role", filaFn)).toBe("t");
  });
});

describe("funis do operador — um funil por lead, mesmo com pedidos concorrentes (0248)", () => {
  const LEAD = "f0a11e1e-3333-4000-8000-00000000000a";
  const linha = (tipo: string) =>
    JSON.stringify([{ chip_id: null, tipo, texto: "oi", midia: null, midia_id: null, enviar_apos: "2026-11-06T12:00:00Z", presenca: "nenhuma", presenca_ms: 0, estado: "pendente", enviado_em: null, motivo: null, da_parada: false }]);
  const enfileirar = (tipo: string) => `select public.fn_enfileirar_funil_do_operador('${GOV_ORG}', '${LEAD}', '${linha(tipo)}'::jsonb);`;

  beforeAll(() => {
    seedGov();
    sql(`insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status)
         values ('${LEAD}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead funil', 'open') on conflict do nothing;
         delete from public.disparo_envios where lead_id = '${LEAD}';`);
  });

  it("o segundo funil, de outro tipo, é recusado enquanto o primeiro está em aberto", () => {
    expect(sql(enfileirar("funil_a:1"))).toBe("1");
    let erro = "";
    try {
      sql(enfileirar("funil_b:1"));
    } catch (e) {
      erro = String((e as { stderr?: string }).stderr ?? e);
    }
    expect(erro).toMatch(/funil_em_andamento/);
    expect(sql(`select count(*) from public.disparo_envios where lead_id = '${LEAD}';`)).toBe("1");
  });

  it("dois pedidos ao mesmo tempo (transações abertas juntas): exatamente um grava", async () => {
    sql(`delete from public.disparo_envios where lead_id = '${LEAD}';`);
    // Cada psql segura a transação aberta 1 s depois de gravar: o 2º só passa da trava quando o 1º já deu commit.
    const rodar = (tipo: string) =>
      new Promise<boolean>((resolve) => {
        const filho = execFile("docker", ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], (erro) => resolve(!erro));
        filho.stdin?.end(`begin; ${enfileirar(tipo)} select pg_sleep(1); commit;`);
      });
    const resultados = await Promise.all([rodar("funil_c:1"), rodar("funil_d:1")]);
    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect(sql(`select count(*) from public.disparo_envios where lead_id = '${LEAD}';`)).toBe("1");
  });
});
