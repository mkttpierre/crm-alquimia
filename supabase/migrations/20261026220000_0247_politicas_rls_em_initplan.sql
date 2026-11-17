-- 0247 — RLS avaliada uma vez por consulta nas demais tabelas que a interface lê
-- (continuação da 0244, que cuidou de conversations, contacts e message_templates).
--
-- ## O que estava lento (medido numa instalação real, como `authenticated`, EXPLAIN
-- ANALYZE dentro de BEGIN/ROLLBACK, `count(*)` da tabela inteira)
--
-- Usuário admin de uma organização que NÃO é platform admin (o caso do cliente final), melhor de 3,
-- antes e depois na MESMA transação:
--
--   tabela                  linhas      antes        depois
--   crm_lead_activities    ~8 mil    13.838 ms       9,5 ms   (1ª medição: 70.698 ms)
--   crm_leads              ~2 mil     6.021 ms       4,6 ms   (1ª medição: 16.210 ms)
--   api_audit_log             ~600     2.535 ms       6,0 ms
--   webhook_events_log   ~120 mil     1.513 ms      71,5 ms
--   catalog_products          ~10        46 ms       5,2 ms
--   channel_sessions        poucas        23 ms       6,4 ms
--
-- Platform admin (o operador): webhook_events_log 1.472 -> 58,8 ms,
-- crm_lead_activities 384 -> 3,5 ms, crm_leads 190 -> 1,0 ms, channel_sessions
-- 38 -> 13 ms, messages 24 -> 0,6 ms. (Os tempos variam com a carga do banco
-- vivo; a ordem de grandeza não.)
--
-- A causa é a mesma da 0244: a policy chama a função COM O ARGUMENTO DA LINHA —
-- `fn_can_view_lead(organization_id, owner_user_id)`,
-- `fn_role_at_least(organization_id, 'manager')`, `auth.uid()`,
-- `fn_is_platform_admin()` sem `select` em volta — e o Postgres a reexecuta a cada
-- linha. São funções SECURITY DEFINER (nunca inlinadas), e `fn_user_role_in_org`
-- chama `fn_support_context()` (junção de 4 tabelas) a cada chamada: ~8 ms por
-- linha. As políticas `*_write` (FOR ALL) pioram, porque entram também no SELECT.
--
-- ## O que muda — e o que NÃO muda
--
-- Nenhuma regra de visibilidade muda. Cada policy reescrita é EQUIVALENTE à
-- anterior; muda só a forma, pelas mesmas quatro regras mecânicas da 0244:
--
--   fn_is_platform_admin()                   -> (select fn_is_platform_admin())
--   auth.uid()                               -> (select auth.uid())
--   fn_role_at_least(org, 'x')               -> org IN (select fn_orgs_com_papel_minimo('x'))
--   fn_can_view_lead(org, dono)              -> mesma expansão de conversations_select da
--   fn_can_view_conversation(org, dono)         0244 (platform admin | org em
--                                               fn_conversa_orgs_visao_total() | dono = eu e
--                                               org minha | sem dono e org em
--                                               fn_conversa_orgs_ve_sem_dono())
--
-- `fn_can_view_lead` e `fn_can_view_conversation` têm corpo idêntico (conferido em
-- pg_get_functiondef), por isso as leads reaproveitam os helpers de conjunto da
-- 0244 — um terceiro par de helpers seria a mesma regra escrita duas vezes.
-- Por que `fn_role_at_least(org, p)` equivale a `org IN (fn_orgs_com_papel_minimo(p))`:
-- ver o cabeçalho da 0244 (o papel só é não-nulo para org que está em
-- `fn_user_org_ids()`). `org IS NULL` dá NULL em vez de false; como nenhuma dessas
-- expressões é negada, o filtro e o WITH CHECK tratam os dois do mesmo jeito.
--
-- Fora de escopo, de propósito: as policies `support_write_*` (INSERT/UPDATE/DELETE
-- de acompanhamento de suporte, `fn_support_write_allowed(org)`) não entram em
-- nenhum SELECT; ficam como estão.
--
-- Também sai o índice `idx_messages_external_lookup`: `(organization_id,
-- external_id) WHERE external_id IS NOT NULL` é coberto por inteiro pelo
-- `messages_org_external_id_unique (organization_id, external_id)` (a busca por
-- igualdade já implica external_id não nulo). Cada INSERT em `messages` mantinha
-- dois índices iguais.

-- ---------------------------------------------------------------------------
-- Índice duplicado
-- ---------------------------------------------------------------------------
drop index if exists public.idx_messages_external_lookup;

-- ---------------------------------------------------------------------------
-- Policies em initplan (geradas das definições vivas; ordem alfabética de tabela)
-- ---------------------------------------------------------------------------
-- ai_agent_versions
drop policy if exists tenant_isolation_ai_agent_versions_write on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_write on public.ai_agent_versions
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))))
  with check (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))));

-- ai_agents
drop policy if exists tenant_isolation_ai_agents_select on public.ai_agents;
create policy tenant_isolation_ai_agents_select on public.ai_agents
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists tenant_isolation_ai_agents_write on public.ai_agents;
create policy tenant_isolation_ai_agents_write on public.ai_agents
  for all
  using ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())))
  with check ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())));

-- ai_budgets
drop policy if exists tenant_isolation_ai_budgets_select on public.ai_budgets;
create policy tenant_isolation_ai_budgets_select on public.ai_budgets
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists tenant_isolation_ai_budgets_write on public.ai_budgets;
create policy tenant_isolation_ai_budgets_write on public.ai_budgets
  for all
  using ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())))
  with check ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())));

-- ai_chunks
drop policy if exists tenant_isolation_ai_chunks_select on public.ai_chunks;
create policy tenant_isolation_ai_chunks_select on public.ai_chunks
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists tenant_isolation_ai_chunks_write on public.ai_chunks;
create policy tenant_isolation_ai_chunks_write on public.ai_chunks
  for all
  using ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())))
  with check ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())));

-- ai_faq_items
drop policy if exists tenant_isolation_ai_faq_items_write on public.ai_faq_items;
create policy tenant_isolation_ai_faq_items_write on public.ai_faq_items
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))))
  with check (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))));

-- ai_invocations
drop policy if exists tenant_isolation_ai_invocations_all on public.ai_invocations;
create policy tenant_isolation_ai_invocations_all on public.ai_invocations
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())))
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- ai_knowledge_sources
drop policy if exists tenant_isolation_ai_knowledge_sources_select on public.ai_knowledge_sources;
create policy tenant_isolation_ai_knowledge_sources_select on public.ai_knowledge_sources
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists tenant_isolation_ai_knowledge_sources_write on public.ai_knowledge_sources;
create policy tenant_isolation_ai_knowledge_sources_write on public.ai_knowledge_sources
  for all
  using ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))) OR (select public.fn_is_platform_admin())))
  with check ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))) OR (select public.fn_is_platform_admin())));

-- ai_knowledge_versions
drop policy if exists tenant_isolation_ai_kbv_select on public.ai_knowledge_versions;
create policy tenant_isolation_ai_kbv_select on public.ai_knowledge_versions
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists tenant_isolation_ai_kbv_write on public.ai_knowledge_versions;
create policy tenant_isolation_ai_kbv_write on public.ai_knowledge_versions
  for all
  using ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())))
  with check ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())));

-- ai_provider_credentials
drop policy if exists tenant_isolation_ai_provider_credentials_write on public.ai_provider_credentials;
create policy tenant_isolation_ai_provider_credentials_write on public.ai_provider_credentials
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))))
  with check (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))));

-- ai_purpose_bindings
drop policy if exists tenant_isolation_ai_purpose_bindings_write on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_write on public.ai_purpose_bindings
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))))
  with check (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))));

-- ai_reply_drafts
drop policy if exists tenant_isolation_ai_reply_drafts_all on public.ai_reply_drafts;
create policy tenant_isolation_ai_reply_drafts_all on public.ai_reply_drafts
  for select to authenticated
  using (((organization_id IN (select public.fn_user_org_ids())) AND (EXISTS ( SELECT 1 FROM public.conversations c WHERE ((c.organization_id = ai_reply_drafts.organization_id) AND (c.id = ai_reply_drafts.conversation_id) AND ((select public.fn_is_platform_admin()) OR c.organization_id IN (select public.fn_conversa_orgs_visao_total()) OR (c.assigned_to_user_id = (select auth.uid()) AND c.organization_id IN (select public.fn_user_org_ids())) OR (c.assigned_to_user_id IS NULL AND c.organization_id IN (select public.fn_conversa_orgs_ve_sem_dono()))))))));

-- ai_router_members
drop policy if exists tenant_isolation_ai_router_members_write on public.ai_router_members;
create policy tenant_isolation_ai_router_members_write on public.ai_router_members
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))))
  with check (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))));

-- ai_routers
drop policy if exists tenant_isolation_ai_routers_write on public.ai_routers;
create policy tenant_isolation_ai_routers_write on public.ai_routers
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))))
  with check (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))));

-- api_audit_log
drop policy if exists audit_log_insert_tenant_member on public.api_audit_log;
create policy audit_log_insert_tenant_member on public.api_audit_log
  for insert to authenticated
  with check (((organization_id IS NULL) OR (organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists audit_log_select on public.api_audit_log;
create policy audit_log_select on public.api_audit_log
  for select
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))))));

-- api_tokens
drop policy if exists api_tokens_admin_only on public.api_tokens;
create policy api_tokens_admin_only on public.api_tokens
  for all
  using (((organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))) OR (select public.fn_is_platform_admin())))
  with check (((organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))) OR (select public.fn_is_platform_admin())));

-- attendant_availability
drop policy if exists attendant_availability_delete on public.attendant_availability;
create policy attendant_availability_delete on public.attendant_availability
  for delete
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND ((user_id = (select auth.uid())) OR (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))))));

drop policy if exists attendant_availability_insert on public.attendant_availability;
create policy attendant_availability_insert on public.attendant_availability
  for insert
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND ((user_id = (select auth.uid())) OR (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))))));

drop policy if exists attendant_availability_select on public.attendant_availability;
create policy attendant_availability_select on public.attendant_availability
  for select
  using (((select public.fn_is_platform_admin()) OR (organization_id IN (select public.fn_user_org_ids()))));

drop policy if exists attendant_availability_update on public.attendant_availability;
create policy attendant_availability_update on public.attendant_availability
  for update
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND ((user_id = (select auth.uid())) OR (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND ((user_id = (select auth.uid())) OR (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))))));

-- automation_rule_runs
drop policy if exists automation_rule_runs_select on public.automation_rule_runs;
create policy automation_rule_runs_select on public.automation_rule_runs
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- automation_rules
drop policy if exists automation_rules_manager_write on public.automation_rules;
create policy automation_rules_manager_write on public.automation_rules
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

drop policy if exists automation_rules_select on public.automation_rules;
create policy automation_rules_select on public.automation_rules
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- calendar_appointments
drop policy if exists calendar_appointments_select on public.calendar_appointments;
create policy calendar_appointments_select on public.calendar_appointments
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists calendar_appointments_write on public.calendar_appointments;
create policy calendar_appointments_write on public.calendar_appointments
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent'))))));

-- calendar_availability_exceptions
drop policy if exists calendar_availability_exceptions_select on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_select on public.calendar_availability_exceptions
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists calendar_availability_exceptions_write on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_write on public.calendar_availability_exceptions
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND ((user_id = (select auth.uid())) OR (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND ((user_id = (select auth.uid())) OR (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))))));

-- calendar_connection_calendars
drop policy if exists calendar_connection_calendars_select on public.calendar_connection_calendars;
create policy calendar_connection_calendars_select on public.calendar_connection_calendars
  for select
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (EXISTS ( SELECT 1 FROM public.calendar_connections c WHERE ((c.id = calendar_connection_calendars.connection_id) AND ((c.user_id = (select auth.uid())) OR (c.organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))))));

-- calendar_connections
drop policy if exists calendar_connections_dono_ou_manager_read on public.calendar_connections;
create policy calendar_connections_dono_ou_manager_read on public.calendar_connections
  for select
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND ((user_id = (select auth.uid())) OR (organization_id IN (select public.fn_orgs_com_papel_minimo('manager')))))));

-- calendar_event_types
drop policy if exists calendar_event_types_select on public.calendar_event_types;
create policy calendar_event_types_select on public.calendar_event_types
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists calendar_event_types_write on public.calendar_event_types;
create policy calendar_event_types_write on public.calendar_event_types
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

-- calendar_external_events
drop policy if exists calendar_external_events_select on public.calendar_external_events;
create policy calendar_external_events_select on public.calendar_external_events
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- catalog_products
drop policy if exists catalog_products_select on public.catalog_products;
create policy catalog_products_select on public.catalog_products
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists catalog_products_write on public.catalog_products;
create policy catalog_products_write on public.catalog_products
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

-- channel_routing_policies
drop policy if exists tenant_isolation_channel_routing_policies_select on public.channel_routing_policies;
create policy tenant_isolation_channel_routing_policies_select on public.channel_routing_policies
  for select to authenticated
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- channel_routing_responsibles
drop policy if exists tenant_isolation_channel_routing_responsibles_select on public.channel_routing_responsibles;
create policy tenant_isolation_channel_routing_responsibles_select on public.channel_routing_responsibles
  for select to authenticated
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- channel_session_warmup
drop policy if exists warmup_tenant_isolation_all on public.channel_session_warmup;
create policy warmup_tenant_isolation_all on public.channel_session_warmup
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())))
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- channel_sessions
drop policy if exists channel_sessions_tenant_select on public.channel_sessions;
create policy channel_sessions_tenant_select on public.channel_sessions
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists channel_sessions_tenant_write on public.channel_sessions;
create policy channel_sessions_tenant_write on public.channel_sessions
  for all
  using ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())))
  with check ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())));

-- conversation_assignment_events
drop policy if exists cae_insert on public.conversation_assignment_events;
create policy cae_insert on public.conversation_assignment_events
  for insert
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists cae_select on public.conversation_assignment_events;
create policy cae_select on public.conversation_assignment_events
  for select
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (EXISTS ( SELECT 1 FROM public.conversations c WHERE (c.id = conversation_assignment_events.conversation_id))))));

-- conversation_notes
drop policy if exists conversation_notes_select on public.conversation_notes;
create policy conversation_notes_select on public.conversation_notes
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists conversation_notes_write on public.conversation_notes;
create policy conversation_notes_write on public.conversation_notes
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent')))))
  with check (((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent')))));

-- crm_lead_activities
drop policy if exists crm_lead_activities_insert on public.crm_lead_activities;
create policy crm_lead_activities_insert on public.crm_lead_activities
  for insert
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists crm_lead_activities_select on public.crm_lead_activities;
create policy crm_lead_activities_select on public.crm_lead_activities
  for select
  using ((EXISTS ( SELECT 1 FROM public.crm_leads l WHERE ((l.id = crm_lead_activities.lead_id) AND ((select public.fn_is_platform_admin()) OR l.organization_id IN (select public.fn_conversa_orgs_visao_total()) OR (l.owner_user_id = (select auth.uid()) AND l.organization_id IN (select public.fn_user_org_ids())) OR (l.owner_user_id IS NULL AND l.organization_id IN (select public.fn_conversa_orgs_ve_sem_dono())))))));

-- crm_lead_links
drop policy if exists crm_lead_links_delete on public.crm_lead_links;
create policy crm_lead_links_delete on public.crm_lead_links
  for delete
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists crm_lead_links_insert on public.crm_lead_links;
create policy crm_lead_links_insert on public.crm_lead_links
  for insert
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists crm_lead_links_select on public.crm_lead_links;
create policy crm_lead_links_select on public.crm_lead_links
  for select
  using ((EXISTS ( SELECT 1 FROM public.crm_leads l WHERE ((l.id = crm_lead_links.lead_id) AND ((select public.fn_is_platform_admin()) OR l.organization_id IN (select public.fn_conversa_orgs_visao_total()) OR (l.owner_user_id = (select auth.uid()) AND l.organization_id IN (select public.fn_user_org_ids())) OR (l.owner_user_id IS NULL AND l.organization_id IN (select public.fn_conversa_orgs_ve_sem_dono())))))));

drop policy if exists crm_lead_links_update on public.crm_lead_links;
create policy crm_lead_links_update on public.crm_lead_links
  for update
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())))
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- crm_leads
drop policy if exists crm_leads_delete on public.crm_leads;
create policy crm_leads_delete on public.crm_leads
  for delete
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent'))) AND ((organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))) OR ((select public.fn_is_platform_admin()) OR organization_id IN (select public.fn_conversa_orgs_visao_total()) OR (owner_user_id = (select auth.uid()) AND organization_id IN (select public.fn_user_org_ids())) OR (owner_user_id IS NULL AND organization_id IN (select public.fn_conversa_orgs_ve_sem_dono())))))));

drop policy if exists crm_leads_insert on public.crm_leads;
create policy crm_leads_insert on public.crm_leads
  for insert
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent'))) AND ((organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))) OR ((select public.fn_is_platform_admin()) OR organization_id IN (select public.fn_conversa_orgs_visao_total()) OR (owner_user_id = (select auth.uid()) AND organization_id IN (select public.fn_user_org_ids())) OR (owner_user_id IS NULL AND organization_id IN (select public.fn_conversa_orgs_ve_sem_dono())))))));

drop policy if exists crm_leads_select on public.crm_leads;
create policy crm_leads_select on public.crm_leads
  for select
  using (((select public.fn_is_platform_admin()) OR organization_id IN (select public.fn_conversa_orgs_visao_total()) OR (owner_user_id = (select auth.uid()) AND organization_id IN (select public.fn_user_org_ids())) OR (owner_user_id IS NULL AND organization_id IN (select public.fn_conversa_orgs_ve_sem_dono()))));

drop policy if exists crm_leads_update on public.crm_leads;
create policy crm_leads_update on public.crm_leads
  for update
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent'))) AND ((organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))) OR ((select public.fn_is_platform_admin()) OR organization_id IN (select public.fn_conversa_orgs_visao_total()) OR (owner_user_id = (select auth.uid()) AND organization_id IN (select public.fn_user_org_ids())) OR (owner_user_id IS NULL AND organization_id IN (select public.fn_conversa_orgs_ve_sem_dono())))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent'))) AND ((organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))) OR ((select public.fn_is_platform_admin()) OR organization_id IN (select public.fn_conversa_orgs_visao_total()) OR (owner_user_id = (select auth.uid()) AND organization_id IN (select public.fn_user_org_ids())) OR (owner_user_id IS NULL AND organization_id IN (select public.fn_conversa_orgs_ve_sem_dono())))))));

-- crm_pipelines
drop policy if exists crm_pipelines_manager_write on public.crm_pipelines;
create policy crm_pipelines_manager_write on public.crm_pipelines
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

drop policy if exists crm_pipelines_select on public.crm_pipelines;
create policy crm_pipelines_select on public.crm_pipelines
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- crm_stages
drop policy if exists crm_stages_manager_write on public.crm_stages;
create policy crm_stages_manager_write on public.crm_stages
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

drop policy if exists crm_stages_select on public.crm_stages;
create policy crm_stages_select on public.crm_stages
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- crm_tasks
drop policy if exists crm_tasks_select on public.crm_tasks;
create policy crm_tasks_select on public.crm_tasks
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists crm_tasks_write on public.crm_tasks;
create policy crm_tasks_write on public.crm_tasks
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('agent'))))));

-- event_log
drop policy if exists event_log_select on public.event_log;
create policy event_log_select on public.event_log
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- incidents
drop policy if exists platform_admin_only_incidents on public.incidents;
create policy platform_admin_only_incidents on public.incidents
  for all
  using ((select public.fn_is_platform_admin()))
  with check ((select public.fn_is_platform_admin()));

-- lgpd_requests
drop policy if exists lgpd_requests_admin_select on public.lgpd_requests;
create policy lgpd_requests_admin_select on public.lgpd_requests
  for select
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))))));

drop policy if exists lgpd_requests_admin_write on public.lgpd_requests;
create policy lgpd_requests_admin_write on public.lgpd_requests
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))))));

-- merge_queue
drop policy if exists merge_queue_manager_select on public.merge_queue;
create policy merge_queue_manager_select on public.merge_queue
  for select
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

drop policy if exists merge_queue_manager_write on public.merge_queue;
create policy merge_queue_manager_write on public.merge_queue
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

-- messages
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages
  for delete
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select
  using (((select public.fn_is_platform_admin()) OR (EXISTS ( SELECT 1 FROM public.conversations c WHERE (c.id = messages.conversation_id)))));

drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages
  for update
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())))
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- nuvemshop_products
drop policy if exists nuvemshop_products_tenant on public.nuvemshop_products;
create policy nuvemshop_products_tenant on public.nuvemshop_products
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())))
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- orders
drop policy if exists orders_tenant_select on public.orders;
create policy orders_tenant_select on public.orders
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists orders_tenant_write on public.orders;
create policy orders_tenant_write on public.orders
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())))
  with check (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- org_guardrail_layers
drop policy if exists org_guardrail_layers_admin_write on public.org_guardrail_layers;
create policy org_guardrail_layers_admin_write on public.org_guardrail_layers
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))))));

drop policy if exists org_guardrail_layers_select on public.org_guardrail_layers;
create policy org_guardrail_layers_select on public.org_guardrail_layers
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- organizations
drop policy if exists orgs_select on public.organizations;
create policy orgs_select on public.organizations
  for select
  using (((id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

drop policy if exists orgs_write_platform_admin on public.organizations;
create policy orgs_write_platform_admin on public.organizations
  for all
  using ((select public.fn_is_platform_admin()))
  with check ((select public.fn_is_platform_admin()));

-- platform_admins
drop policy if exists platform_admins_self on public.platform_admins;
create policy platform_admins_self on public.platform_admins
  for select
  using ((select public.fn_is_platform_admin()));

-- push_subscriptions
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all
  using (((organization_id IN (select public.fn_user_org_ids())) AND (user_id = (select auth.uid())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('viewer')))))
  with check (((organization_id IN (select public.fn_user_org_ids())) AND (user_id = (select auth.uid())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('viewer')))));

-- tenant_integrations
drop policy if exists tenant_integrations_admin_write on public.tenant_integrations;
create policy tenant_integrations_admin_write on public.tenant_integrations
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

drop policy if exists tenant_integrations_select on public.tenant_integrations;
create policy tenant_integrations_select on public.tenant_integrations
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

-- user_organizations
drop policy if exists user_orgs_delete on public.user_organizations;
create policy user_orgs_delete on public.user_organizations
  for delete
  using (((organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))) OR (select public.fn_is_platform_admin())));

drop policy if exists user_orgs_insert on public.user_organizations;
create policy user_orgs_insert on public.user_organizations
  for insert
  with check (((organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))) OR (select public.fn_is_platform_admin())));

drop policy if exists user_orgs_select on public.user_organizations;
create policy user_orgs_select on public.user_organizations
  for select
  using (((user_id = (select auth.uid())) OR (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))) OR (select public.fn_is_platform_admin())));

drop policy if exists user_orgs_update on public.user_organizations;
create policy user_orgs_update on public.user_organizations
  for update
  using (((organization_id IN (select public.fn_orgs_com_papel_minimo('admin'))) OR (select public.fn_is_platform_admin())));

-- user_recovery_codes
drop policy if exists recovery_codes_self on public.user_recovery_codes;
create policy recovery_codes_self on public.user_recovery_codes
  for all
  using ((user_id = (select auth.uid())))
  with check ((user_id = (select auth.uid())));

-- webhook_events_log
drop policy if exists webhook_events_log_tenant_read on public.webhook_events_log;
create policy webhook_events_log_tenant_read on public.webhook_events_log
  for select
  using (((select public.fn_is_platform_admin()) OR ((organization_id IS NOT NULL) AND (organization_id IN (select public.fn_user_org_ids())))));

-- webhook_lead_captures
drop policy if exists webhook_lead_captures_manager_read on public.webhook_lead_captures;
create policy webhook_lead_captures_manager_read on public.webhook_lead_captures
  for select
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

-- webhook_sources
drop policy if exists webhook_sources_manager_write on public.webhook_sources;
create policy webhook_sources_manager_write on public.webhook_sources
  for all
  using (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))))
  with check (((select public.fn_is_platform_admin()) OR ((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('manager'))))));

drop policy if exists webhook_sources_select on public.webhook_sources;
create policy webhook_sources_select on public.webhook_sources
  for select
  using (((organization_id IN (select public.fn_user_org_ids())) OR (select public.fn_is_platform_admin())));

