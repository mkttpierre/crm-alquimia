-- 0241 — atendimento do motor de disparo (Fase 5, etapa 2: SÓ SIMULADO).
--
-- O que acontece quando o lead responde: a leitura (regras + Jev), a decisão
-- (responder, avisar o operador, encerrar) e o estado da conversa. O código é
-- `lib/disparo/atendimento/`; esta migration dá a ele o lugar no banco:
--
--   disparo_config.atendimento  jsonb da organização, lido SÓ por
--                               `lib/disparo/atendimento/config.ts` (Zod):
--                               perfil (venda|prospeccao), respostas prontas,
--                               objeções (gatilho + descrição para o Jev),
--                               kits, escada de preço, pacote de fechamento.
--                               '{}' = atendimento desligado (comportamento de
--                               antes desta migration).
--   disparo_conversas           uma linha por lead em atendimento: etapa
--                               (respondeu|qualificando|pronto_fechar|fechado|
--                               perdido|nao_contatar), quente, precisa_operador,
--                               respostas automáticas seguidas e o que a
--                               conversa já gastou (`dados`, jsonb lido só pelo
--                               código). NÃO move o card do funil.
--   disparo_leituras            uma linha por mensagem lida: o que o lead disse,
--                               a leitura e a decisão. `unique (organization_id,
--                               chave)` é a idempotência — a reentrega do
--                               webhook não decide duas vezes.
--   disparo_envios.midia_id     a mídia da resposta (áudio, tabela), apontando
--                               para a `media_library` da MESMA organização (FK
--                               composta, como em `message_templates`).
--
-- Nada aqui envia: a resposta automática nasce `simulado` enquanto a trava
-- dupla (`lib/disparo/trava.ts`) estiver fechada, e o aviso ao operador é item
-- da Central (`agent_inbox_items`, kind `other` ligado ao lead) — nenhum kind
-- novo, nenhuma constraint da Central reconstruída.
--
-- RLS como as outras disparo_*: leitura para membros da organização
-- (`fn_user_org_ids()`), escrita só pelo `service_role`. Vocabulários com
-- CHECK (tabelas novas: não há linha legada). Nenhuma função nova.
-- Idempotente: pode ser re-aplicada.

alter table public.disparo_config
  add column if not exists atendimento jsonb not null default '{}'::jsonb;
alter table public.disparo_config drop constraint if exists disparo_config_atendimento_objeto;
alter table public.disparo_config add constraint disparo_config_atendimento_objeto check (jsonb_typeof(atendimento) = 'object');

alter table public.disparo_envios
  add column if not exists midia_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'disparo_envios_midia_da_org'
      and conrelid = 'public.disparo_envios'::regclass
  ) then
    alter table public.disparo_envios
      add constraint disparo_envios_midia_da_org
      foreign key (midia_id, organization_id)
      references public.media_library (id, organization_id)
      on delete set null (midia_id);
  end if;
end $$;

create table if not exists public.disparo_conversas (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  etapa text not null default 'respondeu'
    check (etapa in ('respondeu', 'qualificando', 'pronto_fechar', 'fechado', 'perdido', 'nao_contatar')),
  quente boolean not null default false,
  precisa_operador boolean not null default false,
  motivo_operador text,
  auto_seguidas integer not null default 0 check (auto_seguidas >= 0),
  ultima_auto_em timestamptz,
  dados jsonb not null default '{}'::jsonb check (jsonb_typeof(dados) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, lead_id)
);

create table if not exists public.disparo_leituras (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  -- A mensagem gravada pela ingestão. Apagar a mensagem (LGPD) não apaga a decisão.
  message_id uuid references public.messages(id) on delete set null,
  chave text not null check (length(chave) between 1 and 300),
  chip_id uuid,
  texto text not null default '',
  leitura jsonb not null default '{}'::jsonb check (jsonb_typeof(leitura) = 'object'),
  decisao text,
  irritada boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, chave),
  constraint disparo_leituras_chip_da_org foreign key (organization_id, chip_id)
    references public.disparo_chips (organization_id, id) on delete set null (chip_id)
);

create index if not exists disparo_leituras_do_lead on public.disparo_leituras (organization_id, lead_id, created_at desc);
create index if not exists disparo_leituras_irritadas_do_chip
  on public.disparo_leituras (organization_id, chip_id, created_at desc) where irritada;
create index if not exists disparo_conversas_com_operador
  on public.disparo_conversas (organization_id, updated_at desc) where precisa_operador or quente;

drop trigger if exists trg_disparo_conversas_updated_at on public.disparo_conversas;
create trigger trg_disparo_conversas_updated_at before update on public.disparo_conversas
  for each row execute function public.fn_set_updated_at();

alter table public.disparo_conversas enable row level security;
alter table public.disparo_leituras enable row level security;

revoke all on public.disparo_conversas from anon, authenticated;
revoke all on public.disparo_leituras from anon, authenticated;
grant select on public.disparo_conversas to authenticated;
grant select on public.disparo_leituras to authenticated;
grant all on public.disparo_conversas to service_role;
grant all on public.disparo_leituras to service_role;

drop policy if exists tenant_isolation_disparo_conversas_all on public.disparo_conversas;
create policy tenant_isolation_disparo_conversas_all on public.disparo_conversas for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_disparo_leituras_all on public.disparo_leituras;
create policy tenant_isolation_disparo_leituras_all on public.disparo_leituras for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

comment on column public.disparo_config.atendimento is
  'Atendimento do motor (perfil, respostas, objeções, kits, escada). Lido só por lib/disparo/atendimento/config.ts. {} = desligado.';
comment on table public.disparo_conversas is
  'Estado do atendimento por lead (etapa, quente, operador, automáticas seguidas). Não move o card do funil.';
comment on table public.disparo_leituras is
  'Uma leitura por mensagem do lead (idempotente por chave): o que disse, a leitura e a decisão do atendimento.';
comment on column public.disparo_envios.midia_id is
  'Mídia da resposta automática (media_library da MESMA organização). Null = só texto.';

notify pgrst, 'reload schema';
