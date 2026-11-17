-- 0253 — channel_sessions: a política de escrita deixa de ser FOR ALL (varredura de 10/11/2026).
--
-- Desde a 0150 (forma de initplan na 0247) a tabela tinha um PAR:
--   channel_sessions_tenant_select  FOR SELECT  membro da organização ou platform admin
--   channel_sessions_tenant_write   FOR ALL     admin da organização ou platform admin
--
-- Um FOR ALL vale também para SELECT. Políticas permissivas do mesmo comando
-- entram em OR, então a `_write` era avaliada em TODA leitura da tabela, junto
-- com a `_select`, sem acrescentar uma linha visível sequer: todo admin já é
-- membro. Custo sem efeito na leitura (o cabeçalho da 0247 mede o mesmo padrão:
-- "as políticas *_write (FOR ALL) pioram, porque entram também no SELECT"), e
-- uma leitura enganosa de quem audita: "FOR ALL" parece dizer que admin tem um
-- SELECT próprio.
--
-- ## O que muda — e o que NÃO muda
--
-- A `_write` vira três políticas, uma por comando, com o MESMO predicado dela:
--   channel_sessions_tenant_insert  FOR INSERT  with check
--   channel_sessions_tenant_update  FOR UPDATE  using + with check
--   channel_sessions_tenant_delete  FOR DELETE  using
-- A `_select` fica como está. Quem pode o quê, antes e depois:
--   viewer/agent/manager: lê; não cria, não altera, não apaga.
--   admin da organização: lê, cria, altera, apaga (só na própria organização).
--   platform admin: lê, cria, altera, apaga.
--   service_role (worker, rotas com o client admin): bypassrls, não passa por aqui.
-- Vigiado em `tests/invariants/rls-channel-sessions.test.ts` (matriz por papel e
-- a forma: nenhuma política FOR ALL na tabela).
--
-- Idempotente: `drop policy if exists` antes de cada `create policy`. Sem função
-- nova, sem grant novo.

drop policy if exists channel_sessions_tenant_write on public.channel_sessions;

drop policy if exists channel_sessions_tenant_insert on public.channel_sessions;
create policy channel_sessions_tenant_insert on public.channel_sessions
  for insert
  with check ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())));

drop policy if exists channel_sessions_tenant_update on public.channel_sessions;
create policy channel_sessions_tenant_update on public.channel_sessions
  for update
  using ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())))
  with check ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())));

drop policy if exists channel_sessions_tenant_delete on public.channel_sessions;
create policy channel_sessions_tenant_delete on public.channel_sessions
  for delete
  using ((((organization_id IN (select public.fn_user_org_ids())) AND (organization_id IN (select public.fn_orgs_com_papel_minimo('admin')))) OR (select public.fn_is_platform_admin())));

notify pgrst, 'reload schema';
