-- 0244 — desempenho do inbox: RLS avaliada uma vez por consulta, não por linha.
--
-- ## O que estava lento (medido em 26/10/2026, uma organização com 438 conversas, como
-- `authenticated`, EXPLAIN ANALYZE dentro de BEGIN/ROLLBACK)
--
-- 1. `comando_da_conversa(conversations)` — o campo calculado que as abas Fila e
--    Automático filtram — fazia DUAS subconsultas em `contacts` por conversa, cada
--    uma passando pela RLS de `contacts`. Dentro de uma função SQL não inlinada, o
--    `IN (select fn_user_org_ids())` da policy é refeito A CADA CHAMADA, e
--    `fn_user_org_ids()` chama `fn_support_context()` (junção de 4 tabelas). A
--    contagem da Fila levava ~1,3 s; sem RLS, ~64 ms.
-- 2. `conversations_select` chamava `fn_can_view_conversation(org, dono)` por
--    linha (SECURITY DEFINER, nunca inlinada; por dentro, platform admin + papel na
--    org duas vezes). `count(*)` simples da org: ~680 ms.
-- 3. `message_templates_write` era `FOR ALL`, então entrava também no SELECT e
--    chamava `fn_role_at_least(org, …)` por linha: 120 linhas em ~680 ms.
--
-- ## O que muda — e o que NÃO muda
--
-- Nenhuma regra de visibilidade muda. Cada policy reescrita é EQUIVALENTE à
-- anterior; o que muda é a forma: as funções passam a ser chamadas como
-- `(select …)` / `IN (select …)` sem argumento da linha, e o Postgres as avalia
-- UMA vez por consulta (initplan / subplan com hash). Para isso nascem três
-- helpers que devolvem CONJUNTOS de orgs em vez de responder linha a linha:
--
--   fn_orgs_com_papel_minimo(p)      orgs onde `fn_role_at_least(org, p)`
--   fn_conversa_orgs_visao_total()   orgs onde o usuário vê TODA conversa
--   fn_conversa_orgs_ve_sem_dono()   orgs em modo own_and_unassigned
--
-- Por que equivalem: `fn_user_role_in_org(org)` só é não-nulo para org que está
-- em `fn_user_org_ids()` (as duas leem as mesmas fontes: vínculo não revogado em
-- `user_organizations` e a sessão de suporte ativa). Então "papel ≥ p na org da
-- linha" é o mesmo que "org da linha ∈ {orgs do usuário com papel ≥ p}".
--
-- `comando_da_conversa` vira SECURITY DEFINER com UMA leitura de `contacts`. Ela
-- foi escrita invoker para respeitar a RLS de quem pergunta; agora a RLS de
-- `contacts` é ESPELHADA dentro dela, na mesma ordem de custo: vínculo direto
-- (uma busca de índice), quem ignora RLS (service_role, superusuário — como a
-- policy já fazia, porque eles têm BYPASSRLS), platform admin e, por último, a
-- sessão de suporte (`fn_user_org_ids()`). Sem o espelho, a função seria um
-- oráculo: chamada como RPC com uma linha forjada, diria se o contato de outra
-- org está bloqueado.
--
-- Os 4 contadores do inbox viram UMA consulta (`fn_contagem_inbox`, invoker:
-- herda a RLS de quem pergunta, como o `count=exact` que substitui).

-- ---------------------------------------------------------------------------
-- Helpers de conjunto
-- ---------------------------------------------------------------------------
create or replace function public.fn_orgs_com_papel_minimo(p_min text)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select o from public.fn_user_org_ids() o where public.fn_role_at_least(o, p_min);
$fn$;

comment on function public.fn_orgs_com_papel_minimo(text)
  is 'Orgs do usuário corrente em que o papel é ≥ p_min. Forma de conjunto de fn_role_at_least, para policy em initplan: organization_id IN (select fn_orgs_com_papel_minimo(''agent'')). Migration 0244.';

create or replace function public.fn_conversa_orgs_visao_total()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select o from public.fn_user_org_ids() o
  where public.fn_user_role_in_org(o) in ('viewer', 'manager', 'admin')
     or coalesce(
          (select settings->>'visibility_mode' from public.organizations where id = o),
          'own_and_unassigned') = 'all';
$fn$;

comment on function public.fn_conversa_orgs_visao_total()
  is 'Orgs em que o usuário vê TODA conversa (papel viewer/manager/admin, ou visibility_mode=all). Ramo 1 de fn_can_view_conversation em forma de conjunto. Migration 0244.';

create or replace function public.fn_conversa_orgs_ve_sem_dono()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select o from public.fn_user_org_ids() o
  where coalesce(
          (select settings->>'visibility_mode' from public.organizations where id = o),
          'own_and_unassigned') = 'own_and_unassigned';
$fn$;

comment on function public.fn_conversa_orgs_ve_sem_dono()
  is 'Orgs em modo own_and_unassigned: o usuário vê também as conversas sem dono. Ramo final de fn_can_view_conversation em forma de conjunto. Migration 0244.';

revoke execute on function public.fn_orgs_com_papel_minimo(text) from public, anon;
revoke execute on function public.fn_conversa_orgs_visao_total() from public, anon;
revoke execute on function public.fn_conversa_orgs_ve_sem_dono() from public, anon;
grant  execute on function public.fn_orgs_com_papel_minimo(text) to authenticated, service_role;
grant  execute on function public.fn_conversa_orgs_visao_total() to authenticated, service_role;
grant  execute on function public.fn_conversa_orgs_ve_sem_dono() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- conversations: SELECT equivalente a fn_can_view_conversation, em initplan
-- ---------------------------------------------------------------------------
drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations
  for select
  using (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_conversa_orgs_visao_total())
    or (assigned_to_user_id = (select auth.uid())
        and organization_id in (select public.fn_user_org_ids()))
    or (assigned_to_user_id is null
        and organization_id in (select public.fn_conversa_orgs_ve_sem_dono()))
  );

drop policy if exists conversations_agent_insert on public.conversations;
create policy conversations_agent_insert on public.conversations
  for insert
  with check (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
  );

drop policy if exists conversations_agent_update on public.conversations;
create policy conversations_agent_update on public.conversations
  for update
  using (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
  )
  with check (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
  );

drop policy if exists conversations_agent_delete on public.conversations;
create policy conversations_agent_delete on public.conversations
  for delete
  using (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
  );

-- ---------------------------------------------------------------------------
-- contacts: mesma regra, platform admin em initplan
-- ---------------------------------------------------------------------------
drop policy if exists tenant_isolation_contacts_all on public.contacts;
create policy tenant_isolation_contacts_all on public.contacts
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    or (select public.fn_is_platform_admin())
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    or (select public.fn_is_platform_admin())
  );

-- ---------------------------------------------------------------------------
-- message_templates: a escrita sai do SELECT (era FOR ALL)
-- ---------------------------------------------------------------------------
drop policy if exists message_templates_select on public.message_templates;
create policy message_templates_select on public.message_templates
  for select
  using (
    (organization_id in (select public.fn_user_org_ids())
     and (owner_user_id is null or owner_user_id = (select auth.uid())))
    or (select public.fn_is_platform_admin())
  );

-- A regra de escrita é a de antes (dono agent+ edita o seu; manager+ edita o
-- compartilhado), dividida por comando para não entrar na leitura.
drop policy if exists message_templates_write on public.message_templates;
drop policy if exists message_templates_insert on public.message_templates;
create policy message_templates_insert on public.message_templates
  for insert
  with check (
    organization_id in (select public.fn_user_org_ids())
    and ((owner_user_id = (select auth.uid())
          and organization_id in (select public.fn_orgs_com_papel_minimo('agent')))
      or (owner_user_id is null
          and organization_id in (select public.fn_orgs_com_papel_minimo('manager'))))
  );

drop policy if exists message_templates_update on public.message_templates;
create policy message_templates_update on public.message_templates
  for update
  using (
    organization_id in (select public.fn_user_org_ids())
    and ((owner_user_id = (select auth.uid())
          and organization_id in (select public.fn_orgs_com_papel_minimo('agent')))
      or (owner_user_id is null
          and organization_id in (select public.fn_orgs_com_papel_minimo('manager'))))
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and ((owner_user_id = (select auth.uid())
          and organization_id in (select public.fn_orgs_com_papel_minimo('agent')))
      or (owner_user_id is null
          and organization_id in (select public.fn_orgs_com_papel_minimo('manager'))))
  );

drop policy if exists message_templates_delete on public.message_templates;
create policy message_templates_delete on public.message_templates
  for delete
  using (
    organization_id in (select public.fn_user_org_ids())
    and ((owner_user_id = (select auth.uid())
          and organization_id in (select public.fn_orgs_com_papel_minimo('agent')))
      or (owner_user_id is null
          and organization_id in (select public.fn_orgs_com_papel_minimo('manager'))))
  );

-- ---------------------------------------------------------------------------
-- comando_da_conversa: uma leitura de contacts, RLS de contacts espelhada
-- ---------------------------------------------------------------------------
create or replace function public.comando_da_conversa(c public.conversations)
returns text
language sql
stable
security definer
set search_path = public
as $comando$
  select public.fn_comando_da_conversa(
    c.status,
    c.assigned_to_user_id,
    c.bot_silenced_until,
    -- `coalesce` porque `contact_id` é anulável no schema: contato ausente não pode
    -- virar `null` e derrubar a linha inteira para fora de todo filtro.
    coalesce(ct.force_human, false),
    coalesce(ct.is_blocked, false),
    now()
  )
  from (select 1) as uma_linha
  left join lateral (
    select x.force_human, x.is_blocked
    from public.contacts x
    where x.id = c.contact_id
      -- Espelho da policy tenant_isolation_contacts_all, do ramo mais barato ao
      -- mais caro (o OR para no primeiro verdadeiro):
      and (
        exists (select 1 from public.user_organizations uo
                where uo.user_id = auth.uid()
                  and uo.organization_id = x.organization_id
                  and uo.revoked_at is null)
        -- quem já ignorava a RLS (service_role, superusuário) continua ignorando
        or exists (select 1 from pg_catalog.pg_roles r
                   where r.rolname = coalesce(nullif(current_setting('role', true), 'none'), session_user)
                     and (r.rolbypassrls or r.rolsuper))
        or public.fn_is_platform_admin()
        or x.organization_id in (select public.fn_user_org_ids())
      )
  ) ct on true;
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). SECURITY DEFINER desde a 0244, com a RLS de contacts espelhada no corpo (uma leitura de contacts por linha em vez de duas com RLS refeita). A regra em si é fn_comando_da_conversa.';

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Os 4 contadores do inbox numa consulta só
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER de propósito: a contagem herda a RLS de SELECT de
-- `conversations` de quem pergunta — um agent em modo own* conta o SEU escopo,
-- nunca o total da org (a mesma garantia do count=exact que esta função
-- substitui). Os conjuntos (comandos da fila, status terminais) vêm do TypeScript
-- como parâmetro, para não haver segunda cópia deles no SQL.
create or replace function public.fn_contagem_inbox(
  p_org             uuid,
  p_comandos_fila   text[],
  p_terminais       text[]
)
returns table (fila bigint, automatico bigint, mine bigint, total bigint)
language sql
stable
security invoker
set search_path = public
as $fn$
  select
    count(*) filter (where k.comando = any(p_comandos_fila)),
    count(*) filter (where k.comando = 'automatico'),
    count(*) filter (where c.assigned_to_user_id = auth.uid()
                       and not (c.status = any(p_terminais))),
    count(*)
  from public.conversations c
  cross join lateral (select public.comando_da_conversa(c) as comando) k
  where c.organization_id = p_org;
$fn$;

comment on function public.fn_contagem_inbox(uuid, text[], text[])
  is 'Contadores do inbox (fila, automatico, mine, total) numa varredura só, sob a RLS de quem pergunta. Usada por GET /api/v1/conversations/counts. Migration 0244.';

revoke execute on function public.fn_contagem_inbox(uuid, text[], text[]) from public, anon;
grant  execute on function public.fn_contagem_inbox(uuid, text[], text[]) to authenticated, service_role;

notify pgrst, 'reload schema';
