-- 0257 — reparo: índices da 0133 que bancos antigos não têm.
--
-- A 0133 (fn_atrito_metrics) criou cinco índices junto com a função, mas o apêndice dela no `baseline.sql` trouxe só a
-- função. Todo banco instalado ou atualizado pelo kit ficou sem os cinco. O apêndice do baseline já foi reparado
-- (bloco "reparo de baseline: índices da migration 0133"), mas isso só alcança quem aplica o baseline: um banco que
-- segue `migrations/` em ordem e já passou da 0133 sem os índices (o caso medido: nenhum dos cinco no banco de
-- produção) nunca reaplica a 0133. Esta forward-fix cria os cinco de novo, com a MESMA definição da 0133 e do apêndice.
--
-- `create index if not exists`: no banco que já os tem, não faz nada. Sem `concurrently` (o runner envolve a migration
-- em transação, e `create index concurrently` não roda dentro de uma); o índice em `messages` trava a escrita na tabela
-- enquanto é construído, então aplicar fora da janela de envio e de resposta.
--
-- A faixa de conexão caída (`listarConexoesCaidas`, lib/channels/health.ts) consulta messages por
-- organization_id + direction + sent_at e depende do primeiro; os outros quatro são predicados de fn_atrito_metrics.
-- Nenhuma função nova; o baseline não ganha bloco novo (o reparo já está lá).

create index if not exists idx_messages_org_direction_sent
  on public.messages (organization_id, direction, sent_at);

create index if not exists idx_agent_cases_org_closed
  on public.agent_cases (organization_id, closed_at)
  where closed_at is not null;

create index if not exists idx_contacts_org_blocked_at
  on public.contacts (organization_id, blocked_at)
  where blocked_at is not null;

create index if not exists idx_crm_lead_activities_org_type_performed
  on public.crm_lead_activities (organization_id, type, performed_at);

create index if not exists idx_before_send_traces_org_created
  on public.before_send_traces (organization_id, created_at);
