-- Retenção do arquivo de webhooks em lote, dentro do banco.
--
-- O cron `webhook-log-retention` escolhia 500 ids e os mandava no `.in()` da URL
-- do PostgREST: "URI too long", a cada 5 min, e `webhook_events_log` chegou a
-- 2,16 GB (97% do banco). Esta função faz o mesmo trabalho com subselect + LIMIT
-- no próprio Postgres e devolve quantas linhas mexeu. SECURITY DEFINER com
-- search_path fixo; EXECUTE só para service_role. Não toca dado de tenant além de
-- esvaziar/apagar o arquivo forense (a tabela já é podada pelo código antigo).
-- Aditiva e idempotente (create or replace).

create or replace function public.fn_podar_webhook_events_log(
  p_dias_com_corpo int,
  p_dias_para_apagar int,
  p_lote int default 500
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lote int := greatest(1, least(coalesce(p_lote, 500), 5000));
  v_esvaziadas int := 0;
  v_apagadas int := 0;
begin
  if p_dias_com_corpo is null or p_dias_com_corpo < 0
     or p_dias_para_apagar is null or p_dias_para_apagar < 0 then
    raise exception 'retencao_dias_invalidos' using errcode = '22023';
  end if;

  -- 1. Esvazia o corpo das linhas velhas. `skip locked` + lote: nunca segura a
  --    tabela em que todo webhook escreve.
  with alvo as (
    select id from public.webhook_events_log
     where archived_at is null
       and received_at < now() - make_interval(days => p_dias_com_corpo)
     order by received_at
     limit v_lote
     for update skip locked
  )
  update public.webhook_events_log w
     set raw_body = null, payload_parsed = null, headers = null, archived_at = now()
    from alvo
   where w.id = alvo.id;
  get diagnostics v_esvaziadas = row_count;

  -- 2. Apaga as velhas demais.
  with alvo as (
    select id from public.webhook_events_log
     where received_at < now() - make_interval(days => p_dias_para_apagar)
     order by received_at
     limit v_lote
     for update skip locked
  )
  delete from public.webhook_events_log w using alvo where w.id = alvo.id;
  get diagnostics v_apagadas = row_count;

  return jsonb_build_object('esvaziadas', v_esvaziadas, 'apagadas', v_apagadas);
end;
$$;

revoke all on function public.fn_podar_webhook_events_log(int, int, int) from public, anon, authenticated;
grant execute on function public.fn_podar_webhook_events_log(int, int, int) to service_role;

comment on function public.fn_podar_webhook_events_log(int, int, int) is
  'Retenção do arquivo de webhooks em lote, dentro do banco: esvazia corpo (raw_body, payload_parsed, headers) e apaga linhas velhas demais. Devolve {esvaziadas, apagadas}. Só service_role.';
