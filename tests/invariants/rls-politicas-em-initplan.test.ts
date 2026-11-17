import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_LEAD,
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_STAGE,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * Migration 0247 — as policies de SELECT/ALL passam a chamar as funções de RLS
 * em initplan (`(select …)` / `IN (select …)`), uma vez por consulta e não uma
 * por linha. A migration promete que NENHUMA regra de visibilidade mudou; este
 * arquivo cobra as duas metades:
 *
 *  1. a forma: nenhuma policy volta a chamar `auth.uid()`,
 *     `fn_is_platform_admin()`, `fn_role_at_least()` ou `fn_can_view_*()` sem o
 *     `select` em volta (sem isso o ganho some em silêncio — eram ~8 ms por
 *     linha medidos em `crm_lead_activities`);
 *  2. o comportamento: isolamento entre organizações e a matriz de papéis de
 *     leads (dono, sem dono, visibility_mode) nas tabelas reescritas.
 */

// Fixture própria (namespace eeeeeeee) — org B só para provar não-vazamento.
const ORG_B = "eeeeeeee-0000-4000-8000-000000000002";
const USER_B = "eeeeeeee-1111-4000-8000-000000000002";
const PIPE_B = "eeeeeeee-5555-4000-8000-000000000001";
const STAGE_B = "eeeeeeee-5555-4000-8000-000000000002";
const LEAD_B = "eeeeeeee-6666-4000-8000-000000000001";
const LEAD_DO_AGENTE_A = "eeeeeeee-6666-4000-8000-000000000002";
const LEAD_DO_AGENTE_B = "eeeeeeee-6666-4000-8000-000000000003";
const ACT_A = "eeeeeeee-7777-4000-8000-000000000001";
const ACT_B = "eeeeeeee-7777-4000-8000-000000000002";
const ACT_DO_AGENTE_B = "eeeeeeee-7777-4000-8000-000000000003";

function seed(): void {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${USER_B}', 'rls-initplan-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'rls-initplan-b', 'RLS Initplan B', 'RLS Initplan B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPE_B}', '${ORG_B}', 'Initplan B', 'initplan-b') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_B}', '${ORG_B}', '${PIPE_B}', 'Novo', 'novo', 1000) on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id)
      values ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${STAGE_B}', 'lead B', null),
             ('${LEAD_DO_AGENTE_A}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'lead do agente A', '${GOV_AGENT_A}'),
             ('${LEAD_DO_AGENTE_B}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'lead do agente B', '${GOV_AGENT_B}')
      on conflict do nothing;
    insert into public.crm_lead_activities (id, organization_id, lead_id, source_module, type)
      values ('${ACT_A}', '${GOV_ORG}', '${GOV_LEAD}', 'rls-initplan', 'note'),
             ('${ACT_B}', '${ORG_B}', '${LEAD_B}', 'rls-initplan', 'note'),
             ('${ACT_DO_AGENTE_B}', '${GOV_ORG}', '${LEAD_DO_AGENTE_B}', 'rls-initplan', 'note')
      on conflict do nothing;
    insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
      select '${GOV_ORG}', '${GOV_LEAD}', 'lead', '${LEAD_DO_AGENTE_B}', 'rls-initplan'
      where not exists (select 1 from public.crm_lead_links where organization_id = '${GOV_ORG}' and link_kind = 'rls-initplan');
    insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
      select '${ORG_B}', '${LEAD_B}', 'lead', '${LEAD_B}', 'rls-initplan'
      where not exists (select 1 from public.crm_lead_links where organization_id = '${ORG_B}' and link_kind = 'rls-initplan');
  `);
}

function modo(valor: "all" | "own_and_unassigned" | "own"): void {
  sql(`update public.organizations
         set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('visibility_mode', '${valor}')
       where id = '${GOV_ORG}';`);
}

const leadsDe = (user: string) =>
  countAs(
    user,
    `select count(*) from public.crm_leads
      where id in ('${GOV_LEAD}', '${LEAD_DO_AGENTE_A}', '${LEAD_DO_AGENTE_B}');`,
  );
const atividadesDe = (user: string) =>
  countAs(
    user,
    `select count(*) from public.crm_lead_activities
      where id in ('${ACT_A}', '${ACT_DO_AGENTE_B}');`,
  );

beforeAll(seed);

const CHAMADA_POR_LINHA = /(auth\.uid\(\)|fn_is_platform_admin\(\)|fn_role_at_least\(|fn_can_view_[a-z]+\()/;

describe("0247 — forma: nenhuma policy de leitura chama função por linha", () => {
  it("auth.uid(), fn_is_platform_admin(), fn_role_at_least() e fn_can_view_*() só aparecem dentro de (select …)", () => {
    // As policies `support_write_*` (fn_support_write_allowed) são de escrita de
    // acompanhamento de suporte e ficam fora do escopo da 0247, de propósito.
    const linhas = sql(`
      select tablename || '.' || policyname || ' :: ' ||
             regexp_replace(coalesce(qual, '') || ' ## ' || coalesce(with_check, ''), '\\s+', ' ', 'g')
      from pg_policies
      where schemaname = 'public'
        and policyname not like 'support\\_write\\_%'
      order by 1;
    `);
    const culpadas = linhas
      .split("\n")
      .filter(Boolean)
      .filter((l) => {
        // Tira as formas em initplan que o pg_get_expr devolve; o que sobrar é chamada por linha.
        const resto = l
          .replace(/\(\s*SELECT (?:auth\.uid\(\)|fn_is_platform_admin\(\)) AS \w+\)/g, "")
          .replace(/\(\s*SELECT fn_[a-z_]+\([^)]*\) AS \w+\)/g, "");
        return CHAMADA_POR_LINHA.test(resto);
      })
      .map((l) => l.split(" :: ")[0]);
    expect(culpadas, `policies chamando função por linha:\n${culpadas.join("\n")}`).toEqual([]);
  });

  it("o índice duplicado idx_messages_external_lookup saiu e o único cobre a busca", () => {
    const indices = sql(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'messages';`,
    );
    expect(indices).not.toContain("idx_messages_external_lookup");
    expect(indices).toContain("messages_org_external_id_unique");
  });
});

describe("0247 — isolamento entre organizações nas tabelas reescritas", () => {
  const casos: Array<[string, string]> = [
    ["crm_leads", LEAD_B],
    ["crm_lead_activities", ACT_B],
    ["crm_pipelines", PIPE_B],
    ["crm_stages", STAGE_B],
  ];

  for (const [tabela, idDaOrgB] of casos) {
    it(`admin da org A não lê ${tabela} da org B`, () => {
      expect(
        countAs(GOV_ADMIN, `select count(*) from public.${tabela} where id = '${idDaOrgB}';`),
      ).toBe(0);
    });
    it(`admin da org B lê o próprio registro em ${tabela} (controle positivo)`, () => {
      expect(
        countAs(USER_B, `select count(*) from public.${tabela} where id = '${idDaOrgB}';`),
      ).toBe(1);
    });
  }

  it("crm_lead_links: A não lê o vínculo de B e lê o seu", () => {
    expect(
      countAs(GOV_ADMIN, `select count(*) from public.crm_lead_links where organization_id = '${ORG_B}';`),
    ).toBe(0);
    expect(
      countAs(
        GOV_ADMIN,
        `select count(*) from public.crm_lead_links where organization_id = '${GOV_ORG}' and link_kind = 'rls-initplan';`,
      ),
    ).toBe(1);
  });

  it("user_organizations: admin de B não lê os vínculos da org A", () => {
    expect(
      countAs(USER_B, `select count(*) from public.user_organizations where organization_id = '${GOV_ORG}';`),
    ).toBe(0);
  });
});

describe("0247 — matriz de papéis em leads e atividades (fn_can_view_lead em initplan)", () => {
  it("own_and_unassigned: agent vê o lead sem dono e o seu, não o de outro agent", () => {
    modo("own_and_unassigned");
    expect(leadsDe(GOV_AGENT_A)).toBe(2);
    expect(leadsDe(GOV_AGENT_B)).toBe(2);
    // A atividade herda a visibilidade do lead: A vê a do lead sem dono, não a do lead do agent B.
    expect(atividadesDe(GOV_AGENT_A)).toBe(1);
    expect(atividadesDe(GOV_AGENT_B)).toBe(2);
  });

  it("own: agent vê só o seu", () => {
    modo("own");
    try {
      expect(leadsDe(GOV_AGENT_A)).toBe(1);
      expect(leadsDe(GOV_AGENT_B)).toBe(1);
      expect(atividadesDe(GOV_AGENT_A)).toBe(0);
      expect(atividadesDe(GOV_AGENT_B)).toBe(1);
    } finally {
      modo("own_and_unassigned");
    }
  });

  it("all: agent vê tudo da própria org", () => {
    modo("all");
    try {
      expect(leadsDe(GOV_AGENT_A)).toBe(3);
      expect(atividadesDe(GOV_AGENT_A)).toBe(2);
    } finally {
      modo("own_and_unassigned");
    }
  });

  it("viewer, manager e admin veem todos os leads da org, em qualquer modo", () => {
    modo("own");
    try {
      for (const u of [GOV_VIEWER, GOV_MANAGER, GOV_ADMIN]) {
        expect(leadsDe(u)).toBe(3);
        expect(atividadesDe(u)).toBe(2);
      }
    } finally {
      modo("own_and_unassigned");
    }
  });

  it("agent da org A não enxerga lead nem atividade da org B", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_B}';`)).toBe(0);
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_lead_activities where id = '${ACT_B}';`)).toBe(0);
  });
});
