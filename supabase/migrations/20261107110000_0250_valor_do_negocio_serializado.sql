-- 0250 · valor do negócio derivado dos itens, serializado por negócio (forward-fix da 0249)
--
-- Defeito (revisão de 07/11/2026): duas transações inserindo itens no MESMO negócio calculavam a soma cada uma sem
-- enxergar o item da outra (READ COMMITTED), e a última a gravar sobrescrevia `crm_leads.value_cents` com uma soma
-- incompleta. Agora a função trava a linha do negócio (`for update`) ANTES de somar: a segunda transação espera a
-- primeira terminar e, como cada comando em READ COMMITTED tira um snapshot novo, a soma dela já inclui o item da
-- primeira. Mesma assinatura, mesmo `security invoker`, sem HTTP. Idempotente (`create or replace`).

create or replace function public.fn_recalcular_valor_do_negocio(p_lead uuid, p_org uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_moeda text;
  v_qtd integer;
  v_soma bigint;
begin
  select coalesce(l.currency, 'BRL') into v_moeda
    from public.crm_leads l where l.id = p_lead and l.organization_id = p_org
    for update;
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

revoke execute on function public.fn_recalcular_valor_do_negocio(uuid, uuid) from public, anon;
grant execute on function public.fn_recalcular_valor_do_negocio(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
