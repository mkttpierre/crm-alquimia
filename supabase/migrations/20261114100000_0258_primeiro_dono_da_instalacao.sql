-- 0258: o primeiro dono de uma instalação nova vira platform admin.
--
-- Numa instalação self-host nova, quem cria a conta no onboarding é o dono do
-- servidor, mas nada criava a linha dele em `platform_admins` (só o
-- `scripts/bootstrap-owner.ts`, que o instalador não chama). Sem ela, a tela de
-- atualização dá 404 e o dono não tem onde ver se há versão nova.
--
-- A promoção só acontece quando a instalação NUNCA teve platform admin (nenhuma
-- linha, nem revogada: revogar não reabre a porta) E a única organização do banco
-- é a que este usuário acabou de receber como admin. Segundo cadastro, instalação
-- hospedada e instalação antiga que já tem organização ficam como estão.
-- A trava consultiva serializa dois primeiros cadastros simultâneos: só um vence.
-- SECURITY DEFINER, EXECUTE só para service_role (o provisionamento do signup).
create or replace function public.fn_promover_primeiro_dono_da_instalacao(p_user uuid, p_org uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('fn_promover_primeiro_dono_da_instalacao', 0));
  if exists (select 1 from public.platform_admins) then
    return false;
  end if;
  if exists (select 1 from public.organizations where id <> p_org) then
    return false;
  end if;
  if not exists (
    select 1 from public.user_organizations
     where organization_id = p_org and user_id = p_user and role = 'admin' and revoked_at is null
  ) then
    return false;
  end if;
  -- mfa_required false, como o bootstrap-owner: o default true travaria o dono
  -- numa tela de MFA logo depois do onboarding. Quem quiser liga em Segurança.
  insert into public.platform_admins(user_id, granted_by, scope, mfa_required, reason)
    values (p_user, p_user, 'full', false, 'Primeiro dono da instalação (cadastro sem platform admin)');
  return true;
end $$;
revoke all on function public.fn_promover_primeiro_dono_da_instalacao(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_promover_primeiro_dono_da_instalacao(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
