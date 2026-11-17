-- 0256 — agentes externos na equipe: OpenBot, Claude Code, Codex e afins.
--
-- Um agente externo é um MEMBRO da equipe que entra pelo MCP (`/api/mcp`), não pela tela. Ele não é linha de
-- `auth.users`: quem o autentica é um token próprio de `api_tokens` (escopos `actor:ai_agent`, `role:<papel>`,
-- `mcp:read`, `mcp:write`), e esta tabela é o que dá NOME, papel, chave do motor e presença a esse token.
--
--  · `papel` vira o escopo `role:<papel>` do token: o MCP decide por ele (`ensureRole`). Padrão `admin` (decisão
--    do dono em 13/11/2026: o agente principal opera o CRM inteiro, menos fechar venda).
--  · `pode_motor` liga/desliga as ferramentas do motor de disparo para ESTE agente, sem mexer no papel.
--  · `ultimo_uso_em` / `ultima_acao`: presença ("Equipe agora" mostra online < 5 min). `ultima_acao` é o NOME da
--    ferramenta, nunca dado pessoal. No máximo uma escrita a cada 30 s por agente: quem garante é a função
--    `fn_marcar_uso_do_agente_externo` (o UPDATE só casa se a última marca tem mais de 30 s), não a memória do
--    processo — com duas réplicas do app, a trava em memória sozinha deixaria passar o dobro.
--  · Revogar o agente revoga o token NA HORA (a rota grava `api_tokens.revoked_at` antes de `revogado_em`). A linha
--    fica: a auditoria aponta para ela, e o histórico precisa do nome de quem agiu.
--
-- Mais duas peças do mesmo laço:
--  · `crm_tasks.agente_externo_id`: tarefa PARA um agente (o evento `tarefa.criada_para_agente`). `set null`: revogar
--    ou apagar o agente não apaga o que a equipe escreveu.
--  · `conversa_esperas_avisadas`: a trava de "uma vez por conversa por espera" do evento `conversa.esperando`. A
--    espera é identificada pelo `last_inbound_at` que a abriu; a chave primária `(conversation_id, desde)` faz o
--    segundo aviso da mesma espera morrer no 23505, mesmo com duas rodadas do cron ao mesmo tempo.
--
-- RLS por organização nas duas tabelas novas. `external_agents`: membro lê (a barra "Equipe agora" é agent+),
-- só admin escreve. `conversa_esperas_avisadas`: membro lê, ninguém escreve pelo PostgREST (só o service_role do cron).

create table if not exists public.external_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  tipo text not null default 'outro',
  avatar_url text,
  papel text not null default 'admin',
  pode_motor boolean not null default true,
  api_token_id uuid references public.api_tokens(id) on delete set null,
  ultimo_uso_em timestamptz,
  ultima_acao text,
  created_by uuid references auth.users(id) on delete set null,
  revogado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_agents_nome_nao_vazio check (length(btrim(nome)) between 1 and 120),
  constraint external_agents_tipo_check check (tipo in ('openbot', 'claude_code', 'codex', 'outro')),
  constraint external_agents_papel_check check (papel in ('agent', 'manager', 'admin')),
  constraint external_agents_ultima_acao_curta check (ultima_acao is null or length(ultima_acao) <= 120),
  constraint external_agents_org_nome_key unique (organization_id, nome),
  -- Alvo da FK composta de crm_tasks: a tarefa só aponta para agente da MESMA organização.
  constraint external_agents_org_id_key unique (organization_id, id)
);

-- Um token, um agente: é por ele que o MCP acha quem está chamando.
create unique index if not exists external_agents_api_token_key
  on public.external_agents (api_token_id) where api_token_id is not null;

alter table public.external_agents enable row level security;

drop policy if exists external_agents_select on public.external_agents;
create policy external_agents_select on public.external_agents
  for select using ((organization_id in (select public.fn_user_org_ids())) or (select public.fn_is_platform_admin()));

drop policy if exists external_agents_insert on public.external_agents;
create policy external_agents_insert on public.external_agents
  for insert
  with check ((organization_id in (select public.fn_user_org_ids())) and (organization_id in (select public.fn_orgs_com_papel_minimo('admin'))));

drop policy if exists external_agents_update on public.external_agents;
create policy external_agents_update on public.external_agents
  for update
  using ((organization_id in (select public.fn_user_org_ids())) and (organization_id in (select public.fn_orgs_com_papel_minimo('admin'))))
  with check ((organization_id in (select public.fn_user_org_ids())) and (organization_id in (select public.fn_orgs_com_papel_minimo('admin'))));

drop policy if exists external_agents_delete on public.external_agents;
create policy external_agents_delete on public.external_agents
  for delete
  using ((organization_id in (select public.fn_user_org_ids())) and (organization_id in (select public.fn_orgs_com_papel_minimo('admin'))));

revoke all on public.external_agents from anon;
grant select, insert, update, delete on public.external_agents to authenticated;
grant all on public.external_agents to service_role;

drop trigger if exists trg_external_agents_updated_at on public.external_agents;
create trigger trg_external_agents_updated_at
  before update of nome, tipo, avatar_url, papel, pode_motor, api_token_id, revogado_em on public.external_agents
  for each row execute function public.fn_set_updated_at();

comment on table public.external_agents is
  'Agente externo na equipe (OpenBot, Claude Code, Codex): entra pelo MCP com token próprio de api_tokens. Revogar revoga o token na hora; a linha fica para a auditoria (0256).';
comment on column public.external_agents.ultima_acao is
  'Nome da última ferramenta MCP chamada (nunca dado pessoal). Gravado no máximo a cada 30 s por fn_marcar_uso_do_agente_externo.';

-- Tarefa para um agente externo. FK COMPOSTA (organization_id, agente_externo_id): uma tarefa nunca aponta para o
-- agente de outra organização, nem por engano do código. `set null (agente_externo_id)` (pg15+) solta só a coluna do
-- agente — um `set null` sem lista tentaria anular também organization_id, que é not null.
alter table public.crm_tasks add column if not exists agente_externo_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_tasks_agente_externo_fk') then
    alter table public.crm_tasks
      add constraint crm_tasks_agente_externo_fk
      foreign key (organization_id, agente_externo_id)
      references public.external_agents (organization_id, id)
      on delete set null (agente_externo_id);
  end if;
end $$;
create index if not exists crm_tasks_agente_externo_idx
  on public.crm_tasks (agente_externo_id) where agente_externo_id is not null;
comment on column public.crm_tasks.agente_externo_id is
  'Tarefa PARA um agente externo (evento tarefa.criada_para_agente). FK composta com organization_id; set null só desta coluna: apagar o agente não apaga a tarefa (0256).';

-- A trava de "uma vez por conversa por espera" do evento conversa.esperando.
create table if not exists public.conversa_esperas_avisadas (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  desde timestamptz not null,
  avisado_em timestamptz not null default now(),
  primary key (conversation_id, desde)
);
create index if not exists conversa_esperas_avisadas_org_idx
  on public.conversa_esperas_avisadas (organization_id, avisado_em);

alter table public.conversa_esperas_avisadas enable row level security;

drop policy if exists conversa_esperas_avisadas_select on public.conversa_esperas_avisadas;
create policy conversa_esperas_avisadas_select on public.conversa_esperas_avisadas
  for select using ((organization_id in (select public.fn_user_org_ids())) or (select public.fn_is_platform_admin()));

revoke all on public.conversa_esperas_avisadas from anon;
revoke insert, update, delete on public.conversa_esperas_avisadas from authenticated;
grant select on public.conversa_esperas_avisadas to authenticated;
grant all on public.conversa_esperas_avisadas to service_role;

comment on table public.conversa_esperas_avisadas is
  'Uma linha por espera avisada (conversa + last_inbound_at que a abriu). A PK faz o evento conversa.esperando sair uma vez por espera. O cron data-retention apaga as de mais de 30 dias (0256).';

-- Presença: no máximo uma marca a cada 30 s por agente, decidida no banco.
create or replace function public.fn_marcar_uso_do_agente_externo(p_api_token_id uuid, p_acao text)
returns boolean
language sql
volatile
security invoker
set search_path = public
as $$
  with marcado as (
    update public.external_agents
       set ultimo_uso_em = now(),
           ultima_acao = left(p_acao, 120)
     where api_token_id = p_api_token_id
       and revogado_em is null
       and (ultimo_uso_em is null or ultimo_uso_em < now() - interval '30 seconds')
    returning 1
  )
  select exists (select 1 from marcado);
$$;

revoke execute on function public.fn_marcar_uso_do_agente_externo(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_marcar_uso_do_agente_externo(uuid, text) to service_role;

notify pgrst, 'reload schema';
