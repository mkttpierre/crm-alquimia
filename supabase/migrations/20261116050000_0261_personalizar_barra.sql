-- ============================================================================
-- 0261 — PERSONALIZAR A BARRA LATERAL (Configurações → Personalizar).
--
-- Duas camadas, com donos diferentes:
--
--   * `user_organizations.preferencias_da_barra` — da PESSOA, naquela organização:
--     quais tópicos da barra ela oculta e em que ordem os vê. Formato
--     `{ "ocultos": string[], "ordem": string[] }`. Quem grava é a própria pessoa
--     (qualquer papel) e só a linha dela.
--   * `organizations.nomes_da_barra` — da ORGANIZAÇÃO: o nome que o admin dá a cada
--     linha de topo da barra. Mapa `chave -> nome`, até 40 caracteres. Só admin grava.
--
-- A chave estável de uma linha é o `href` (linha de destino) ou `grupo:<id>`
-- (linha que abre um grupo). Chave que saiu do catálogo é ignorada na leitura,
-- então NENHUM CHECK confere a chave contra o catálogo (que evolui no TypeScript):
-- o banco confere só a FORMA e o tamanho.
--
-- ─── Ocultar NÃO é permissão ────────────────────────────────────────────────
-- Estas colunas são só apresentação. A tela ocultada continua abrindo pelo link
-- e pelo ⌘K, e a restrição do admin (`interface_settings`, 0221) vem primeiro.
--
-- ─── Por que as funções são `service_role` e recebem `p_actor` ──────────────
-- Mesmo desenho de `fn_definir_marca_da_organizacao` (0157): a escrita chega pelo
-- admin client, que não tem `auth.uid()`, então o ator vem por argumento (do
-- `loadAuthUser()` do servidor). Definer VOLÁTIL alcançável por `authenticated`
-- é escrita cross-tenant e é a segunda regra de
-- `tests/invariants/hardening-definer-varredura.test.ts`; o único chamador é o
-- admin client, e o ator é conferido DENTRO da função.
--
-- Só aditiva: duas colunas com default `'{}'` e `not null`, dois CHECKs que as
-- linhas existentes já satisfazem (o default), duas funções. Nada é apagado nem
-- renomeado. Idempotente.
-- ============================================================================

alter table public.user_organizations
  add column if not exists preferencias_da_barra jsonb not null default '{}'::jsonb;

alter table public.organizations
  add column if not exists nomes_da_barra jsonb not null default '{}'::jsonb;

comment on column public.user_organizations.preferencias_da_barra is
  'Migration 0261: preferência PESSOAL da barra lateral — {"ocultos": [chave], "ordem": [chave]}. Chave = href da linha ou grupo:<id>. Só apresentação, nunca permissão.';
comment on column public.organizations.nomes_da_barra is
  'Migration 0261: nomes que o admin deu às linhas de topo da barra lateral — {chave: nome}, até 40 caracteres. Vazio = nome padrão.';

-- Os CHECKs de tipo usam jsonpath em modo `strict` e com `silent = true`. No modo
-- padrão (`lax`) o filtro `?` DESEMBRULHA arrays: `{"ocultos":[["x"]]}` e
-- `{"k":["a"]}` passariam por "só texto". Em `strict` o array aninhado aparece como
-- array e é recusado. `silent` é o que mantém a linha válida quando a chave não
-- existe (`{}`): o erro estrutural do `strict` vira NULL, e NULL num CHECK passa; o
-- que não é lista ou texto já é barrado pelas cláusulas `jsonb_typeof` ao lado.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'user_organizations_preferencias_da_barra_forma'
       and conrelid = 'public.user_organizations'::regclass
  ) then
    alter table public.user_organizations
      add constraint user_organizations_preferencias_da_barra_forma check (
        jsonb_typeof(preferencias_da_barra) = 'object'
        and (preferencias_da_barra - 'ocultos' - 'ordem') = '{}'::jsonb
        and (not preferencias_da_barra ? 'ocultos'
             or (jsonb_typeof(preferencias_da_barra -> 'ocultos') = 'array'
                 and jsonb_array_length(preferencias_da_barra -> 'ocultos') <= 200))
        and (not preferencias_da_barra ? 'ordem'
             or (jsonb_typeof(preferencias_da_barra -> 'ordem') = 'array'
                 and jsonb_array_length(preferencias_da_barra -> 'ordem') <= 200))
        and not jsonb_path_exists(preferencias_da_barra, 'strict $.ocultos[*] ? (@.type() != "string")', '{}', true)
        and not jsonb_path_exists(preferencias_da_barra, 'strict $.ordem[*] ? (@.type() != "string")', '{}', true)
        and length(preferencias_da_barra::text) <= 16384
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'organizations_nomes_da_barra_forma'
       and conrelid = 'public.organizations'::regclass
  ) then
    alter table public.organizations
      add constraint organizations_nomes_da_barra_forma check (
        jsonb_typeof(nomes_da_barra) = 'object'
        and not jsonb_path_exists(nomes_da_barra, 'strict $.* ? (@.type() != "string")', '{}', true)
        and not jsonb_path_exists(nomes_da_barra, 'strict $.* ? (@ like_regex "^.{41,}$")', '{}', true)
        and not jsonb_path_exists(nomes_da_barra, 'strict $.* ? (@ like_regex "^[[:space:]]*$")', '{}', true)
        and length(nomes_da_barra::text) <= 8192
      );
  end if;
end $$;

-- ── A preferência pessoal: só a linha do PRÓPRIO ator ──────────────────────
create or replace function public.fn_definir_minha_barra(
  p_organization_id uuid,
  p_actor           uuid,
  p_preferencias    jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_prefs  jsonb;
begin
  if p_organization_id is null or p_actor is null then
    raise exception 'minha_barra_argumento_nulo' using errcode = '22023';
  end if;

  -- "Restaurar padrão" chega como SQL NULL ou como o jsonb 'null' (o transporte
  -- decide qual), e as duas formas significam a mesma coisa: preferência vazia.
  if p_preferencias is null or jsonb_typeof(p_preferencias) = 'null' then
    v_prefs := '{}'::jsonb;
  elsif jsonb_typeof(p_preferencias) <> 'object' then
    raise exception 'minha_barra_forma_invalida: %', jsonb_typeof(p_preferencias)
      using errcode = '22023';
  else
    v_prefs := p_preferencias;
  end if;

  -- Sem papel mínimo: qualquer membro ativo personaliza a PRÓPRIA barra. O que
  -- protege os outros é o filtro abaixo — `user_id = p_actor` — e não um papel.
  update public.user_organizations uo
     set preferencias_da_barra = v_prefs,
         updated_at = now()
   where uo.user_id = p_actor
     and uo.organization_id = p_organization_id
     and uo.revoked_at is null;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_minha_barra(uuid, uuid, jsonb) is
  'Grava user_organizations.preferencias_da_barra SÓ da linha do próprio ator naquela organização (qualquer papel). NULL ou jsonb null limpa. Devolve linhas afetadas: 0 = o ator não é membro ativo. Forma inválida levanta 22023 (e o CHECK da coluna levanta 23514 em conteúdo fora do contrato). Chamador: app/actions/settings/updateMinhaBarra.ts.';

revoke execute on function public.fn_definir_minha_barra(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_minha_barra(uuid, uuid, jsonb)
  to service_role;

-- ── Os nomes da organização: só admin ──────────────────────────────────────
create or replace function public.fn_definir_nomes_da_barra(
  p_organization_id uuid,
  p_actor           uuid,
  p_nomes           jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_limpo  jsonb := '{}'::jsonb;
  r        record;
  v_nome   text;
begin
  if p_organization_id is null or p_actor is null then
    raise exception 'nomes_da_barra_argumento_nulo' using errcode = '22023';
  end if;

  -- Autorização ANTES de olhar o conteúdo: quem não pode gravar recebe 42501,
  -- que é a verdade sobre ele, e não um 22023 sobre o texto que mandou.
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
    raise exception 'nomes_da_barra_sem_permissao' using errcode = '42501';
  end if;

  if p_nomes is not null and jsonb_typeof(p_nomes) <> 'null' then
    if jsonb_typeof(p_nomes) <> 'object' then
      raise exception 'nomes_da_barra_forma_invalida: %', jsonb_typeof(p_nomes)
        using errcode = '22023';
    end if;

    for r in select e.key as chave, e.value as valor from jsonb_each(p_nomes) as e loop
      if r.chave !~ '^(/app/[a-z0-9/_-]+|grupo:[a-z0-9_-]+)$' then
        raise exception 'nomes_da_barra_chave_invalida'
          using errcode = '22023';
      end if;
      if jsonb_typeof(r.valor) <> 'string' then
        raise exception 'nomes_da_barra_valor_nao_e_texto'
          using errcode = '22023';
      end if;
      v_nome := regexp_replace(r.valor #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g');
      if char_length(v_nome) > 40 then
        raise exception 'nomes_da_barra_nome_longo'
          using errcode = '22023';
      end if;
      -- Vazio volta ao padrão: a chave simplesmente não é gravada.
      if v_nome <> '' then
        v_limpo := v_limpo || jsonb_build_object(r.chave, v_nome);
      end if;
    end loop;
  end if;

  update public.organizations o
     set nomes_da_barra = v_limpo,
         updated_at = now()
   where o.id = p_organization_id;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_nomes_da_barra(uuid, uuid, jsonb) is
  'Grava organizations.nomes_da_barra (mapa chave -> nome, até 40 caracteres, aparado; vazio some). Só admin da organização ou platform admin (42501). NULL ou jsonb null limpa tudo. Devolve linhas afetadas: 0 = a organização não existe. Chamador: app/actions/settings/updateNomesDaBarra.ts.';

revoke execute on function public.fn_definir_nomes_da_barra(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_nomes_da_barra(uuid, uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';
