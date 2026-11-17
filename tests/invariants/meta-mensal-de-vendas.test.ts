import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * META MENSAL DE VENDAS — O BANCO DEFENDE O QUE A TELA PROMETE (migration 0262).
 *
 * `organizations.meta_mensal_cents` (centavos, NULL = sem meta) e `fn_definir_meta_mensal`, que só deixa admin (ou
 * platform admin) gravar e re-resolve o papel NO BANCO. O que se prova, e que nenhum teste de Server Action alcança (a
 * action roda com o Postgres substituído por um dublê):
 *
 *   1. a coluna nasce NULL e existe como `bigint` anulável;
 *   2. admin grava; viewer, agent, manager e admin de OUTRA organização recebem 42501; platform admin grava;
 *   3. NULL apaga a meta; zero, negativo e acima do teto levantam 22023 — e a autorização vem ANTES do valor
 *      (quem não pode recebe 42501 mesmo mandando lixo);
 *   4. o CHECK recusa o que a função deixaria passar se alguém gravasse DIRETO na tabela (23514);
 *   5. outra organização e `organizations.settings` ficam intactos;
 *   6. a função é `service_role` apenas: `anon` e `authenticated` não têm EXECUTE.
 *
 * Organização e usuários DEDICADOS, com namespace próprio (`ba2a` + `0262`): o banco do `test:db` é compartilhado.
 */

const ORG = "ba2a0262-0000-4000-8000-000000000001";
const ORG_VIZINHA = "ba2a0262-0000-4000-8000-000000000002";
const ADMIN = "ba2a0262-1111-4000-8000-000000000001";
const VIEWER = "ba2a0262-1111-4000-8000-000000000002";
const AGENT = "ba2a0262-1111-4000-8000-000000000003";
const MANAGER = "ba2a0262-1111-4000-8000-000000000004";
const ESTRANHO = "ba2a0262-1111-4000-8000-000000000005"; // admin só da vizinha
const PLATFORM = "ba2a0262-1111-4000-8000-000000000006"; // platform admin, sem vínculo nenhum

const FN = "public.fn_definir_meta_mensal(uuid,uuid,bigint)";
const TETO = "100000000000000";

const consulta = (q: string): string => sql(q).split("\n").at(-1) ?? "";

const meta = (org = ORG): string => consulta(`select coalesce(meta_mensal_cents::text,'NULO') from public.organizations where id='${org}';`);
const settingsDe = (org = ORG): string => consulta(`select coalesce(settings::text,'NULO') from public.organizations where id='${org}';`);

/** Chama e devolve o `row_count`; lança se o Postgres recusar. */
function chamar(org: string, ator: string, valor: string): number {
  const out = consulta(`select public.fn_definir_meta_mensal('${org}','${ator}',${valor});`);
  if (!/^-?\d+$/.test(out)) throw new Error(`saída inesperada do psql: ${out}`);
  return Number(out);
}

/** A mensagem de recusa do Postgres, ou `null` quando a chamada PASSOU. */
function recusa(org: string, ator: string, valor: string): string | null {
  try {
    chamar(org, ator, valor);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** O erro de um comando solto (escrita direta na tabela), ou `null` se passou. */
function erroDe(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

beforeAll(() => {
  const usuarios = [ADMIN, VIEWER, AGENT, MANAGER, ESTRANHO, PLATFORM]
    .map((id, i) => `insert into auth.users (id, email) values ('${id}', 'meta-${i}@invariant.test') on conflict do nothing;`)
    .join("\n");
  const membros: Array<[string, string]> = [
    [ADMIN, "admin"],
    [VIEWER, "viewer"],
    [AGENT, "agent"],
    [MANAGER, "manager"],
  ];
  sql(`
    ${usuarios}
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'meta-inv-0262', 'Meta Invariant Org', 'Meta Inv', '{"visibility_mode":"own"}'::jsonb)
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_VIZINHA}', 'meta-inv-0262-viz', 'Meta Invariant Vizinha', 'Meta Viz')
      on conflict do nothing;
    ${membros
      .map(
        ([id, papel]) =>
          `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
             values ('${id}', '${ORG}', '${papel}', now()) on conflict do nothing;`,
      )
      .join("\n")}
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ESTRANHO}', '${ORG_VIZINHA}', 'admin', now()) on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, reason)
      values ('${PLATFORM}', '${ADMIN}', 'invariante da meta mensal') on conflict do nothing;
    update public.organizations set meta_mensal_cents = null where id in ('${ORG}', '${ORG_VIZINHA}');
  `);
});

describe("guarda de vacuidade — o que todo caso abaixo supõe", () => {
  it("a coluna existe, é bigint anulável e sem default", () => {
    expect(
      consulta(`
        select data_type || ':' || is_nullable || ':' || coalesce(column_default, 'sem-default')
          from information_schema.columns
         where table_schema = 'public' and table_name = 'organizations' and column_name = 'meta_mensal_cents';
      `),
    ).toBe("bigint:YES:sem-default");
  });

  it("as organizações de partida não têm meta", () => {
    expect(meta()).toBe("NULO");
    expect(meta(ORG_VIZINHA)).toBe("NULO");
  });
});

describe("fn_definir_meta_mensal — só admin", () => {
  it("⭐ admin da organização grava (row_count 1) e só a linha da organização muda", () => {
    expect(chamar(ORG, ADMIN, "5000000")).toBe(1);
    expect(meta()).toBe("5000000");
    expect(meta(ORG_VIZINHA)).toBe("NULO");
  });

  it("⭐ viewer, agent, manager e o admin de OUTRA organização recebem 42501, e a meta não muda", () => {
    for (const ator of [VIEWER, AGENT, MANAGER, ESTRANHO]) {
      expect(recusa(ORG, ator, "1"), ator).toMatch(/meta_mensal_sem_permissao|42501/);
    }
    expect(meta()).toBe("5000000");
  });

  it("platform admin sem vínculo nenhum também grava", () => {
    expect(chamar(ORG, PLATFORM, "7000000")).toBe(1);
    expect(meta()).toBe("7000000");
  });

  it("a autorização vem ANTES do valor: quem não pode recebe 42501 mesmo mandando lixo", () => {
    expect(recusa(ORG, VIEWER, "-5")).toMatch(/meta_mensal_sem_permissao|42501/);
  });

  it("NULL apaga a meta", () => {
    expect(chamar(ORG, ADMIN, "null")).toBe(1);
    expect(meta()).toBe("NULO");
  });

  it("zero, negativo e acima do teto levantam 22023, e nada é gravado", () => {
    chamar(ORG, ADMIN, "1234");
    for (const ruim of ["0", "-1", String(BigInt(TETO) + 1n)]) {
      expect(recusa(ORG, ADMIN, ruim), ruim).toMatch(/meta_mensal_fora_da_faixa|22023/);
    }
    expect(meta()).toBe("1234");
  });

  it("o teto exato é aceito", () => {
    expect(chamar(ORG, ADMIN, TETO)).toBe(1);
    expect(meta()).toBe(TETO);
  });

  it("organização que não existe: platform admin recebe 0 linhas (a catraca da issue #144)", () => {
    expect(chamar("ba2a0262-0000-4000-8000-0000000000ff", PLATFORM, "1")).toBe(0);
  });

  it("não toca em organizations.settings (sem read-modify-write do jsonb inteiro)", () => {
    const antes = settingsDe();
    chamar(ORG, ADMIN, "9999");
    expect(settingsDe()).toBe(antes);
  });
});

describe("o CHECK da coluna recusa escrita direta fora da faixa", () => {
  it("zero, negativo e acima do teto: 23514; dentro da faixa e NULL passam", () => {
    for (const ruim of ["0", "-1", String(BigInt(TETO) + 1n)]) {
      expect(erroDe(`update public.organizations set meta_mensal_cents = ${ruim} where id='${ORG}';`), ruim).toMatch(
        /organizations_meta_mensal_cents_faixa|23514|check constraint/i,
      );
    }
    expect(erroDe(`update public.organizations set meta_mensal_cents = 1 where id='${ORG}';`)).toBeNull();
    expect(erroDe(`update public.organizations set meta_mensal_cents = null where id='${ORG}';`)).toBeNull();
  });
});

describe("privilégios e definição", () => {
  it("⭐ anon e authenticated não executam; service_role executa", () => {
    const privilegio = (papel: string) => consulta(`select has_function_privilege('${papel}', '${FN}', 'EXECUTE');`);
    expect(privilegio("anon")).toBe("f");
    expect(privilegio("authenticated")).toBe("f");
    expect(privilegio("service_role")).toBe("t");
  });

  it("é SECURITY DEFINER com search_path fixo (a varredura global confere o resto)", () => {
    expect(
      consulta(
        `select prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname='fn_definir_meta_mensal' and pronamespace='public'::regnamespace;`,
      ),
    ).toMatch(/^true:search_path=/);
  });
});
