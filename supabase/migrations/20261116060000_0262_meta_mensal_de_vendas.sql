-- ============================================================================
-- 0262 — META MENSAL DE VENDAS (Início → painel "Vendas e faturamento").
--
-- O admin da organização define UMA meta de faturamento por mês, em centavos, na
-- moeda da organização. O painel compara com o que entrou no mês corrente
-- (progresso, quanto falta e ritmo por dia). Sem meta, o painel só convida o admin
-- a definir; nunca inventa um valor.
--
--   * `organizations.meta_mensal_cents` — `bigint`, NULL = sem meta. Faixa
--     `1 .. 10^14` (CHECK): zero ou negativo não é meta, e o teto só impede
--     estouro de formatação. A moeda NÃO mora aqui: é `organizations.currency`.
--
-- ─── Por que a função é `service_role` e recebe `p_actor` ───────────────────
-- Mesmo desenho de `fn_definir_nomes_da_barra` (0261) e `fn_definir_marca_da_organizacao`
-- (0157): a escrita chega pelo admin client, que não tem `auth.uid()`, então o ator
-- vem por argumento (do `loadAuthUser()` do servidor) e o papel é conferido DENTRO
-- da função, de novo. Definer VOLÁTIL alcançável por `authenticated` é escrita
-- cross-tenant (segunda regra de `tests/invariants/hardening-definer-varredura.test.ts`).
--
-- ─── Quem LÊ a meta (decisão aceita, registrada aqui) ───────────────────────
-- A coluna mora em `organizations`, cuja política de leitura (`orgs_select`, mais o GRANT de tabela
-- para `authenticated`) deixa QUALQUER membro da organização ler a linha pela REST — viewer e agent
-- incluídos: `organizations?select=meta_mensal_cents` devolve a meta. O painel só a mostra a manager+
-- (e só o admin a define), mas o caminho existe. É decisão aceita: a meta é um número-alvo da empresa,
-- não um dado de cliente nem de comissão. Quem precisar escondê-la de membros comuns move a coluna para
-- uma tabela própria com RLS `manager`+ numa migration nova (esta não é editada depois de aplicada).
--
-- Só aditiva: uma coluna nullable, um CHECK que as linhas existentes (todas NULL)
-- já satisfazem, uma função. Nada é apagado nem renomeado. Idempotente.
-- ============================================================================

alter table public.organizations
  add column if not exists meta_mensal_cents bigint;

comment on column public.organizations.meta_mensal_cents is
  'Migration 0262: meta mensal de faturamento do painel de vendas, em centavos, na moeda da organização (organizations.currency). NULL = sem meta.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'organizations_meta_mensal_cents_faixa'
       and conrelid = 'public.organizations'::regclass
  ) then
    alter table public.organizations
      add constraint organizations_meta_mensal_cents_faixa check (
        meta_mensal_cents is null
        or (meta_mensal_cents > 0 and meta_mensal_cents <= 100000000000000)
      );
  end if;
end $$;

create or replace function public.fn_definir_meta_mensal(
  p_organization_id uuid,
  p_actor           uuid,
  p_meta_cents      bigint
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
begin
  if p_organization_id is null or p_actor is null then
    raise exception 'meta_mensal_argumento_nulo' using errcode = '22023';
  end if;

  -- Autorização ANTES de olhar o valor: quem não pode gravar recebe 42501, que é a
  -- verdade sobre ele, e não um 22023 sobre o número que mandou.
  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_organization_id
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'meta_mensal_sem_permissao' using errcode = '42501';
  end if;

  -- NULL limpa a meta. Zero, negativo ou acima do teto não é meta.
  if p_meta_cents is not null and (p_meta_cents <= 0 or p_meta_cents > 100000000000000) then
    raise exception 'meta_mensal_fora_da_faixa' using errcode = '22023';
  end if;

  update public.organizations o
     set meta_mensal_cents = p_meta_cents,
         updated_at = now()
   where o.id = p_organization_id;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_meta_mensal(uuid, uuid, bigint) is
  'Grava organizations.meta_mensal_cents. Só admin da organização ou platform admin (42501). NULL limpa a meta; zero, negativo ou acima de 10^14 levanta 22023. Devolve linhas afetadas: 0 = a organização não existe. Chamador: app/actions/inicio/definirMetaMensal.ts.';

revoke execute on function public.fn_definir_meta_mensal(uuid, uuid, bigint)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_meta_mensal(uuid, uuid, bigint)
  to service_role;

notify pgrst, 'reload schema';
