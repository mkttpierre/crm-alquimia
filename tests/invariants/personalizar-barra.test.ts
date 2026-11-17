import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * PERSONALIZAR A BARRA LATERAL — O BANCO DEFENDE O QUE A TELA PROMETE (migration 0261).
 *
 * Duas colunas e duas funções, com donos diferentes:
 *
 *   - `user_organizations.preferencias_da_barra` — da PESSOA. `fn_definir_minha_barra`
 *     grava SÓ a linha do próprio ator, em qualquer papel;
 *   - `organizations.nomes_da_barra` — da ORGANIZAÇÃO. `fn_definir_nomes_da_barra`
 *     só deixa admin (ou platform admin) gravar, e re-resolve o papel NO BANCO.
 *
 * O que se prova, e que nenhum teste de Server Action alcança (a action roda com o
 * Postgres substituído por um dublê):
 *
 *   1. a coluna nasce `'{}'` e as linhas que já existiam a satisfazem;
 *   2. a função pessoal NÃO toca a linha de outro membro nem de outra organização,
 *      e membro revogado não grava (0 linhas — a catraca da issue #144);
 *   3. a função de nomes recusa viewer, agent, manager e admin de OUTRA organização
 *      (42501), aceita admin e platform admin, apara, descarta vazio e recusa 41
 *      caracteres, chave fora do formato e valor que não é texto (22023);
 *   4. os CHECKs recusam o que a função deixaria passar se alguém gravasse DIRETO
 *      na tabela (o caminho que não passa por função nenhuma);
 *   5. `organizations.settings` fica intacto — esta feature não tem read-modify-write
 *      do jsonb inteiro (o defeito que a 0157 existe para evitar);
 *   6. as duas funções são `service_role` apenas: `anon` e `authenticated` não têm
 *      EXECUTE (definer volátil alcançável pela sessão é escrita cross-tenant).
 *
 * Organização e usuários DEDICADOS, com namespace próprio (`ba2a` + `0261`): o banco
 * do `test:db` é compartilhado entre os arquivos da suíte.
 */

const ORG = "ba2a0261-0000-4000-8000-000000000001";
const ORG_VIZINHA = "ba2a0261-0000-4000-8000-000000000002";
const ADMIN = "ba2a0261-1111-4000-8000-000000000001";
const VIEWER = "ba2a0261-1111-4000-8000-000000000002";
const AGENT = "ba2a0261-1111-4000-8000-000000000003";
const MANAGER = "ba2a0261-1111-4000-8000-000000000004";
const ESTRANHO = "ba2a0261-1111-4000-8000-000000000005"; // admin só da vizinha
const PLATFORM = "ba2a0261-1111-4000-8000-000000000006"; // platform admin, sem vínculo nenhum
const REVOGADO = "ba2a0261-1111-4000-8000-000000000007";

const MINHA = "public.fn_definir_minha_barra(uuid,uuid,jsonb)";
const NOMES = "public.fn_definir_nomes_da_barra(uuid,uuid,jsonb)";

const lastLine = (out: string): string => out.split("\n").at(-1) ?? "";

function consulta(q: string): string {
  return lastLine(sql(q));
}

/** `preferencias_da_barra` do membro naquela organização, como texto. */
function prefs(user: string, org = ORG): string {
  return consulta(
    `select preferencias_da_barra::text from public.user_organizations where user_id='${user}' and organization_id='${org}';`,
  );
}

function nomesDa(org = ORG): string {
  return consulta(`select nomes_da_barra::text from public.organizations where id='${org}';`);
}

function settingsDe(org = ORG): string {
  return consulta(
    `select coalesce(settings::text,'NULO') from public.organizations where id='${org}';`,
  );
}

/** Chama e devolve o `row_count`; lança se o Postgres recusar. */
function chamar(fn: string, org: string, ator: string, jsonb: string): number {
  const out = consulta(`select ${fn.split("(")[0]}('${org}','${ator}',${jsonb});`);
  if (!/^-?\d+$/.test(out)) throw new Error(`saída inesperada do psql: ${out}`);
  return Number(out);
}

/** A mensagem de recusa do Postgres, ou `null` quando a chamada PASSOU. */
function recusa(fn: string, org: string, ator: string, jsonb: string): string | null {
  try {
    chamar(fn, org, ator, jsonb);
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
  const usuarios = [ADMIN, VIEWER, AGENT, MANAGER, ESTRANHO, PLATFORM, REVOGADO]
    .map(
      (id, i) =>
        `insert into auth.users (id, email) values ('${id}', 'barra-${i}@invariant.test') on conflict do nothing;`,
    )
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
      values ('${ORG}', 'barra-inv-0261', 'Barra Invariant Org', 'Barra Inv',
              '{"visibility_mode":"own","routing":{"mode":"round_robin"}}'::jsonb)
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_VIZINHA}', 'barra-inv-0261-viz', 'Barra Invariant Vizinha', 'Barra Viz')
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
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
      values ('${REVOGADO}', '${ORG}', 'viewer', now(), now()) on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, reason)
      values ('${PLATFORM}', '${ADMIN}', 'invariante da barra lateral') on conflict do nothing;
    update public.user_organizations set preferencias_da_barra = '{}'::jsonb
      where organization_id in ('${ORG}', '${ORG_VIZINHA}');
    update public.organizations set nomes_da_barra = '{}'::jsonb where id in ('${ORG}', '${ORG_VIZINHA}');
  `);
});

describe("guarda de vacuidade — o que todo caso abaixo supõe", () => {
  it("as duas colunas existem, são jsonb not null e nascem '{}'", () => {
    expect(
      consulta(`
        select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || column_default, ' | ' order by table_name)
          from information_schema.columns
         where table_schema = 'public'
           and ((table_name = 'user_organizations' and column_name = 'preferencias_da_barra')
             or (table_name = 'organizations' and column_name = 'nomes_da_barra'));
      `),
    ).toBe(
      "organizations.nomes_da_barra:jsonb:NO:'{}'::jsonb | user_organizations.preferencias_da_barra:jsonb:NO:'{}'::jsonb",
    );
  });

  it("os membros de partida estão na organização, com preferência vazia", () => {
    expect(
      consulta(
        `select count(*) from public.user_organizations where organization_id='${ORG}' and revoked_at is null;`,
      ),
    ).toBe("4");
    expect(prefs(VIEWER)).toBe("{}");
    expect(nomesDa()).toBe("{}");
  });
});

describe("fn_definir_minha_barra — só a linha do próprio ator", () => {
  const preferencias = `'{"ocultos":["/app/leads"],"ordem":["/app/agenda","/app/inbox"]}'::jsonb`;

  it("⭐ qualquer papel grava a PRÓPRIA preferência (row_count 1)", () => {
    for (const ator of [VIEWER, AGENT, MANAGER, ADMIN]) {
      expect(chamar(MINHA, ORG, ator, preferencias)).toBe(1);
      expect(JSON.parse(prefs(ator))).toEqual({
        ocultos: ["/app/leads"],
        ordem: ["/app/agenda", "/app/inbox"],
      });
    }
  });

  it("⭐ não toca a linha de OUTRO membro", () => {
    sql(
      `update public.user_organizations set preferencias_da_barra='{}'::jsonb where organization_id='${ORG}';`,
    );
    expect(chamar(MINHA, ORG, VIEWER, `'{"ocultos":["/app/tasks"]}'::jsonb`)).toBe(1);
    expect(prefs(VIEWER)).toBe('{"ocultos": ["/app/tasks"]}');
    for (const outro of [AGENT, MANAGER, ADMIN]) expect(prefs(outro)).toBe("{}");
  });

  it("⭐ quem não é membro da organização grava 0 linhas, e nada muda (a catraca da issue #144)", () => {
    expect(chamar(MINHA, ORG, ESTRANHO, preferencias)).toBe(0);
    expect(chamar(MINHA, ORG, PLATFORM, preferencias)).toBe(0);
    expect(prefs(ESTRANHO, ORG_VIZINHA)).toBe("{}");
    expect(prefs(ADMIN)).toBe("{}");
  });

  it("membro revogado grava 0 linhas", () => {
    expect(chamar(MINHA, ORG, REVOGADO, preferencias)).toBe(0);
    expect(prefs(REVOGADO)).toBe("{}");
  });

  it("a mesma pessoa em outra organização não é afetada", () => {
    sql(`
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${ADMIN}', '${ORG_VIZINHA}', 'viewer', now()) on conflict do nothing;
    `);
    expect(chamar(MINHA, ORG, ADMIN, preferencias)).toBe(1);
    expect(prefs(ADMIN, ORG_VIZINHA)).toBe("{}");
  });

  it("NULL e o jsonb 'null' limpam a preferência", () => {
    expect(chamar(MINHA, ORG, VIEWER, preferencias)).toBe(1);
    expect(chamar(MINHA, ORG, VIEWER, "null")).toBe(1);
    expect(prefs(VIEWER)).toBe("{}");
    expect(chamar(MINHA, ORG, VIEWER, preferencias)).toBe(1);
    expect(chamar(MINHA, ORG, VIEWER, "'null'::jsonb")).toBe(1);
    expect(prefs(VIEWER)).toBe("{}");
  });

  it("argumento nulo e jsonb que não é objeto são recusados antes de gravar", () => {
    expect(recusa(MINHA, ORG, VIEWER, `'[]'::jsonb`)).toContain("minha_barra_forma_invalida");
    expect(recusa(MINHA, ORG, VIEWER, `'"texto"'::jsonb`)).toContain("minha_barra_forma_invalida");
    expect(erroDe(`select ${MINHA.split("(")[0]}(null, '${VIEWER}', '{}'::jsonb);`)).toContain(
      "minha_barra_argumento_nulo",
    );
    expect(erroDe(`select ${MINHA.split("(")[0]}('${ORG}', null, '{}'::jsonb);`)).toContain(
      "minha_barra_argumento_nulo",
    );
  });

  it("⭐ nenhuma escrita desta feature toca `organizations.settings`", () => {
    const antes = settingsDe();
    chamar(MINHA, ORG, VIEWER, preferencias);
    chamar(NOMES, ORG, ADMIN, `'{"/app/inbox":"Atendimento"}'::jsonb`);
    expect(settingsDe()).toBe(antes);
    expect(
      consulta(`select settings->>'visibility_mode' from public.organizations where id='${ORG}';`),
    ).toBe("own");
  });
});

describe("user_organizations_preferencias_da_barra_forma — escrita DIRETA, sem passar por função", () => {
  const direto = (json: string) =>
    erroDe(
      `update public.user_organizations set preferencias_da_barra = ${json}::jsonb where user_id='${AGENT}' and organization_id='${ORG}';`,
    );

  it("aceita a forma do contrato (inclusive vazia e só com um dos campos)", () => {
    for (const ok of [
      `'{}'`,
      `'{"ocultos":[]}'`,
      `'{"ordem":["/app/inbox"]}'`,
      `'{"ocultos":["grupo:ia"],"ordem":[]}'`,
    ]) {
      expect(direto(ok), ok).toBeNull();
    }
  });

  it("recusa o que não é objeto, campo extra, lista que não é lista e item que não é texto", () => {
    for (const ruim of [
      `'[]'`,
      `'"x"'`,
      `'{"extra":1}'`,
      `'{"ocultos":"/app/leads"}'`,
      `'{"ordem":{"a":1}}'`,
      `'{"ocultos":[1]}'`,
      `'{"ordem":["/app/a",null]}'`,
    ]) {
      expect(direto(ruim), ruim).toContain("user_organizations_preferencias_da_barra_forma");
    }
  });

  it("⭐ recusa array aninhado e objeto dentro da lista (o jsonpath em modo `lax` os desembrulharia e deixaria passar)", () => {
    for (const ruim of [
      `'{"ocultos":[["/app/leads"]]}'`,
      `'{"ordem":[[]]}'`,
      `'{"ocultos":[["a"],"/app/leads"]}'`,
      `'{"ordem":[{"a":"/app/leads"}]}'`,
    ]) {
      expect(direto(ruim), ruim).toContain("user_organizations_preferencias_da_barra_forma");
    }
  });

  it("recusa lista com mais de 200 chaves e conteúdo maior que 16 KB", () => {
    const muitas = JSON.stringify({ ocultos: Array.from({ length: 201 }, (_, i) => `/app/t${i}`) });
    expect(direto(`'${muitas}'`)).toContain("user_organizations_preferencias_da_barra_forma");
    const enorme = JSON.stringify({ ordem: Array.from({ length: 150 }, () => "x".repeat(120)) });
    expect(direto(`'${enorme}'`)).toContain("user_organizations_preferencias_da_barra_forma");
  });

  it("nem a chave que saiu do catálogo é problema: o banco só confere a FORMA", () => {
    expect(direto(`'{"ocultos":["/app/rota-que-nao-existe-mais"]}'`)).toBeNull();
  });
});

describe("fn_definir_nomes_da_barra — só admin", () => {
  const nomes = `'{"/app/inbox":"Atendimento","grupo:ia":"Robôs"}'::jsonb`;

  it("⭐ viewer, agent, manager e admin de OUTRA organização recebem 42501, e nada é gravado", () => {
    // Compara com o que já estava gravado: um teste anterior do arquivo grava nomes como admin
    // (a escrita não toca `settings`), e exigir `{}` aqui media a ordem dos testes, não a recusa.
    const antes = nomesDa();
    for (const ator of [VIEWER, AGENT, MANAGER, ESTRANHO]) {
      expect(recusa(NOMES, ORG, ator, nomes), ator).toContain("nomes_da_barra_sem_permissao");
    }
    expect(nomesDa()).toBe(antes);
  });

  it("⭐ membro revogado, mesmo tendo sido admin, também é recusado", () => {
    sql(`
      insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
        values ('${REVOGADO}', '${ORG_VIZINHA}', 'admin', now(), now()) on conflict do nothing;
    `);
    expect(recusa(NOMES, ORG_VIZINHA, REVOGADO, nomes)).toContain("nomes_da_barra_sem_permissao");
  });

  it("admin da organização grava (row_count 1) e platform admin sem vínculo também", () => {
    expect(chamar(NOMES, ORG, ADMIN, nomes)).toBe(1);
    expect(JSON.parse(nomesDa())).toEqual({ "/app/inbox": "Atendimento", "grupo:ia": "Robôs" });
    expect(chamar(NOMES, ORG, PLATFORM, `'{"/app/leads":"Clientes"}'::jsonb`)).toBe(1);
    expect(JSON.parse(nomesDa())).toEqual({ "/app/leads": "Clientes" });
  });

  it("a gravação SUBSTITUI o mapa (não é merge): restaurar um nome é mandar o mapa sem ele", () => {
    chamar(NOMES, ORG, ADMIN, nomes);
    chamar(NOMES, ORG, ADMIN, `'{"grupo:ia":"Robôs"}'::jsonb`);
    expect(JSON.parse(nomesDa())).toEqual({ "grupo:ia": "Robôs" });
  });

  it("apara os espaços, descarta nome vazio e aceita exatamente 40 caracteres", () => {
    const quarenta = "n".repeat(40);
    expect(
      chamar(
        NOMES,
        ORG,
        ADMIN,
        `'{"/app/inbox":"  Conversas  ","/app/leads":"   ","/app/tasks":"${quarenta}"}'::jsonb`,
      ),
    ).toBe(1);
    expect(JSON.parse(nomesDa())).toEqual({ "/app/inbox": "Conversas", "/app/tasks": quarenta });
  });

  it("recusa 41 caracteres, chave fora do formato, valor que não é texto e forma que não é objeto (22023)", () => {
    expect(recusa(NOMES, ORG, ADMIN, `'{"/app/inbox":"${"n".repeat(41)}"}'::jsonb`)).toContain(
      "nomes_da_barra_nome_longo",
    );
    expect(recusa(NOMES, ORG, ADMIN, `'{"inbox":"Ok"}'::jsonb`)).toContain(
      "nomes_da_barra_chave_invalida",
    );
    expect(recusa(NOMES, ORG, ADMIN, `'{"/APP/inbox":"Ok"}'::jsonb`)).toContain(
      "nomes_da_barra_chave_invalida",
    );
    expect(recusa(NOMES, ORG, ADMIN, `'{"/app/inbox":5}'::jsonb`)).toContain(
      "nomes_da_barra_valor_nao_e_texto",
    );
    expect(recusa(NOMES, ORG, ADMIN, `'["a"]'::jsonb`)).toContain("nomes_da_barra_forma_invalida");
  });

  it("uma gravação recusada não deixa nada pela metade", () => {
    chamar(NOMES, ORG, ADMIN, `'{"grupo:ia":"Robôs"}'::jsonb`);
    expect(
      recusa(NOMES, ORG, ADMIN, `'{"/app/inbox":"Ok","/app/leads":"${"n".repeat(41)}"}'::jsonb`),
    ).not.toBeNull();
    expect(JSON.parse(nomesDa())).toEqual({ "grupo:ia": "Robôs" });
  });

  it("NULL e o jsonb 'null' devolvem todos os nomes ao padrão", () => {
    chamar(NOMES, ORG, ADMIN, nomes);
    expect(chamar(NOMES, ORG, ADMIN, "null")).toBe(1);
    expect(nomesDa()).toBe("{}");
    chamar(NOMES, ORG, ADMIN, nomes);
    expect(chamar(NOMES, ORG, ADMIN, "'null'::jsonb")).toBe(1);
    expect(nomesDa()).toBe("{}");
  });

  it("a gravação em uma organização não vaza para a vizinha", () => {
    chamar(NOMES, ORG, ADMIN, nomes);
    expect(nomesDa(ORG_VIZINHA)).toBe("{}");
  });

  it("organização que não existe: platform admin recebe 0 linhas", () => {
    expect(chamar(NOMES, "ba2a0261-0000-4000-8000-0000000000ff", PLATFORM, nomes)).toBe(0);
  });
});

describe("organizations_nomes_da_barra_forma — escrita DIRETA, sem passar por função", () => {
  const direto = (json: string) =>
    erroDe(`update public.organizations set nomes_da_barra = ${json}::jsonb where id='${ORG}';`);

  it("aceita um mapa de nomes até 40 caracteres", () => {
    expect(direto(`'{"/app/inbox":"Atendimento"}'`)).toBeNull();
    expect(direto(`'{"/app/inbox":"${"n".repeat(40)}"}'`)).toBeNull();
    expect(direto(`'{}'`)).toBeNull();
  });

  it("⭐ recusa lista e objeto como valor, inclusive vazios (o jsonpath em modo `lax` desembrulharia a lista)", () => {
    for (const ruim of [
      `'{"/app/inbox":["a"]}'`,
      `'{"/app/inbox":[]}'`,
      `'{"/app/inbox":[["a"]]}'`,
      `'{"/app/inbox":{}}'`,
      `'{"/app/inbox":{"a":"b"}}'`,
    ]) {
      expect(direto(ruim), ruim).toContain("organizations_nomes_da_barra_forma");
    }
  });

  it("recusa o que não é objeto, valor que não é texto, 41 caracteres e nome em branco", () => {
    for (const ruim of [
      `'[]'`,
      `'"x"'`,
      `'{"/app/inbox":1}'`,
      `'{"/app/inbox":["a"]}'`,
      `'{"/app/inbox":"${"n".repeat(41)}"}'`,
      `'{"/app/inbox":"   "}'`,
      `'{"/app/inbox":""}'`,
    ]) {
      expect(direto(ruim), ruim).toContain("organizations_nomes_da_barra_forma");
    }
  });
});

describe("EXECUTE — só service_role", () => {
  it("⭐ anon e authenticated não executam nenhuma das duas; service_role executa as duas", () => {
    for (const fn of [MINHA, NOMES]) {
      const privilegio = (papel: string) =>
        consulta(`select has_function_privilege('${papel}', '${fn}', 'EXECUTE');`);
      expect(privilegio("anon"), `${fn} anon`).toBe("f");
      expect(privilegio("authenticated"), `${fn} authenticated`).toBe("f");
      expect(privilegio("service_role"), `${fn} service_role`).toBe("t");
    }
  });

  it("são SECURITY DEFINER com search_path fixo (a varredura global confere o resto)", () => {
    for (const nome of ["fn_definir_minha_barra", "fn_definir_nomes_da_barra"]) {
      expect(
        consulta(
          `select prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname='${nome}' and pronamespace='public'::regnamespace;`,
        ),
      ).toBe("true:search_path=public, pg_temp");
    }
  });
});
