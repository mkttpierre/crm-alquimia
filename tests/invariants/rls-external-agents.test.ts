import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  countAs,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * Agentes externos na equipe (migration 0256) — isolamento entre organizações.
 *
 *  - `external_agents`: membro da org lê (a barra "Equipe agora" é agent+); só admin escreve; a org B não vê nem
 *    escreve nada da org A;
 *  - `conversa_esperas_avisadas`: membro lê; NINGUÉM escreve pelo papel `authenticated` (só o service_role do cron);
 *  - `fn_marcar_uso_do_agente_externo`: fora do alcance de `anon` e `authenticated`; no banco, marca no máximo uma
 *    vez a cada 30 s, e nunca um agente revogado.
 */

const ORG_B = "dddddddd-0000-4000-8000-000000000017";
const ADMIN_B = "dddddddd-1111-4000-8000-000000000017";
const TOKEN_A = "dddddddd-2222-4000-8000-000000000017";
const AGENTE_A = "dddddddd-3333-4000-8000-000000000017";
const AGENTE_PROBE = "dddddddd-3333-4000-8000-000000000018";
const AGENTE_B = "dddddddd-3333-4000-8000-000000000019";

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${ADMIN_B}', 'agentes-admin-b@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'gov-inv-agentes-b', 'Gov Agentes B', 'Gov Agentes B') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_B}', '${ORG_B}', 'admin', now()) on conflict do nothing;
    insert into public.api_tokens (id, organization_id, created_by, name, prefix, token_hash, scopes)
      values ('${TOKEN_A}', '${GOV_ORG}', '${GOV_ADMIN}', 'Agente: Head', 'dsk_inv17', '\\x17'::bytea,
              '["actor:ai_agent","role:admin","mcp:read","mcp:write"]'::jsonb)
      on conflict do nothing;
    insert into public.external_agents (id, organization_id, nome, tipo, api_token_id, created_by)
      values ('${AGENTE_A}', '${GOV_ORG}', 'Head (invariante)', 'openbot', '${TOKEN_A}', '${GOV_ADMIN}')
      on conflict do nothing;
    insert into public.external_agents (id, organization_id, nome) values ('${AGENTE_B}', '${ORG_B}', 'Agente da B')
      on conflict do nothing;
    insert into public.conversa_esperas_avisadas (organization_id, conversation_id, desde)
      values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '2026-11-13T12:00:00Z') on conflict do nothing;
  `);
});

describe("external_agents — RLS por organização (0256)", () => {
  it("membro da org A (agent) lê o agente; admin da org B não vê", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.external_agents where id = '${AGENTE_A}';`)).toBe(1);
    expect(countAs(ADMIN_B, `select count(*) from public.external_agents where id = '${AGENTE_A}';`)).toBe(0);
  });

  it("só admin da org escreve: manager não cria; admin B não cria na org A nem altera o agente de A", () => {
    const inserir = (quem: string) =>
      writeCountAs(
        quem,
        `insert into public.external_agents (id, organization_id, nome) values ('${AGENTE_PROBE}', '${GOV_ORG}', 'Probe ${quem.slice(-4)}')`,
      );
    expect(inserir(GOV_MANAGER)).toBe(0);
    expect(inserir(ADMIN_B)).toBe(0);
    expect(writeCountAs(ADMIN_B, `update public.external_agents set pode_motor = false where id = '${AGENTE_A}'`)).toBe(0);
    expect(writeCountAs(GOV_MANAGER, `update public.external_agents set papel = 'agent' where id = '${AGENTE_A}'`)).toBe(0);
    expect(sql(`select pode_motor::text || '|' || papel from public.external_agents where id = '${AGENTE_A}';`)).toBe("true|admin");
  });

  it("admin da org A edita o agente dela", () => {
    expect(writeCountAs(GOV_ADMIN, `update public.external_agents set avatar_url = 'https://exemplo.com/a.png' where id = '${AGENTE_A}'`)).toBe(1);
  });

  it("nome é único por organização, não entre organizações", () => {
    expect(
      sql(`
        insert into public.external_agents (organization_id, nome) values ('${ORG_B}', 'Head (invariante)') on conflict do nothing;
        select count(*) from public.external_agents where nome = 'Head (invariante)';
      `).split("\n").at(-1),
    ).toBe("2");
    expect(() => sql(`insert into public.external_agents (organization_id, nome) values ('${GOV_ORG}', 'Head (invariante)');`)).toThrow();
  });
});

describe("conversa_esperas_avisadas — só o cron escreve (0256)", () => {
  it("membro da org A lê; org B não vê; ninguém autenticado insere", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.conversa_esperas_avisadas where conversation_id = '${GOV_CONV_UNASSIGNED}';`)).toBe(1);
    expect(countAs(ADMIN_B, `select count(*) from public.conversa_esperas_avisadas where conversation_id = '${GOV_CONV_UNASSIGNED}';`)).toBe(0);
    let inseriu = 0;
    try {
      inseriu = writeCountAs(
        GOV_ADMIN,
        `insert into public.conversa_esperas_avisadas (organization_id, conversation_id, desde) values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', now())`,
      );
    } catch (err) {
      // Sem GRANT de insert: "permission denied" é a recusa esperada (não é RLS, é privilégio).
      expect(String((err as { stderr?: string }).stderr ?? err)).toMatch(/permission denied/);
    }
    expect(inseriu).toBe(0);
  });

  it("a mesma espera não entra duas vezes (a chave primária é a trava do evento)", () => {
    expect(() =>
      sql(`insert into public.conversa_esperas_avisadas (organization_id, conversation_id, desde) values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '2026-11-13T12:00:00Z');`),
    ).toThrow();
  });
});

describe("fn_marcar_uso_do_agente_externo (0256)", () => {
  it("não é executável por anon nem authenticated", () => {
    const quem = sql(`
      select string_agg(r, ',' order by r) from (
        select unnest(array['anon','authenticated','service_role']) as r
      ) x where has_function_privilege(r, 'public.fn_marcar_uso_do_agente_externo(uuid, text)', 'execute');
    `);
    expect(lastLine(quem)).toBe("service_role");
  });

  it("marca uma vez a cada 30 s e nunca um agente revogado", () => {
    sql(`update public.external_agents set ultimo_uso_em = null, ultima_acao = null, revogado_em = null where id = '${AGENTE_A}';`);
    expect(lastLine(sql(`select public.fn_marcar_uso_do_agente_externo('${TOKEN_A}', 'crm_list_tasks');`))).toBe("t");
    expect(lastLine(sql(`select public.fn_marcar_uso_do_agente_externo('${TOKEN_A}', 'crm_disparo_estado');`))).toBe("f");
    expect(lastLine(sql(`select ultima_acao from public.external_agents where id = '${AGENTE_A}';`))).toBe("crm_list_tasks");

    sql(`update public.external_agents set ultimo_uso_em = now() - interval '31 seconds' where id = '${AGENTE_A}';`);
    expect(lastLine(sql(`select public.fn_marcar_uso_do_agente_externo('${TOKEN_A}', 'crm_disparo_chips');`))).toBe("t");

    sql(`update public.external_agents set ultimo_uso_em = null, revogado_em = now() where id = '${AGENTE_A}';`);
    expect(lastLine(sql(`select public.fn_marcar_uso_do_agente_externo('${TOKEN_A}', 'crm_list_tasks');`))).toBe("f");
  });
});

describe("crm_tasks.agente_externo_id (0256)", () => {
  it("a FK composta recusa tarefa da org A apontando para o agente da org B", () => {
    expect(() =>
      sql(`insert into public.crm_tasks (organization_id, title, agente_externo_id) values ('${GOV_ORG}', 'Cruzada', '${AGENTE_B}');`),
    ).toThrow();
  });

  it("existe e solta (set null) quando o agente é apagado", () => {
    const tarefa = lastLine(
      // Pelo CTE: `insert ... returning` solto faz o psql imprimir também "INSERT 0 1" como última linha.
      sql(`
        with nova as (
          insert into public.crm_tasks (organization_id, title, contact_id, agente_externo_id)
            values ('${GOV_ORG}', 'Tarefa para o agente', '${GOV_CONTACT_1}', '${AGENTE_A}') returning id
        ) select id from nova;
      `),
    );
    sql(`delete from public.external_agents where id = '${AGENTE_A}';`);
    expect(lastLine(sql(`select coalesce(agente_externo_id::text, 'nulo') from public.crm_tasks where id = '${tarefa}';`))).toBe("nulo");
  });
});
