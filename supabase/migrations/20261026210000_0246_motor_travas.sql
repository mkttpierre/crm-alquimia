-- 0246 — travas do motor de disparo (auditoria 3 do motor, 26/10/2026).
--
--   disparo_travas      trava com dono e prazo, por organização e chave:
--                         `lead:<id>`  uma leitura do atendimento por lead de cada vez (duas mensagens
--                                      seguidas geravam dois funis intercalados);
--                         `chip:<id>`  uma volta do motor por chip de cada vez (o cron roda a cada minuto e
--                                      a volta pode durar ~2 min seguindo um funil: voltas sobrepostas liam a
--                                      contagem do chip cada uma por si e furavam o intervalo mínimo e o
--                                      máximo por hora).
--                       Tabela e não `pg_advisory_lock`: o PostgREST não guarda sessão entre chamadas e a
--                       trava precisa durar a volta inteira. Quem tomou e morreu não a segura: `ate` vence.
--   disparo_voltas      a última volta do motor por organização (início, fim, duração, resumo por chip). A volta
--                       sem efeito NÃO audita (doutrina do CLAUDE.md); sem isto, uma parada de dias era invisível
--                       (a saída do cron vai para /dev/null). Uma linha por organização, sobrescrita: não cresce.
--   disparo_envios_operador_em_aberto
--                       índice único parcial: a mesma parte de uma sequência do operador (`/funil-valores`) só
--                       pode estar uma vez em aberto (pendente ou enviando) para o lead. Dois POSTs juntos (duplo
--                       clique, duas abas) passavam a checagem `emAberto` antes de qualquer um gravar.
--   nao_contatar        a etapa `nao_contatar` gravada pelo atendimento (a lead pediu para parar) passa a marcar
--                       também `crm_leads.custom_fields.nao_contatar = true`, que é o que o motor, a sequência do
--                       operador e os toques futuros leem. Aqui, o acerto das conversas que já estão nessa etapa.
--
-- Nenhuma função nova. RLS de leitura por `fn_user_org_ids()`, escrita só `service_role`.
-- Idempotente: create if not exists, policy por drop+create, e os dados corrigidos ANTES do índice único
-- (o update.sh de um clone com duplicados não pode quebrar).

create table if not exists public.disparo_travas (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chave text not null check (chave ~ '^[a-z_]{2,20}:[A-Za-z0-9_-]{1,80}$'),
  dono text not null check (length(dono) between 1 and 120),
  ate timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, chave)
);
create index if not exists disparo_travas_vencidas on public.disparo_travas (ate);

create table if not exists public.disparo_voltas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  inicio timestamptz not null,
  fim timestamptz not null,
  duracao_ms integer not null check (duracao_ms >= 0),
  efeito boolean not null default false,
  resultado jsonb not null default '{}'::jsonb check (jsonb_typeof(resultado) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.disparo_travas enable row level security;
alter table public.disparo_voltas enable row level security;

revoke all on public.disparo_travas from anon, authenticated;
revoke all on public.disparo_voltas from anon, authenticated;
grant select on public.disparo_travas to authenticated;
grant select on public.disparo_voltas to authenticated;
grant all on public.disparo_travas to service_role;
grant all on public.disparo_voltas to service_role;

drop policy if exists tenant_isolation_disparo_travas_all on public.disparo_travas;
create policy tenant_isolation_disparo_travas_all on public.disparo_travas for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_disparo_voltas_all on public.disparo_voltas;
create policy tenant_isolation_disparo_voltas_all on public.disparo_voltas for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

-- Duplicados de parte do operador em aberto: fica a mais antiga; as outras saem da fila ANTES do índice.
with dup as (
  select id, estado,
         row_number() over (partition by organization_id, lead_id, tipo order by created_at, id) as n
  from public.disparo_envios
  where origem = 'operador' and estado in ('pendente', 'enviando')
)
update public.disparo_envios e
   set estado = case when dup.estado = 'pendente' then 'cancelado' else 'falhou' end,
       motivo = 'duplicada: a mesma parte já estava em aberto para a lead (migration 0246)'
  from dup
 where e.id = dup.id and dup.n > 1;

create unique index if not exists disparo_envios_operador_em_aberto
  on public.disparo_envios (organization_id, lead_id, tipo)
  where origem = 'operador' and estado in ('pendente', 'enviando');

-- Conversas já encerradas em `nao_contatar`: o lead ganha a marca que o motor e a sequência do operador leem.
update public.crm_leads l
   set custom_fields = coalesce(l.custom_fields, '{}'::jsonb) || '{"nao_contatar": true}'::jsonb
  from public.disparo_conversas c
 where c.organization_id = l.organization_id
   and c.lead_id = l.id
   and c.etapa = 'nao_contatar'
   and coalesce(l.custom_fields ->> 'nao_contatar', '') <> 'true';

comment on table public.disparo_travas is
  'Trava com dono e prazo do motor de disparo: lead:<id> (uma leitura do atendimento por vez), chip:<id> (uma volta por chip).';
comment on table public.disparo_voltas is
  'Última volta do motor de disparo por organização: duração e resultado por chip (a volta sem efeito não audita).';

notify pgrst, 'reload schema';
