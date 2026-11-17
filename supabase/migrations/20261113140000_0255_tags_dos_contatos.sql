-- 0255 — fn_tags_dos_contatos: as tags distintas dos contatos de uma organização.
--
-- A tela de Leads pagina de 50 em 50 e o campo de tag sugeria só as tags dos 50
-- contatos da página (e, com um filtro ativo, só a tag filtrada). As sugestões
-- precisam ser o vocabulário da organização inteira. O PostgREST não faz
-- `distinct unnest(tags)`, e ler a coluna `tags` de toda a base de volta é a
-- leitura sem limite que saiu da tela.
--
-- SECURITY INVOKER: roda com a RLS de quem chama (`tenant_isolation_contacts_all`),
-- então uma organização alheia em `p_org` devolve vazio. Teto de 500 tags no
-- corpo, ordem alfabética. Ignora a lápide de fusão (`is_merged_into`) e tag vazia.
--
-- Função nova em `public` nasce exposta: revogada de `public` e `anon`, aberta só a
-- `authenticated` (a tela) e `service_role`.

create or replace function public.fn_tags_dos_contatos(p_org uuid)
returns text[]
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(array_agg(t order by t), '{}'::text[])
    from (
      select distinct btrim(tag) as t
        from public.contacts c, unnest(c.tags) as tag
       where c.organization_id = p_org
         and c.is_merged_into is null
         and btrim(tag) <> ''
       order by 1
       limit 500
    ) s;
$$;

revoke execute on function public.fn_tags_dos_contatos(uuid) from public, anon;
grant execute on function public.fn_tags_dos_contatos(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
