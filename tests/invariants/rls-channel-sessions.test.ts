import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * Migration 0253 — a escrita de `channel_sessions` deixa de ser uma política
 * FOR ALL e vira uma por comando (insert/update/delete), com o MESMO predicado.
 * A migration promete que NENHUM papel ganha ou perde nada; este arquivo cobra
 * as duas metades:
 *
 *  1. a forma: nenhuma política FOR ALL na tabela, e as quatro políticas
 *     (select/insert/update/delete) existem com o comando certo;
 *  2. o comportamento: a matriz de papéis de antes — membro lê; só admin da
 *     organização e platform admin criam, alteram e apagam; outra organização
 *     não vê nem toca.
 *
 * Cada caso negativo tem o positivo ao lado (o papel de cima passa): um teste
 * só com a metade negativa fica verde se a política negar todo mundo.
 *
 * Fixture própria (namespace f5f5f5f5), com canais próprios: apagar o canal
 * GOV_SESSION derrubaria as conversas que os outros arquivos usam em paralelo.
 */

const ORG_B = "f5f5f5f5-0000-4000-8000-000000000002";
const ADMIN_B = "f5f5f5f5-1111-4000-8000-000000000001";
const PLATAFORMA = "f5f5f5f5-1111-4000-8000-000000000002";
const CANAL_A = "f5f5f5f5-2222-4000-8000-000000000001";
const CANAL_B = "f5f5f5f5-2222-4000-8000-000000000002";
const CANAL_PARA_APAGAR = "f5f5f5f5-2222-4000-8000-000000000003";
const CANAL_NOVO = "f5f5f5f5-2222-4000-8000-000000000004";

function canal(id: string, org: string): string {
  // DO + exception, como no seedGov: o unique de waha_session_name e o
  // phone_per_org (DEFERRABLE) não aceitam ON CONFLICT sem arbiter.
  return `do $s$ begin
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${id}', '${org}', 'rls-cs-${id}', '\\x00'::bytea);
  exception when unique_violation then null; end $s$;`;
}

function seed(): void {
  seedGov();
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_B}', 'rls-cs-admin-b@invariant.test'),
      ('${PLATAFORMA}', 'rls-cs-plataforma@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'rls-cs-b', 'RLS Canais B', 'RLS Canais B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${PLATAFORMA}', '${PLATAFORMA}', 'full', false, 'rls-channel-sessions')
      on conflict (user_id) do update set revoked_at = null, scope = 'full';
    ${canal(CANAL_A, GOV_ORG)}
    ${canal(CANAL_B, ORG_B)}
  `);
}

/** Recria o canal descartável que os casos de DELETE consomem. */
function canalParaApagar(): void {
  sql(canal(CANAL_PARA_APAGAR, GOV_ORG));
}

function inserirComo(userId: string, org: string): number {
  // Apaga antes (como superusuário) para o caso positivo não colidir consigo mesmo.
  sql(`delete from public.channel_sessions where id = '${CANAL_NOVO}';`);
  return writeCountAs(
    userId,
    `insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
       values ('${CANAL_NOVO}', '${org}', 'rls-cs-novo', '\\x00'::bytea)`,
  );
}

beforeAll(() => {
  seed();
});

describe("0253 — a forma: escrita por comando, nenhum FOR ALL", () => {
  it("channel_sessions não tem política FOR ALL", () => {
    const todas = sql(`
      select coalesce(string_agg(policyname, ','), '') from pg_policies
       where schemaname = 'public' and tablename = 'channel_sessions' and cmd = 'ALL';
    `);
    expect(todas.trim()).toBe("");
  });

  // Só as PERMISSIVAS: são elas que concedem acesso. As `support_write_*` que o baseline cria em toda
  // tabela tenant-aware são RESTRITIVAS (só estreitam a escrita durante o modo suporte) e não concedem nada.
  it("as quatro políticas existem, cada uma no seu comando", () => {
    const linhas = sql(`
      select policyname || ':' || cmd from pg_policies
       where schemaname = 'public' and tablename = 'channel_sessions'
         and permissive = 'PERMISSIVE'
       order by policyname;
    `)
      .split("\n")
      .filter(Boolean);
    expect(linhas).toEqual([
      "channel_sessions_tenant_delete:DELETE",
      "channel_sessions_tenant_insert:INSERT",
      "channel_sessions_tenant_select:SELECT",
      "channel_sessions_tenant_update:UPDATE",
    ]);
  });

  it("toda política de escrita exige admin (fn_orgs_com_papel_minimo('admin')) ou platform admin", () => {
    const semPapel = sql(`
      select coalesce(string_agg(policyname, ','), '') from pg_policies
       where schemaname = 'public' and tablename = 'channel_sessions'
         and permissive = 'PERMISSIVE'
         and cmd in ('INSERT', 'UPDATE', 'DELETE')
         and (coalesce(qual, '') || coalesce(with_check, '')) not like '%fn_orgs_com_papel_minimo(''admin''%';
    `);
    expect(semPapel.trim()).toBe("");
  });
});

describe("0253 — leitura: todo membro lê, outra organização não", () => {
  it.each([
    ["viewer", GOV_VIEWER],
    ["agent", GOV_AGENT_A],
    ["manager", GOV_MANAGER],
    ["admin", GOV_ADMIN],
  ])("%s lê o canal da própria organização", (_papel, userId) => {
    expect(
      countAs(userId, `select count(*) from public.channel_sessions where id = '${CANAL_A}';`),
    ).toBe(1);
  });

  it("admin de outra organização NÃO lê o canal", () => {
    expect(
      countAs(ADMIN_B, `select count(*) from public.channel_sessions where id = '${CANAL_A}';`),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: admin de outra organização lê o canal DELA", () => {
    expect(
      countAs(ADMIN_B, `select count(*) from public.channel_sessions where id = '${CANAL_B}';`),
    ).toBe(1);
  });

  it("platform admin lê canais das duas organizações", () => {
    expect(
      countAs(
        PLATAFORMA,
        `select count(*) from public.channel_sessions where id in ('${CANAL_A}', '${CANAL_B}');`,
      ),
    ).toBe(2);
  });
});

describe("0253 — alteração: só admin da organização e platform admin", () => {
  it.each([
    ["viewer", GOV_VIEWER],
    ["agent", GOV_AGENT_A],
    ["manager", GOV_MANAGER],
  ])("%s NÃO altera o canal", (_papel, userId) => {
    expect(
      writeCountAs(
        userId,
        `update public.channel_sessions set display_name = 'SEQUESTRADO' where id = '${CANAL_A}'`,
      ),
    ).toBe(0);
  });

  it("admin de outra organização NÃO altera o canal", () => {
    expect(
      writeCountAs(
        ADMIN_B,
        `update public.channel_sessions set display_name = 'SEQUESTRADO' where id = '${CANAL_A}'`,
      ),
    ).toBe(0);
  });

  it("admin NÃO move o canal para outra organização (with check)", () => {
    expect(
      writeCountAs(
        GOV_ADMIN,
        `update public.channel_sessions set organization_id = '${ORG_B}' where id = '${CANAL_A}'`,
      ),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: admin altera o canal da própria organização", () => {
    expect(
      writeCountAs(
        GOV_ADMIN,
        `update public.channel_sessions set display_name = 'Trocado pelo admin' where id = '${CANAL_A}'`,
      ),
    ).toBe(1);
  });

  it("CONTROLE POSITIVO: platform admin altera canal de qualquer organização", () => {
    expect(
      writeCountAs(
        PLATAFORMA,
        `update public.channel_sessions set display_name = 'Trocado pela plataforma' where id = '${CANAL_B}'`,
      ),
    ).toBe(1);
  });
});

describe("0253 — criação: só admin da organização e platform admin", () => {
  it.each([
    ["viewer", GOV_VIEWER],
    ["agent", GOV_AGENT_A],
    ["manager", GOV_MANAGER],
  ])("%s NÃO cria canal", (_papel, userId) => {
    expect(inserirComo(userId, GOV_ORG)).toBe(0);
  });

  it("admin NÃO cria canal em outra organização", () => {
    expect(inserirComo(GOV_ADMIN, ORG_B)).toBe(0);
  });

  it("CONTROLE POSITIVO: admin cria canal na própria organização", () => {
    expect(inserirComo(GOV_ADMIN, GOV_ORG)).toBe(1);
  });

  it("CONTROLE POSITIVO: platform admin cria canal em qualquer organização", () => {
    expect(inserirComo(PLATAFORMA, ORG_B)).toBe(1);
  });
});

describe("0253 — exclusão: só admin da organização e platform admin", () => {
  it.each([
    ["viewer", GOV_VIEWER],
    ["agent", GOV_AGENT_A],
    ["manager", GOV_MANAGER],
  ])("%s NÃO apaga canal", (_papel, userId) => {
    canalParaApagar();
    expect(
      writeCountAs(userId, `delete from public.channel_sessions where id = '${CANAL_PARA_APAGAR}'`),
    ).toBe(0);
  });

  it("admin de outra organização NÃO apaga o canal", () => {
    canalParaApagar();
    expect(
      writeCountAs(ADMIN_B, `delete from public.channel_sessions where id = '${CANAL_PARA_APAGAR}'`),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: admin apaga canal da própria organização", () => {
    canalParaApagar();
    expect(
      writeCountAs(GOV_ADMIN, `delete from public.channel_sessions where id = '${CANAL_PARA_APAGAR}'`),
    ).toBe(1);
  });

  it("CONTROLE POSITIVO: platform admin apaga canal de qualquer organização", () => {
    canalParaApagar();
    expect(
      writeCountAs(PLATAFORMA, `delete from public.channel_sessions where id = '${CANAL_PARA_APAGAR}'`),
    ).toBe(1);
  });
});
