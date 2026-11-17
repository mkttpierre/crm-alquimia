-- 0243 — saúde calculada do chip e quarentena do lead (Fase 5, etapa 2: freios do motor de disparo).
--
-- O motor só tinha um freio: erro de envio com cara de restrição = vermelho por
-- 48 h. Esta migration dá ao banco o que falta para calcular amarelo e vermelho
-- antes da restrição chegar (PLANO-DISPAROS 5.3) e para o lead que não respondeu
-- aos toques ficar de fora por um tempo (5.4):
--
--   disparo_envios.ack / ack_em / entregue_em / lido_em
--                          o status de entrega que a Evolution devolve depois do
--                          envio (`messages.update`), casado por `external_id`.
--                          `ack` 1 = um tique (servidor recebeu), 2 = entregue,
--                          3 = lido, 4 = ouvido. NULL = nunca chegou ack nenhum
--                          (sem dado, que NÃO é o mesmo que um tique: a conta de
--                          bloqueio provável ignora o que não tem dado).
--   disparo_chips.saude_motivo / saude_calculada_em
--                          o porquê da cor atual e quando o motor a calculou.
--   disparo_saude_dia      uma linha por chip por dia local: os números que
--                          sustentam a cor (aberturas, respostas, bloqueio
--                          provável, não quero, irritação, conexão) e os
--                          motivos. É o que o painel diário lê. A pior cor do
--                          dia vence: amarelo não "melhora" a si mesmo à tarde.
--   disparo_eventos_conexao
--                          close / connecting / logout / 428 que o webhook da
--                          Evolution viu em cada sessão de canal. Alimenta o
--                          indicador de conexão (close, 428, logout = vermelho;
--                          reconexão = amarelo).
--   disparo_quarentena     lead que recebeu todos os toques sem responder: não
--                          abre de novo até `ate` (45 dias por padrão).
--
-- Tudo configurável por organização em `disparo_config.ritmo` (blocos `saude` e
-- `quarentena`, lidos só por `lib/disparo/config.ts`). Nada aqui liga envio.
--
-- RLS como as outras disparo_*: leitura para membros da organização
-- (`fn_user_org_ids()`), escrita só pelo `service_role`. Nenhuma função nova.
-- Idempotente: pode ser re-aplicada.

alter table public.disparo_envios
  add column if not exists ack smallint,
  add column if not exists ack_em timestamptz,
  add column if not exists entregue_em timestamptz,
  add column if not exists lido_em timestamptz;
alter table public.disparo_envios drop constraint if exists disparo_envios_ack_faixa;
alter table public.disparo_envios add constraint disparo_envios_ack_faixa check (ack is null or ack between 0 and 4);

create index if not exists disparo_envios_por_external_id
  on public.disparo_envios (organization_id, external_id)
  where external_id is not null;

alter table public.disparo_chips
  add column if not exists saude_motivo text,
  add column if not exists saude_calculada_em timestamptz;

create table if not exists public.disparo_saude_dia (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chip_id uuid not null,
  -- Dia local da organização (fuso de `ritmo.fusoMinutos`), AAAA-MM-DD.
  dia date not null,
  saude text not null default 'verde' check (saude in ('verde', 'amarelo', 'vermelho')),
  dia_rampa integer not null default 1 check (dia_rampa >= 1),
  estado_chip text,
  aberturas integer not null default 0 check (aberturas >= 0),
  respostas integer not null default 0 check (respostas >= 0),
  aberturas_janela integer not null default 0 check (aberturas_janela >= 0),
  respostas_janela integer not null default 0 check (respostas_janela >= 0),
  maduras integer not null default 0 check (maduras >= 0),
  com_ack integer not null default 0 check (com_ack >= 0),
  bloqueio_provavel integer not null default 0 check (bloqueio_provavel >= 0),
  nao_quero integer not null default 0 check (nao_quero >= 0),
  irritacao integer not null default 0 check (irritacao >= 0),
  reconexoes integer not null default 0 check (reconexoes >= 0),
  quedas integer not null default 0 check (quedas >= 0),
  motivos jsonb not null default '[]'::jsonb check (jsonb_typeof(motivos) = 'array'),
  calculado_em timestamptz not null default now(),
  primary key (organization_id, chip_id, dia),
  constraint disparo_saude_dia_chip_da_org foreign key (organization_id, chip_id)
    references public.disparo_chips (organization_id, id) on delete cascade
);
create index if not exists disparo_saude_dia_recentes on public.disparo_saude_dia (organization_id, dia desc);

create table if not exists public.disparo_eventos_conexao (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  estado text not null check (estado ~ '^[a-z_]{2,30}$'),
  codigo integer,
  ocorrido_em timestamptz not null default now(),
  constraint disparo_eventos_conexao_sessao_da_org foreign key (organization_id, channel_session_id)
    references public.channel_sessions (organization_id, id) on delete cascade
);
create index if not exists disparo_eventos_conexao_da_sessao
  on public.disparo_eventos_conexao (organization_id, channel_session_id, ocorrido_em desc);

create table if not exists public.disparo_quarentena (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  chip_id uuid,
  motivo text not null default 'toques_sem_resposta' check (motivo ~ '^[a-z_]{2,40}$'),
  inicio timestamptz not null default now(),
  ate timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, lead_id),
  constraint disparo_quarentena_chip_da_org foreign key (organization_id, chip_id)
    references public.disparo_chips (organization_id, id) on delete set null (chip_id),
  constraint disparo_quarentena_fim_depois_do_inicio check (ate > inicio)
);
create index if not exists disparo_quarentena_vigente on public.disparo_quarentena (organization_id, ate);

alter table public.disparo_saude_dia enable row level security;
alter table public.disparo_eventos_conexao enable row level security;
alter table public.disparo_quarentena enable row level security;

revoke all on public.disparo_saude_dia from anon, authenticated;
revoke all on public.disparo_eventos_conexao from anon, authenticated;
revoke all on public.disparo_quarentena from anon, authenticated;
grant select on public.disparo_saude_dia to authenticated;
grant select on public.disparo_eventos_conexao to authenticated;
grant select on public.disparo_quarentena to authenticated;
grant all on public.disparo_saude_dia to service_role;
grant all on public.disparo_eventos_conexao to service_role;
grant all on public.disparo_quarentena to service_role;

drop policy if exists tenant_isolation_disparo_saude_dia_all on public.disparo_saude_dia;
create policy tenant_isolation_disparo_saude_dia_all on public.disparo_saude_dia for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_disparo_eventos_conexao_all on public.disparo_eventos_conexao;
create policy tenant_isolation_disparo_eventos_conexao_all on public.disparo_eventos_conexao for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_disparo_quarentena_all on public.disparo_quarentena;
create policy tenant_isolation_disparo_quarentena_all on public.disparo_quarentena for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

comment on column public.disparo_envios.ack is
  'Status de entrega da Evolution: 1 um tique, 2 entregue, 3 lido, 4 ouvido. NULL = nenhum ack chegou (sem dado).';
comment on table public.disparo_saude_dia is
  'Saúde calculada do chip por dia local: os números e os motivos da cor (painel diário da tela Disparo).';
comment on table public.disparo_eventos_conexao is
  'Eventos de conexão (close, connecting, logout, 428) vistos pelo webhook da Evolution; alimentam o freio de conexão.';
comment on table public.disparo_quarentena is
  'Lead que recebeu todos os toques sem responder: não abre de novo até `ate`.';

notify pgrst, 'reload schema';
