-- 0248: funis do operador (atalhos de mensagem pronta, 06/11/2026).
--
-- O operador digita uma palavra na caixa de conversa e escolhe um funil: várias mensagens prontas que saem em
-- ordem, com o intervalo e o "digitando…/gravando…" que ele programou. Até aqui o único funil era fixo no código
-- (`lib/inbox/sequencias.ts`, "funil-valores" = modelos /valores-1..7, cadência 3 s / 29-34 s). Esta migration:
--   1. cria `operator_funnels` + `operator_funnel_steps` (cada passo aponta para um modelo de `message_templates`);
--   2. dá a `message_templates` favorito e palavras-chave (a busca da barra do chat);
--   3. dá a `disparo_envios` a presença do passo (o motor a repassa ao canal antes do envio);
--   4. semeia, em toda org que tem os 7 modelos /valores-1..7, o funil "funil-valores" na cadência que já existia,
--      para o atalho de hoje continuar funcionando sem ninguém recriar nada.
-- RLS igual à de message_templates (0060): todo membro lê compartilhados + próprios; agent+ escreve os próprios,
-- manager+ os compartilhados. Os passos herdam a visibilidade do funil pai.
-- Idempotente: pode ser re-aplicada (o baseline re-aplica no update.sh).

-- 1 · funis -----------------------------------------------------------------------------------------------------
create table if not exists public.operator_funnels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 80),
  atalho text not null check (atalho ~ '^[a-z0-9-]{2,40}$'),
  palavras_chave text[] not null default '{}',
  favorito boolean not null default false,
  ativo boolean not null default true,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operator_funnels_org_atalho_unique unique (organization_id, atalho),
  constraint operator_funnels_id_org_unique unique (id, organization_id)
);
create index if not exists idx_operator_funnels_org on public.operator_funnels (organization_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.message_templates'::regclass and c.contype in ('u', 'p')
      and c.conkey = array[(select attnum from pg_attribute where attrelid = c.conrelid and attname = 'id'),
                           (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'organization_id')]::smallint[]
  ) then
    alter table public.message_templates add constraint message_templates_id_org_0248_unique unique (id, organization_id);
  end if;
end $$;

create table if not exists public.operator_funnel_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  funnel_id uuid not null,
  position integer not null check (position >= 1),
  template_id uuid not null,
  atraso_ms integer not null default 0 check (atraso_ms between 0 and 600000),
  presenca text not null default 'nenhuma' check (presenca in ('nenhuma', 'digitando', 'gravando')),
  presenca_ms integer not null default 0 check (presenca_ms between 0 and 25000),
  created_at timestamptz not null default now(),
  constraint operator_funnel_steps_funil_fk foreign key (funnel_id, organization_id)
    references public.operator_funnels (id, organization_id) on delete cascade,
  constraint operator_funnel_steps_funil_posicao_unique unique (funnel_id, position)
);
alter table public.operator_funnel_steps drop constraint if exists operator_funnel_steps_template_id_fkey;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.operator_funnel_steps'::regclass and conname = 'operator_funnel_steps_template_org_fk') then
    alter table public.operator_funnel_steps add constraint operator_funnel_steps_template_org_fk
      foreign key (template_id, organization_id) references public.message_templates (id, organization_id) on delete restrict;
  end if;
end $$;
create index if not exists idx_operator_funnel_steps_template on public.operator_funnel_steps (template_id);
create index if not exists idx_operator_funnel_steps_org on public.operator_funnel_steps (organization_id);

alter table public.operator_funnels enable row level security;
alter table public.operator_funnel_steps enable row level security;

drop policy if exists operator_funnels_select on public.operator_funnels;
create policy operator_funnels_select on public.operator_funnels
  for select using (
    (
      organization_id in (select public.fn_user_org_ids())
      and (owner_user_id is null or owner_user_id = (select auth.uid()))
    )
    or (select public.fn_is_platform_admin())
  );

drop policy if exists operator_funnels_write on public.operator_funnels;
create policy operator_funnels_write on public.operator_funnels
  for all using (
    organization_id in (select public.fn_user_org_ids())
    and (
      (owner_user_id = (select auth.uid()) and organization_id in (select public.fn_orgs_com_papel_minimo('agent')))
      or (owner_user_id is null and organization_id in (select public.fn_orgs_com_papel_minimo('manager')))
    )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and (
      (owner_user_id = (select auth.uid()) and organization_id in (select public.fn_orgs_com_papel_minimo('agent')))
      or (owner_user_id is null and organization_id in (select public.fn_orgs_com_papel_minimo('manager')))
    )
  );

-- Os passos valem o que o funil pai vale: a subconsulta roda sob a RLS de operator_funnels.
drop policy if exists operator_funnel_steps_select on public.operator_funnel_steps;
create policy operator_funnel_steps_select on public.operator_funnel_steps
  for select using (
    exists (
      select 1 from public.operator_funnels f
       where f.id = operator_funnel_steps.funnel_id
         and f.organization_id = operator_funnel_steps.organization_id
    )
  );

drop policy if exists operator_funnel_steps_write on public.operator_funnel_steps;
create policy operator_funnel_steps_write on public.operator_funnel_steps
  for all using (
    exists (
      select 1 from public.operator_funnels f
       where f.id = operator_funnel_steps.funnel_id
         and f.organization_id = operator_funnel_steps.organization_id
         and f.organization_id in (select public.fn_user_org_ids())
         and (
           (f.owner_user_id = (select auth.uid()) and f.organization_id in (select public.fn_orgs_com_papel_minimo('agent')))
           or (f.owner_user_id is null and f.organization_id in (select public.fn_orgs_com_papel_minimo('manager')))
         )
    )
  )
  with check (
    exists (
      select 1 from public.operator_funnels f
       where f.id = operator_funnel_steps.funnel_id
         and f.organization_id = operator_funnel_steps.organization_id
         and f.organization_id in (select public.fn_user_org_ids())
         and (
           (f.owner_user_id = (select auth.uid()) and f.organization_id in (select public.fn_orgs_com_papel_minimo('agent')))
           or (f.owner_user_id is null and f.organization_id in (select public.fn_orgs_com_papel_minimo('manager')))
         )
    )
  );

-- 2 · favorito e palavras-chave nos modelos ------------------------------------------------------------------------
alter table public.message_templates add column if not exists favorito boolean not null default false;
alter table public.message_templates add column if not exists palavras_chave text[] not null default '{}';

-- 3 · presença na fila do motor ------------------------------------------------------------------------------------
alter table public.disparo_envios add column if not exists presenca text;
alter table public.disparo_envios add column if not exists presenca_ms integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'disparo_envios_presenca_check') then
    alter table public.disparo_envios add constraint disparo_envios_presenca_check
      check (presenca is null or presenca in ('nenhuma', 'digitando', 'gravando'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'disparo_envios_presenca_ms_check') then
    alter table public.disparo_envios add constraint disparo_envios_presenca_ms_check
      check (presenca_ms is null or presenca_ms between 0 and 25000);
  end if;
end $$;

create or replace function public.fn_enfileirar_funil_do_operador(p_org uuid, p_lead uuid, p_linhas jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare quantidade integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || p_lead::text, 0));
  if exists (select 1 from public.disparo_envios where organization_id = p_org and lead_id = p_lead and origem = 'operador' and estado in ('pendente', 'enviando')) then
    raise exception using errcode = 'P0001', message = 'funil_em_andamento';
  end if;
  insert into public.disparo_envios (organization_id, lead_id, chip_id, tipo, origem, texto, midia, midia_id, enviar_apos, presenca, presenca_ms, estado, enviado_em, motivo, da_parada)
  select p_org, p_lead, x.chip_id, x.tipo, 'operador', x.texto, x.midia, x.midia_id, x.enviar_apos, x.presenca, x.presenca_ms, x.estado, x.enviado_em, x.motivo, x.da_parada
    from jsonb_populate_recordset(null::public.disparo_envios, p_linhas) x;
  get diagnostics quantidade = row_count;
  return quantidade;
end $$;
revoke execute on function public.fn_enfileirar_funil_do_operador(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_enfileirar_funil_do_operador(uuid, uuid, jsonb) to service_role;

-- Salvar funil = UMA transação: cria (p_funnel null) ou atualiza metadados + dono, confere os modelos e regrava os
-- passos. Security invoker: a RLS da sessão decide quem pode (agent o próprio, manager o da organização inteira).
-- Dono: p_compartilhado = sem dono; senão o dono atual (ou quem salva, se o funil era da equipe).
-- Privacidade: funil da equipe só usa modelo da casa (owner null); funil pessoal, da casa ou do próprio dono. Modelo
-- que a sessão não enxerga (pessoal alheio) ou de outra organização conta como inexistente — mesmo erro.
drop function if exists public.fn_salvar_funil_do_operador(uuid, uuid, text, text, text[], boolean, jsonb);
create or replace function public.fn_salvar_funil_do_operador(
  p_funnel uuid, p_org uuid, p_nome text, p_atalho text, p_palavras text[], p_favorito boolean,
  p_compartilhado boolean, p_passos jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_dono uuid;
  v_ids uuid[];
  v_achados integer;
  v_pessoais integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'sem sessão';
  end if;
  if p_passos is null or jsonb_typeof(p_passos) <> 'array' or jsonb_array_length(p_passos) = 0 then
    raise exception using errcode = '22023', message = 'funil sem passos';
  end if;

  if p_funnel is null then
    insert into public.operator_funnels (organization_id, owner_user_id, nome, atalho, palavras_chave, favorito, created_by_user_id)
    values (p_org, case when p_compartilhado then null else v_uid end, p_nome, p_atalho, p_palavras, p_favorito, v_uid)
    returning id, owner_user_id into v_id, v_dono;
  else
    update public.operator_funnels
       set nome = p_nome, atalho = p_atalho, palavras_chave = p_palavras, favorito = p_favorito,
           owner_user_id = case when p_compartilhado then null else coalesce(owner_user_id, v_uid) end,
           updated_at = now()
     where id = p_funnel and organization_id = p_org
    returning id, owner_user_id into v_id, v_dono;
    if not found then
      raise exception using errcode = '42501', message = 'funil não encontrado ou sem permissão';
    end if;
  end if;

  select array_agg(distinct (passo->>'template_id')::uuid) into v_ids from jsonb_array_elements(p_passos) as itens(passo);
  select count(*), count(*) filter (where t.owner_user_id is not null and t.owner_user_id is distinct from v_dono)
    into v_achados, v_pessoais
    from public.message_templates t
   where t.organization_id = p_org and t.id = any (v_ids);
  if v_achados <> cardinality(v_ids) or v_pessoais > 0 then
    raise exception using errcode = 'P0001', message = 'funnel_modelo_pessoal';
  end if;

  delete from public.operator_funnel_steps where funnel_id = v_id and organization_id = p_org;
  insert into public.operator_funnel_steps (organization_id, funnel_id, position, template_id, atraso_ms, presenca, presenca_ms)
  select p_org, v_id, ord::integer, (passo->>'template_id')::uuid, (passo->>'atraso_ms')::integer,
         passo->>'presenca', (passo->>'presenca_ms')::integer
    from jsonb_array_elements(p_passos) with ordinality as itens(passo, ord);
  return v_id;
end $$;
revoke execute on function public.fn_salvar_funil_do_operador(uuid, uuid, text, text, text[], boolean, boolean, jsonb) from public, anon;
grant execute on function public.fn_salvar_funil_do_operador(uuid, uuid, text, text, text[], boolean, boolean, jsonb) to authenticated;

-- 4 · seed: o funil de valores que era fixo no código ----------------------------------------------------------------
-- Só em org que tem os 7 modelos. Compartilhado (owner null). Cadência que já valia: 3 s depois de passo sem áudio,
-- 31 s (meio de 29-34) depois de passo com áudio. Presença: "gravando" 20 s em áudio, "digitando" 2 s no resto
-- (o motor corta a presença no atraso do passo).
insert into public.operator_funnels (organization_id, nome, atalho, palavras_chave)
select t.organization_id, 'Funil de valores', 'funil-valores', array['valores']
  from public.message_templates t
 where t.owner_user_id is null and t.shortcut in ('/valores-1', '/valores-2', '/valores-3', '/valores-4', '/valores-5', '/valores-6', '/valores-7')
 group by t.organization_id
having count(distinct t.shortcut) = 7
on conflict (organization_id, atalho) do nothing;

with modelo as (
  select distinct on (t.organization_id, t.shortcut)
         t.organization_id,
         t.id as template_id,
         substring(t.shortcut from '-([0-9]+)$')::int as pos,
         coalesce(ml.kind = 'audio', false) as audio
    from public.message_templates t
    left join public.media_library ml on ml.id = t.media_id and ml.organization_id = t.organization_id
   where t.owner_user_id is null and t.shortcut in ('/valores-1', '/valores-2', '/valores-3', '/valores-4', '/valores-5', '/valores-6', '/valores-7')
   order by t.organization_id, t.shortcut, (t.owner_user_id is null) desc, t.created_at
), passos as (
  select m.*, lag(m.audio) over (partition by m.organization_id order by m.pos) as anterior_audio
    from modelo m
)
insert into public.operator_funnel_steps (organization_id, funnel_id, position, template_id, atraso_ms, presenca, presenca_ms)
select p.organization_id, f.id, p.pos, p.template_id,
       case when p.pos = 1 then 0 when coalesce(p.anterior_audio, false) then 31000 else 3000 end,
       case when p.audio then 'gravando' else 'digitando' end,
       case when p.audio then 20000 else 2000 end
  from passos p
  join public.operator_funnels f on f.organization_id = p.organization_id and f.atalho = 'funil-valores'
 where not exists (select 1 from public.operator_funnel_steps s where s.funnel_id = f.id);
