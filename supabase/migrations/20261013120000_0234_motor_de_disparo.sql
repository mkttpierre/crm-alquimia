-- 0234 — motor de disparo por organização (Fase 5, etapa 1: SÓ SIMULADO).
--
-- Três tabelas, todas tenant-aware, que dão ao motor portado dos CRMs antigos
-- (`lib/disparo/`) o lugar dele no banco:
--
--   disparo_config  uma linha por organização: ligado, modo (simulado|real),
--                   teto diário, cadência, etapa de origem das aberturas,
--                   ritmo (jsonb lido SÓ por `lib/disparo/config.ts`, com
--                   Zod), modelos de texto e regras proibidas da casa.
--   disparo_chips   os números que prospectam: estado, saúde, dia da rampa,
--                   próxima vez, pausa. `channel_session_id` é NULLABLE: nesta
--                   etapa nenhum chip é ligado a canal real.
--   disparo_envios  a fila: um envio por (lead, passo). Estados
--                   pendente|enviando|enviado|simulado|cancelado|falhou.
--
-- O default de `modo` é `simulado`, e o envio real ainda exige uma segunda
-- chave fora do banco (`DISPARO_REAL_LIBERADO=sim` no servidor) — ver
-- `lib/disparo/trava.ts`. Esta migration não liga nada: nenhuma linha nasce.
--
-- RLS: leitura para membros da organização (`fn_user_org_ids()`); escrita só
-- pelo `service_role` (o cron). Não há tela que escreva aqui nesta etapa, e
-- dar INSERT/UPDATE a `authenticated` abriria a porta de alguém trocar o modo
-- para `real` pelo PostgREST com o próprio JWT.
--
-- Índice único parcial em (organization_id, lead_id, tipo) para passos do
-- motor e lembretes: um lead nunca recebe a mesma abertura ou o mesmo toque
-- duas vezes, nem com duas voltas do cron chegando juntas. Respostas (`auto`,
-- `operador`) ficam fora — uma conversa tem muitas.
--
-- Vocabulários com CHECK (tabelas novas: não há linha legada para quebrar o
-- `update.sh` de um clone). `tipo` é vocabulário ABERTO (vem da cadência da
-- organização) e só tem CHECK de forma.

create table if not exists public.disparo_config (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ligado boolean not null default false,
  modo text not null default 'simulado' check (modo in ('simulado', 'real')),
  teto_diario integer check (teto_diario is null or teto_diario > 0),
  cadencia text not null default 'reativacao_3_toques' check (cadencia ~ '^[a-z0-9_]{2,60}$'),
  fonte_stage_id uuid references public.crm_stages(id) on delete set null,
  ritmo jsonb not null default '{}'::jsonb check (jsonb_typeof(ritmo) = 'object'),
  modelos jsonb not null default '{}'::jsonb check (jsonb_typeof(modelos) = 'object'),
  proibidos jsonb not null default '[]'::jsonb check (jsonb_typeof(proibidos) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.disparo_chips (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  nome text not null check (length(btrim(nome)) > 0),
  estado text not null default 'rampa' check (estado in ('rampa', 'ativo', 'pausado', 'desligado')),
  saude text not null default 'verde' check (saude in ('verde', 'amarelo', 'vermelho')),
  dia_rampa integer not null default 1 check (dia_rampa >= 1),
  proximo_envio_em timestamptz,
  pausado_ate timestamptz,
  envios_desde_pausa integer not null default 0 check (envios_desde_pausa >= 0),
  pausa_a_cada integer not null default 15 check (pausa_a_cada >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, nome)
);

create table if not exists public.disparo_envios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  chip_id uuid,
  tipo text not null check (tipo ~ '^[a-z0-9_:]{2,40}$'),
  origem text not null default 'motor' check (origem in ('motor', 'auto', 'operador', 'lembrete')),
  texto text not null default '',
  midia text,
  enviar_apos timestamptz not null default now(),
  estado text not null default 'pendente'
    check (estado in ('pendente', 'enviando', 'enviado', 'simulado', 'cancelado', 'falhou')),
  motivo text,
  tentativas integer not null default 0 check (tentativas >= 0),
  external_id text,
  enviado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- O chip é da MESMA organização: FK composta. Chip apagado solta o envio
  -- (histórico fica) sem anular a organização.
  constraint disparo_envios_chip_da_org foreign key (organization_id, chip_id)
    references public.disparo_chips (organization_id, id) on delete set null (chip_id),
  constraint disparo_envios_saiu_tem_hora check (estado not in ('enviado', 'simulado') or enviado_em is not null)
);

create unique index if not exists disparo_envios_passo_unico
  on public.disparo_envios (organization_id, lead_id, tipo)
  where origem in ('motor', 'lembrete');
create index if not exists disparo_envios_vencidos
  on public.disparo_envios (organization_id, chip_id, enviar_apos)
  where estado = 'pendente';
create index if not exists disparo_envios_saidos_do_chip
  on public.disparo_envios (organization_id, chip_id, enviado_em desc)
  where estado in ('enviado', 'simulado');
create index if not exists disparo_envios_do_lead
  on public.disparo_envios (organization_id, lead_id, created_at desc);
create index if not exists disparo_chips_da_org on public.disparo_chips (organization_id);

drop trigger if exists trg_disparo_config_updated_at on public.disparo_config;
create trigger trg_disparo_config_updated_at before update on public.disparo_config
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_disparo_chips_updated_at on public.disparo_chips;
create trigger trg_disparo_chips_updated_at before update on public.disparo_chips
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_disparo_envios_updated_at on public.disparo_envios;
create trigger trg_disparo_envios_updated_at before update on public.disparo_envios
  for each row execute function public.fn_set_updated_at();

alter table public.disparo_config enable row level security;
alter table public.disparo_chips enable row level security;
alter table public.disparo_envios enable row level security;

revoke all on public.disparo_config from anon, authenticated;
revoke all on public.disparo_chips from anon, authenticated;
revoke all on public.disparo_envios from anon, authenticated;
grant select on public.disparo_config to authenticated;
grant select on public.disparo_chips to authenticated;
grant select on public.disparo_envios to authenticated;
grant all on public.disparo_config to service_role;
grant all on public.disparo_chips to service_role;
grant all on public.disparo_envios to service_role;

drop policy if exists tenant_isolation_disparo_config_all on public.disparo_config;
create policy tenant_isolation_disparo_config_all on public.disparo_config for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_disparo_chips_all on public.disparo_chips;
create policy tenant_isolation_disparo_chips_all on public.disparo_chips for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_disparo_envios_all on public.disparo_envios;
create policy tenant_isolation_disparo_envios_all on public.disparo_envios for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

comment on table public.disparo_config is
  'Motor de disparo por organização. modo=real só envia com DISPARO_REAL_LIBERADO=sim no servidor (lib/disparo/trava.ts).';
comment on table public.disparo_chips is
  'Chips do motor de disparo: saúde, rampa e vez. channel_session_id nulo = chip sem canal (só simula).';
comment on table public.disparo_envios is
  'Fila do motor de disparo. Um passo da cadência por lead (índice disparo_envios_passo_unico).';
