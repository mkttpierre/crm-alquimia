-- 0251: produto interno + valor sigiloso + registrar venda (08/11/2026).
--
-- Três pedaços do mesmo pedido do operador ("lançar pela tela do lead o que vendi, com o valor de cada produto").
--
-- 1 · `catalog_products.so_interno`. Os planos importados do DataCrazy têm como preço o valor da COMISSÃO do operador, não
--     o preço cobrado do cliente. Esse número nunca pode chegar ao agente de IA, ao MCP, à loja nem ao lead. A coluna marca
--     o produto como "só para registrar venda": todo leitor que entrega catálogo à IA filtra `so_interno = false`
--     (`lib/mcp/tools/comercio.ts`; a varredura de `tests/unit/produto-interno-nao-vaza.test.ts` reprova leitor novo sem o
--     filtro). Default `false`: nada que já existe muda.
--
-- 2 · `crm_leads.valor_sigiloso`. O valor do NEGÓCIO (`value_cents`, derivado da soma das linhas) herda o sigilo: um negócio
--     com linha de produto interno, ou nascido de "Registrar venda", guarda a comissão. A marca é do BANCO e é PEGAJOSA:
--       · liga sozinha quando entra linha de produto `so_interno` (trigger em `crm_lead_items`, também ao trocar o produto
--         da linha), quando um produto vira `so_interno` com linhas já gravadas (trigger em `catalog_products`) e em TODA venda
--         registrada, inclusive só com item avulso (`fn_registrar_venda`);
--       · nunca volta a `false` (trigger BEFORE UPDATE), mesmo apagando a linha ou o produto: o dado que já foi comissão
--         continua sendo comissão.
--       · também liga quando uma linha MUDA DE NEGÓCIO (`update of lead_id`): o destino recalcula o valor com aquela linha,
--         então herda o sigilo se a linha é de produto interno OU vem de um negócio que já era sigiloso (item avulso de uma
--         venda registrada também é comissão).
--     Sigilo e idempotência são coisas diferentes: `crm_venda_chaves` só deduplica a requisição; quem decide o que a IA, o
--     MCP e as integrações de saída podem ver é esta coluna. Backfill idempotente no fim: quem já tem linha interna ou chave
--     de venda nasce marcado.
--
-- 3 · `fn_registrar_venda`. Registrar uma venda é UMA operação: achar (ou criar) o negócio, gravar as linhas de produto
--     e marcar como ganho na data informada. O cliente PostgREST não abre transação, então a atomicidade mora numa função
--     SECURITY INVOKER (a RLS de quem chama continua valendo, inclusive o papel agent+ de `crm_lead_items` e `crm_leads`):
--     qualquer erro no meio desfaz tudo, e não sobra venda pela metade. O ganho reaproveita o caminho que já existe (mover
--     para a etapa `is_won`, onde `fn_crm_lead_close_on_stage` escreve o status e `fn_emit_event_on_lead_change` grava
--     `lead.won`); a data da venda é o `closed_at`, que é exatamente o que o Faturamento já lê, então não precisa de coluna
--     nova para a data. "Qual negócio será usado" é `fn_escolher_negocio_da_venda`, UMA função para a operação e para a
--     prévia que o quadro mostra antes de confirmar (mesma regra, uma só implementação).
--
--     Idempotência: `crm_venda_chaves (organization_id, chave, lead_id)` guarda TODA `Idempotency-Key` já usada por uma venda
--     (chave primária por organização, RLS própria). Uma tabela, e não uma coluna em `crm_leads`: com a coluna, vender (K1),
--     reabrir o negócio e vender de novo (K2) trocava a chave e perdia K1; retentar K1 duplicava a venda. Repetir uma
--     chave devolve a mesma venda sem gravar de novo (mesmo depois de o negócio ter ganhado outra chave); duas requisições
--     simultâneas com a mesma chave caem no `unique_violation` e a perdedora devolve a venda da vencedora.
--
--     Alvo previsto: o quadro manda o negócio que MOSTROU (`p_negocio_previsto`: o id, ou `novo`). Se na hora de confirmar o
--     alvo real é outro (alguém encerrou o negócio mostrado), a função recusa com `venda:alvo_mudou` e nada é gravado: a
--     venda nunca cai em outro negócio, nem abre um novo, em silêncio. Sem previsão (`null`) não há conferência.
--
--     Data da venda: "futura" é por DIA CIVIL no fuso da organização (a mesma regra do TS e da tela), sem folga de minutos.
--
--     Erros de negócio saem como `venda:<codigo>` (a API mapeia para 4xx).
-- Idempotente: pode ser re-aplicada (o baseline re-aplica no update.sh).

-- 1 · produto interno ------------------------------------------------------------------------------------------------
alter table public.catalog_products
  add column if not exists so_interno boolean not null default false;

comment on column public.catalog_products.so_interno is
  'Produto só para registrar venda (ex.: plano de comissão do operador). O preço NÃO é de venda ao cliente: IA, MCP, loja e lead nunca o leem. Todo leitor que entrega catálogo ao agente filtra so_interno = false.';

-- 2 · chaves de idempotência da venda -------------------------------------------------------------------------------
-- Uma linha por Idempotency-Key já usada, nunca substituída: o negócio pode ser reaberto e vendido de novo (outra chave)
-- sem apagar o rastro da primeira. `on delete cascade` pelo negócio: se o negócio some, a venda some junto.
create table if not exists public.crm_venda_chaves (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chave text not null check (char_length(chave) between 1 and 200),
  lead_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, chave)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.crm_venda_chaves'::regclass and conname = 'crm_venda_chaves_lead_org_fk') then
    alter table public.crm_venda_chaves add constraint crm_venda_chaves_lead_org_fk
      foreign key (lead_id, organization_id) references public.crm_leads (id, organization_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_crm_venda_chaves_lead on public.crm_venda_chaves (lead_id, organization_id);

comment on table public.crm_venda_chaves is
  'Idempotency-Key de cada "Registrar venda" (única por organização, nunca substituída). Repetir a chave devolve a mesma venda. NÃO é a marca de sigilo (ver crm_leads.valor_sigiloso). Migration 0251.';

alter table public.crm_venda_chaves enable row level security;

-- Leitura por membro da organização; escrita só de quem pode vender (agent+), e só apontando para negócio da própria
-- organização. Sem policy de UPDATE/DELETE: a chave é imutável (o cascade do negócio apaga por baixo da RLS).
drop policy if exists crm_venda_chaves_select on public.crm_venda_chaves;
create policy crm_venda_chaves_select on public.crm_venda_chaves
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists crm_venda_chaves_insert on public.crm_venda_chaves;
create policy crm_venda_chaves_insert on public.crm_venda_chaves
  for insert with check (
    organization_id in (select public.fn_user_org_ids())
    and organization_id in (select public.fn_orgs_com_papel_minimo('agent'))
    and exists (select 1 from public.crm_leads l where l.id = crm_venda_chaves.lead_id and l.organization_id = crm_venda_chaves.organization_id)
  );

-- 3 · valor sigiloso do negócio (pegajoso) ---------------------------------------------------------------------------
alter table public.crm_leads
  add column if not exists valor_sigiloso boolean not null default false;

comment on column public.crm_leads.valor_sigiloso is
  'O valor deste negócio é comissão do operador: IA, MCP e integrações de saída não o veem. Ligada pelo banco (linha de produto so_interno, venda registrada) e PEGAJOSA: nunca volta a false.';

create or replace function public.fn_crm_leads_valor_sigiloso_pegajoso()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.valor_sigiloso := true;
  return new;
end $$;

drop trigger if exists trg_crm_leads_valor_sigiloso_pegajoso on public.crm_leads;
create trigger trg_crm_leads_valor_sigiloso_pegajoso before update on public.crm_leads
  for each row when (old.valor_sigiloso and not new.valor_sigiloso)
  execute function public.fn_crm_leads_valor_sigiloso_pegajoso();

-- Linha de produto interno entrando no negócio (aba Produtos, venda registrada, API): o negócio vira sigiloso. Vale também
-- quando a linha MUDA DE NEGÓCIO (`lead_id`): o destino recalcula o valor com ela, então herda o sigilo se a linha é de
-- produto interno (como no insert) ou se veio de um negócio que já era sigiloso (item avulso de venda registrada é comissão).
create or replace function public.fn_crm_lead_items_marca_sigilo()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if (
    new.product_id is not null and exists (
      select 1 from public.catalog_products p
       where p.id = new.product_id and p.organization_id = new.organization_id and p.so_interno)
  ) or (
    tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id and exists (
      select 1 from public.crm_leads o
       where o.id = old.lead_id and o.organization_id = old.organization_id and o.valor_sigiloso)
  ) then
    update public.crm_leads set valor_sigiloso = true
     where id = new.lead_id and organization_id = new.organization_id and not valor_sigiloso;
  end if;
  return new;
end $$;

drop trigger if exists trg_crm_lead_items_sigilo on public.crm_lead_items;
create trigger trg_crm_lead_items_sigilo after insert or update of product_id, lead_id on public.crm_lead_items
  for each row execute function public.fn_crm_lead_items_marca_sigilo();

-- Produto que VIRA interno depois de já ter linhas em negócios (ex.: a importação dos planos reaproveita um código).
create or replace function public.fn_catalog_products_marca_sigilo()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.so_interno and not old.so_interno then
    update public.crm_leads l set valor_sigiloso = true
     where l.organization_id = new.organization_id and not l.valor_sigiloso
       and exists (
         select 1 from public.crm_lead_items i
          where i.lead_id = l.id and i.organization_id = l.organization_id and i.product_id = new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_catalog_products_sigilo on public.catalog_products;
create trigger trg_catalog_products_sigilo after update of so_interno on public.catalog_products
  for each row execute function public.fn_catalog_products_marca_sigilo();

-- O evento `lead.won` NÃO leva o valor de um negócio sigiloso (o event_log alimenta automações e webhooks de saída).
-- Mesmo corpo da 0070, só o ramo `won` muda.
create or replace function public.fn_emit_event_on_lead_change() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'won' then
      perform public.fn_log_event(new.organization_id, 'lead.won',
        case when new.valor_sigiloso
             then jsonb_build_object('lead_id', new.id)
             else jsonb_build_object('lead_id', new.id, 'value_cents', new.value_cents) end);
    elsif new.status = 'lost' then
      perform public.fn_log_event(new.organization_id, 'lead.lost',
        jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason));
    elsif new.status = 'open' then
      perform public.fn_log_event(new.organization_id, 'lead.reopened',
        jsonb_build_object('lead_id', new.id));
    end if;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id
     or new.owner_agent_id is distinct from old.owner_agent_id then
    perform public.fn_log_event(new.organization_id, 'lead.assigned',
      jsonb_build_object(
        'lead_id', new.id,
        'from_user_id', old.owner_user_id, 'to_user_id', new.owner_user_id,
        'from_agent_id', old.owner_agent_id, 'to_agent_id', new.owner_agent_id,
        'owner_kind', new.owner_kind));
  end if;

  return new;
end$$;

-- Backfill (idempotente): quem já tem linha de produto interno, ou nasceu de uma venda registrada, fica marcado.
-- Só toca linha que ainda não está marcada, então re-aplicar não mexe em nada.
update public.crm_leads l set valor_sigiloso = true
 where not l.valor_sigiloso
   and (
     exists (select 1 from public.crm_venda_chaves k where k.lead_id = l.id and k.organization_id = l.organization_id)
     or exists (
       select 1 from public.crm_lead_items i
         join public.catalog_products p on p.id = i.product_id and p.organization_id = i.organization_id
        where i.lead_id = l.id and i.organization_id = l.organization_id and p.so_interno)
   );

-- 4 · qual negócio a venda vai usar ----------------------------------------------------------------------------------
-- 1) o negócio aberto do dossiê; 2) o aberto mais recente do contato; senão `null` (a venda abre um novo). Com
-- `p_travar` a linha é travada (`for update`) para a operação; sem ele é só leitura, para a prévia do quadro.
create or replace function public.fn_escolher_negocio_da_venda(
  p_org uuid,
  p_contact uuid,
  p_lead uuid,
  p_travar boolean default false
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
  v_contact uuid := p_contact;
begin
  if p_lead is not null then
    if p_travar then
      select id into v_id from public.crm_leads where id = p_lead and organization_id = p_org and status = 'open' for update;
    else
      select id into v_id from public.crm_leads where id = p_lead and organization_id = p_org and status = 'open';
    end if;
    if v_id is not null then
      return v_id;
    end if;
    if v_contact is null then
      select contact_id into v_contact from public.crm_leads where id = p_lead and organization_id = p_org;
    end if;
  end if;
  if v_contact is null then
    return null;
  end if;
  if p_travar then
    select id into v_id from public.crm_leads
     where organization_id = p_org and contact_id = v_contact and status = 'open'
     order by created_at desc limit 1 for update;
  else
    select id into v_id from public.crm_leads
     where organization_id = p_org and contact_id = v_contact and status = 'open'
     order by created_at desc limit 1;
  end if;
  return v_id;
end $$;

comment on function public.fn_escolher_negocio_da_venda(uuid, uuid, uuid, boolean) is
  'Qual negócio aberto a venda usa (dossiê, senão o aberto mais recente do contato, senão null). Mesma regra para a operação (travando) e para a prévia do quadro. Migration 0251.';

revoke execute on function public.fn_escolher_negocio_da_venda(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.fn_escolher_negocio_da_venda(uuid, uuid, uuid, boolean) to authenticated, service_role;

-- 5 · a operação atômica ---------------------------------------------------------------------------------------------
-- Troca de assinatura (ganhou `p_negocio_previsto`): sem este drop, um banco que já tivesse a versão de 6 argumentos
-- ficaria com DUAS funções (create or replace não troca a assinatura) e a chamada do PostgREST viraria ambígua.
drop function if exists public.fn_registrar_venda(uuid, uuid, uuid, timestamptz, jsonb, text);

create or replace function public.fn_registrar_venda(
  p_org uuid,
  p_contact uuid,
  p_lead uuid,
  p_fechada_em timestamptz,
  p_itens jsonb,
  p_chave text,
  p_negocio_previsto text default null
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_fechada timestamptz := coalesce(p_fechada_em, now());
  v_tz text;
  v_ref public.crm_leads%rowtype;
  v_lead public.crm_leads%rowtype;
  v_lead_id uuid;
  v_criado boolean := false;
  v_contact uuid := p_contact;
  v_contato public.contacts%rowtype;
  v_moeda text;
  v_pipeline uuid;
  v_etapa_origem uuid;
  v_etapa_ganho uuid;
  v_pos numeric;
  v_item jsonb;
  v_prod public.catalog_products%rowtype;
  v_prod_id uuid;
  v_qtd integer;
  v_preco bigint;
  v_desc bigint;
  v_nome text;
  v_sku text;
  v_titulo text;
  v_valor bigint;
begin
  if p_org is null or (p_contact is null and p_lead is null) then
    raise exception 'venda:entrada_invalida';
  end if;
  if jsonb_typeof(p_itens) is distinct from 'array' or jsonb_array_length(p_itens) not between 1 and 50 then
    raise exception 'venda:itens_invalidos';
  end if;
  if p_chave is not null and char_length(p_chave) not between 1 and 200 then
    raise exception 'venda:chave_invalida';
  end if;
  -- O negócio que o quadro mostrou: o id dele ou `novo`. Outra coisa é entrada inválida (não é "o alvo mudou").
  if p_negocio_previsto is not null
     and p_negocio_previsto <> 'novo'
     and p_negocio_previsto !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'venda:entrada_invalida';
  end if;

  -- "Futura" é por DIA CIVIL no fuso da organização (a regra do TS e da tela). Sem folga de minutos: o instante de "hoje"
  -- que o servidor manda nunca passa do dia de hoje, e relógio adiantado de navegador não vira venda do dia seguinte.
  select o.timezone into v_tz from public.organizations o where o.id = p_org;
  if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = v_tz) then
    v_tz := 'America/Sao_Paulo';
  end if;
  if (v_fechada at time zone v_tz)::date > (now() at time zone v_tz)::date then
    raise exception 'venda:data_futura';
  end if;

  begin
    -- Idempotência: a chave já ganhou um negócio desta organização.
    if p_chave is not null then
      select l.* into v_lead
        from public.crm_venda_chaves k
        join public.crm_leads l on l.id = k.lead_id and l.organization_id = k.organization_id
       where k.organization_id = p_org and k.chave = p_chave;
      if found then
        return jsonb_build_object(
          'ja_registrada', true, 'criado', false,
          'lead_id', v_lead.id, 'contact_id', v_lead.contact_id, 'pipeline_id', v_lead.pipeline_id,
          'from_stage_id', null, 'to_stage_id', v_lead.stage_id, 'currency', coalesce(v_lead.currency, 'BRL'),
          'total_cents', coalesce(v_lead.value_cents, 0), 'closed_at', v_lead.closed_at, 'title', v_lead.title);
      end if;
    end if;

    -- Negócio de referência (dossiê): tem de ser desta organização e, se veio contato, do mesmo contato.
    if p_lead is not null then
      select * into v_ref from public.crm_leads where id = p_lead and organization_id = p_org;
      if not found then
        raise exception 'venda:negocio_nao_encontrado';
      end if;
      if p_contact is not null and v_ref.contact_id is distinct from p_contact then
        raise exception 'venda:negocio_de_outro_contato';
      end if;
      v_contact := v_ref.contact_id;
    end if;

    if v_contact is not null then
      select * into v_contato from public.contacts where id = v_contact and organization_id = p_org;
      if not found then
        raise exception 'venda:contato_nao_encontrado';
      end if;
      if v_contato.is_anonymized then
        raise exception 'venda:contato_anonimizado';
      end if;
    end if;

    -- O negócio aberto (dossiê, senão o mais recente do contato), travado; senão um novo (recompra cai aqui).
    v_lead_id := public.fn_escolher_negocio_da_venda(p_org, v_contact, p_lead, true);
    -- O alvo real (já travado) tem de ser o que o quadro mostrou. Se outro operador encerrou o negócio mostrado, a venda
    -- não cai em outro negócio nem abre um novo em silêncio: recusa, e o quadro recarrega a prévia.
    if p_negocio_previsto is not null
       and (case when p_negocio_previsto = 'novo' then v_lead_id is not null
                 else v_lead_id is distinct from p_negocio_previsto::uuid end) then
      raise exception 'venda:alvo_mudou';
    end if;
    if v_lead_id is not null then
      select * into v_lead from public.crm_leads where id = v_lead_id and organization_id = p_org;
    else
      if v_contact is null then
        raise exception 'venda:sem_contato_para_novo_negocio';
      end if;
      v_pipeline := case when p_lead is not null then v_ref.pipeline_id end;
      if v_pipeline is null then
        select id into v_pipeline from public.crm_pipelines
         where organization_id = p_org and not is_archived
         order by is_default desc, position asc, created_at asc limit 1;
      end if;
      if v_pipeline is null then
        raise exception 'venda:sem_funil';
      end if;
      select id into v_etapa_origem from public.crm_stages
       where organization_id = p_org and pipeline_id = v_pipeline and not is_archived and not is_won and not is_lost
       order by position asc limit 1;
      if v_etapa_origem is null then
        raise exception 'venda:sem_etapa';
      end if;
      select coalesce(currency, 'BRL') into v_moeda from public.organizations where id = p_org;
      v_titulo := left('Venda — ' || coalesce(nullif(btrim(v_contato.display_name), ''), nullif(btrim(v_contato.name), ''), v_contato.phone_number, 'Contato'), 200);
      select coalesce(max(position_in_stage), 0) + 1000 into v_pos from public.crm_leads where organization_id = p_org and stage_id = v_etapa_origem;

      insert into public.crm_leads (
        organization_id, pipeline_id, stage_id, contact_id, title, status, currency, source, source_metadata,
        position_in_stage, owner_user_id, owner_kind, assigned_at, created_by_user_id, valor_sigiloso)
      values (
        p_org, v_pipeline, v_etapa_origem, v_contact, v_titulo, 'open', coalesce(v_moeda, 'BRL'), 'manual',
        jsonb_build_object('origem', 'registrar_venda'),
        v_pos, v_user, case when v_user is null then null else 'user' end,
        case when v_user is null then null else now() end, v_user, true)
      returning * into v_lead;
      v_criado := true;
      -- Mesmo evento que `createLeadHandler` emite, na mesma transação (event_log é tabela, nunca HTTP).
      perform public.emit_event(
        'lead.created', 'crm_lead', v_lead.id,
        jsonb_build_object('pipeline_id', v_lead.pipeline_id, 'stage_id', v_lead.stage_id, 'title', v_lead.title),
        jsonb_build_object('origem', 'registrar_venda'), p_org);
    end if;

    v_moeda := coalesce(v_lead.currency, 'BRL');

    -- Linhas de produto: nome/sku são snapshot do catálogo; o PREÇO é o que veio na linha (editável por linha).
    for v_item in select value from jsonb_array_elements(p_itens) loop
      v_qtd := coalesce((v_item->>'quantidade')::integer, 1);
      v_desc := coalesce((v_item->>'desconto_cents')::bigint, 0);
      v_preco := (v_item->>'preco_unit_cents')::bigint;
      if v_preco is null then
        raise exception 'venda:item_sem_preco';
      end if;
      v_prod_id := nullif(v_item->>'product_id', '')::uuid;
      if v_prod_id is not null then
        select * into v_prod from public.catalog_products where id = v_prod_id and organization_id = p_org;
        if not found then
          raise exception 'venda:produto_nao_encontrado';
        end if;
        if v_prod.moeda is distinct from v_moeda then
          raise exception 'venda:moeda_divergente';
        end if;
        v_nome := v_prod.nome;
        v_sku := v_prod.codigo;
      else
        v_nome := nullif(btrim(v_item->>'nome'), '');
        v_sku := nullif(btrim(v_item->>'sku'), '');
        if v_nome is null then
          raise exception 'venda:item_sem_nome';
        end if;
      end if;
      insert into public.crm_lead_items (
        organization_id, lead_id, product_id, nome, sku, quantidade, preco_unit_cents, desconto_cents, currency, created_by_user_id)
      values (p_org, v_lead.id, v_prod_id, left(v_nome, 200), left(v_sku, 80), v_qtd, v_preco, v_desc, v_moeda, v_user);
    end loop;

    -- Ganho: mesma regra do "marcar como ganho" (etapa is_won do funil do negócio). O trigger põe status = 'won' e respeita o
    -- `closed_at` que passamos (coalesce), que é a data da venda. TODA venda registrada é de valor sigiloso, inclusive a que
    -- só tem item avulso: a marca vai no MESMO update do ganho, então o evento `lead.won` já nasce sem o valor.
    select id into v_etapa_ganho from public.crm_stages
     where organization_id = p_org and pipeline_id = v_lead.pipeline_id and is_won and not is_archived
     order by position asc limit 1;
    if v_etapa_ganho is null then
      raise exception 'venda:pipeline_no_won_stage';
    end if;
    select coalesce(max(position_in_stage), 0) + 1000 into v_pos from public.crm_leads where organization_id = p_org and stage_id = v_etapa_ganho;

    update public.crm_leads
       set stage_id = v_etapa_ganho, position_in_stage = v_pos, closed_at = v_fechada,
           valor_sigiloso = true, updated_at = now()
     where id = v_lead.id and organization_id = p_org
     returning value_cents into v_valor;

    -- A chave fica registrada (nunca substituída). Chave repetida em paralelo cai no unique_violation abaixo.
    if p_chave is not null then
      insert into public.crm_venda_chaves (organization_id, chave, lead_id) values (p_org, p_chave, v_lead.id);
    end if;

    return jsonb_build_object(
      'ja_registrada', false, 'criado', v_criado,
      'lead_id', v_lead.id, 'contact_id', v_lead.contact_id, 'pipeline_id', v_lead.pipeline_id,
      'from_stage_id', v_lead.stage_id, 'to_stage_id', v_etapa_ganho, 'currency', v_moeda,
      'total_cents', coalesce(v_valor, 0), 'closed_at', v_fechada, 'title', v_lead.title);
  exception when unique_violation then
    -- Duas requisições com a mesma chave ao mesmo tempo: a perdedora desfaz tudo e devolve a venda da vencedora.
    if p_chave is not null then
      select l.* into v_lead
        from public.crm_venda_chaves k
        join public.crm_leads l on l.id = k.lead_id and l.organization_id = k.organization_id
       where k.organization_id = p_org and k.chave = p_chave;
      if found then
        return jsonb_build_object(
          'ja_registrada', true, 'criado', false,
          'lead_id', v_lead.id, 'contact_id', v_lead.contact_id, 'pipeline_id', v_lead.pipeline_id,
          'from_stage_id', null, 'to_stage_id', v_lead.stage_id, 'currency', coalesce(v_lead.currency, 'BRL'),
          'total_cents', coalesce(v_lead.value_cents, 0), 'closed_at', v_lead.closed_at, 'title', v_lead.title);
      end if;
    end if;
    raise;
  end;
end $$;

comment on function public.fn_registrar_venda(uuid, uuid, uuid, timestamptz, jsonb, text, text) is
  'Registrar venda numa transação só: negócio aberto (ou novo) + linhas de produto + ganho na data informada, marcando o negócio como de valor sigiloso. SECURITY INVOKER: a RLS de quem chama vale. Idempotente por p_chave. Migration 0251.';

revoke execute on function public.fn_registrar_venda(uuid, uuid, uuid, timestamptz, jsonb, text, text) from public, anon;
grant execute on function public.fn_registrar_venda(uuid, uuid, uuid, timestamptz, jsonb, text, text) to authenticated, service_role;

revoke execute on function public.fn_crm_leads_valor_sigiloso_pegajoso() from public, anon;
grant execute on function public.fn_crm_leads_valor_sigiloso_pegajoso() to authenticated, service_role;
revoke execute on function public.fn_crm_lead_items_marca_sigilo() from public, anon;
grant execute on function public.fn_crm_lead_items_marca_sigilo() to authenticated, service_role;
revoke execute on function public.fn_catalog_products_marca_sigilo() from public, anon;
grant execute on function public.fn_catalog_products_marca_sigilo() to authenticated, service_role;

notify pgrst, 'reload schema';
