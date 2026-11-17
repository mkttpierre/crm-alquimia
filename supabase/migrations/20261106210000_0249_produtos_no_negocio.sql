-- 0249: produtos no negócio (Fase B0, 06/11/2026).
--
-- O operador vende por WhatsApp e hoje o negócio (`crm_leads`) só tem um número solto em `value_cents`: ninguém sabe
-- O QUE foi vendido, quantos, com que desconto ou cupom. Esta migration cria `crm_lead_items`, as linhas de produto do
-- negócio (o que o DataCrazy chama de aba "Produtos e Valores"): produto do catálogo ou avulso, quantidade, preço
-- unitário, desconto, acréscimo, cupom. O total da linha é coluna GERADA (nunca gravada à mão).
--
-- DECISÕES (DIRC):
--   · nome/sku/preço/moeda são COPIADOS no momento (snapshot): o preço do catálogo muda, o que foi vendido não. O
--     `product_id` é só ponteiro (Referenciar) e vira NULL se o produto sair do catálogo — o histórico fica.
--   · o total da linha é CALCULADO (coluna gerada stored): quantidade × preço − desconto + acréscimo.
--   · `crm_leads.value_cents` JÁ existe e é lido pelo quadro, relatórios e agente. Em vez de obrigar todo leitor a somar
--     itens, o valor do negócio é DERIVADO dos itens por trigger SEM HTTP (mesma transação), e só enquanto houver item
--     na moeda do negócio. Sem itens, o valor digitado à mão segue valendo. O trigger só escreve quando o número muda
--     (senão `trg_crm_leads_updated_at` piscaria o quadro e invalidaria a trava otimista de um arrasto em voo — o
--     "409 fantasma" do cabeçalho da 0075).
--   · RLS: o item vale o que o negócio vale. A subconsulta em `crm_leads` roda sob a RLS de quem pergunta, então quem
--     não enxerga o negócio não enxerga os itens. Escrita: agent+.
-- Idempotente: pode ser re-aplicada (o baseline re-aplica no update.sh).

-- 1 · chaves compostas para as FKs por organização -------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.crm_leads'::regclass and c.contype in ('u', 'p')
      and c.conkey = array[(select attnum from pg_attribute where attrelid = c.conrelid and attname = 'id'),
                           (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'organization_id')]::smallint[]
  ) then
    alter table public.crm_leads add constraint crm_leads_id_org_0249_unique unique (id, organization_id);
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.catalog_products'::regclass and c.contype in ('u', 'p')
      and c.conkey = array[(select attnum from pg_attribute where attrelid = c.conrelid and attname = 'id'),
                           (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'organization_id')]::smallint[]
  ) then
    alter table public.catalog_products add constraint catalog_products_id_org_0249_unique unique (id, organization_id);
  end if;
end $$;

-- 2 · itens do negócio -----------------------------------------------------------------------------------------------
create table if not exists public.crm_lead_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null,
  product_id uuid,
  nome text not null check (char_length(nome) between 1 and 200),
  sku text check (sku is null or char_length(sku) between 1 and 80),
  quantidade integer not null default 1 check (quantidade between 1 and 100000),
  preco_unit_cents bigint not null check (preco_unit_cents >= 0),
  desconto_cents bigint not null default 0 check (desconto_cents >= 0),
  acrescimo_cents bigint not null default 0 check (acrescimo_cents >= 0),
  cupom text check (cupom is null or char_length(cupom) between 1 and 40),
  currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  total_cents bigint generated always as ((quantidade::bigint * preco_unit_cents) - desconto_cents + acrescimo_cents) stored,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_lead_items_total_nao_negativo check (total_cents >= 0)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.crm_lead_items'::regclass and conname = 'crm_lead_items_lead_org_fk') then
    alter table public.crm_lead_items add constraint crm_lead_items_lead_org_fk
      foreign key (lead_id, organization_id) references public.crm_leads (id, organization_id) on delete cascade;
  end if;
  -- Produto saiu do catálogo: o item fica (snapshot), só o ponteiro some. Coluna explícita no SET NULL (PG 15+)
  -- porque `organization_id` é NOT NULL e faz parte da mesma FK.
  if not exists (select 1 from pg_constraint where conrelid = 'public.crm_lead_items'::regclass and conname = 'crm_lead_items_produto_org_fk') then
    alter table public.crm_lead_items add constraint crm_lead_items_produto_org_fk
      foreign key (product_id, organization_id) references public.catalog_products (id, organization_id) on delete set null (product_id);
  end if;
end $$;

-- Colunas na ordem das FKs compostas (lead_id, organization_id) e (product_id, organization_id): a FK acha o índice e a
-- consulta da tela (lead + organização) usa o mesmo.
create index if not exists idx_crm_lead_items_lead on public.crm_lead_items (lead_id, organization_id);
create index if not exists idx_crm_lead_items_produto on public.crm_lead_items (product_id, organization_id) where product_id is not null;

drop trigger if exists trg_crm_lead_items_updated_at on public.crm_lead_items;
create trigger trg_crm_lead_items_updated_at before update on public.crm_lead_items
  for each row execute function public.fn_set_updated_at();

-- 3 · RLS ------------------------------------------------------------------------------------------------------------
alter table public.crm_lead_items enable row level security;

drop policy if exists crm_lead_items_select on public.crm_lead_items;
create policy crm_lead_items_select on public.crm_lead_items
  for select using (
    (select public.fn_is_platform_admin())
    or (
      organization_id in (select public.fn_user_org_ids())
      and exists (select 1 from public.crm_leads l where l.id = crm_lead_items.lead_id and l.organization_id = crm_lead_items.organization_id)
    )
  );

drop policy if exists crm_lead_items_insert on public.crm_lead_items;
create policy crm_lead_items_insert on public.crm_lead_items
  for insert with check (
    organization_id in (select public.fn_user_org_ids())
    and organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
    and exists (select 1 from public.crm_leads l where l.id = crm_lead_items.lead_id and l.organization_id = crm_lead_items.organization_id)
  );

drop policy if exists crm_lead_items_update on public.crm_lead_items;
create policy crm_lead_items_update on public.crm_lead_items
  for update using (
    organization_id in (select public.fn_user_org_ids())
    and organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
    and exists (select 1 from public.crm_leads l where l.id = crm_lead_items.lead_id and l.organization_id = crm_lead_items.organization_id)
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
    and exists (select 1 from public.crm_leads l where l.id = crm_lead_items.lead_id and l.organization_id = crm_lead_items.organization_id)
  );

drop policy if exists crm_lead_items_delete on public.crm_lead_items;
create policy crm_lead_items_delete on public.crm_lead_items
  for delete using (
    organization_id in (select public.fn_user_org_ids())
    and organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
    and exists (select 1 from public.crm_leads l where l.id = crm_lead_items.lead_id and l.organization_id = crm_lead_items.organization_id)
  );

-- 4 · valor do negócio derivado dos itens (sem HTTP, mesma transação) ------------------------------------------------
create or replace function public.fn_recalcular_valor_do_negocio(p_lead uuid, p_org uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_moeda text;
  v_qtd integer;
  v_soma bigint;
begin
  select coalesce(l.currency, 'BRL') into v_moeda
    from public.crm_leads l where l.id = p_lead and l.organization_id = p_org;
  if not found then
    return;
  end if;
  select count(*), coalesce(sum(i.total_cents), 0) into v_qtd, v_soma
    from public.crm_lead_items i
   where i.lead_id = p_lead and i.organization_id = p_org and i.currency = v_moeda;
  -- Sem itens na moeda do negócio, o valor digitado à mão segue valendo.
  if v_qtd = 0 then
    return;
  end if;
  update public.crm_leads set value_cents = v_soma
   where id = p_lead and organization_id = p_org and value_cents is distinct from v_soma;
end $$;

create or replace function public.fn_crm_lead_items_sincroniza_valor()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform public.fn_recalcular_valor_do_negocio(old.lead_id, old.organization_id);
    return old;
  end if;
  perform public.fn_recalcular_valor_do_negocio(new.lead_id, new.organization_id);
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then
    perform public.fn_recalcular_valor_do_negocio(old.lead_id, old.organization_id);
  end if;
  return new;
end $$;

drop trigger if exists trg_crm_lead_items_valor on public.crm_lead_items;
create trigger trg_crm_lead_items_valor after insert or update or delete on public.crm_lead_items
  for each row execute function public.fn_crm_lead_items_sincroniza_valor();

revoke execute on function public.fn_recalcular_valor_do_negocio(uuid, uuid) from public, anon;
grant execute on function public.fn_recalcular_valor_do_negocio(uuid, uuid) to authenticated, service_role;
revoke execute on function public.fn_crm_lead_items_sincroniza_valor() from public, anon;
grant execute on function public.fn_crm_lead_items_sincroniza_valor() to authenticated, service_role;

notify pgrst, 'reload schema';
