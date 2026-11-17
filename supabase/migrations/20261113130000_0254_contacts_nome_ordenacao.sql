-- 0254 — contacts.nome_ordenacao: o nome que a tela mostra, como coluna ordenável.
--
-- A tela de Leads mostra `rotuloDoContato` (nome exibido, senão nome, senão
-- telefone), mas a página do cursor ordenava só por `display_name`. Contato criado
-- à mão ou por planilha só com `name` nasce com `display_name` nulo
-- (app/api/v1/contacts/_handler.ts) e ia para o fim da lista, fora da ordem que a
-- tela sugere. O PostgREST não ordena por expressão; a saída é guardar a expressão.
--
-- Coluna GERADA (stored): ninguém escreve nela, ela acompanha toda escrita em
-- display_name/name/phone_number sem trigger. `lower` para a ordem não separar
-- "ana" de "Ana"; nunca é nula (coalesce até ''), então o keyset da página é só
-- (nome_ordenacao, id), sem região de nulos.
--
-- Índice (organization_id, nome_ordenacao, id): a página de 50 da tela de Leads é
-- um range scan nele, com a organização na frente como em toda consulta da tela.
--
-- Custo de aplicar: `add column ... generated stored` reescreve a tabela contacts
-- (trava de escrita enquanto reescreve). Aplicar fora da janela de envio.
-- Idempotente: `if not exists` nos dois.

alter table public.contacts
  add column if not exists nome_ordenacao text
  generated always as (lower(coalesce(nullif(btrim(display_name), ''), nullif(btrim(name), ''), phone_number, ''))) stored;

comment on column public.contacts.nome_ordenacao is
  'Nome que a tela mostra (nome exibido, senão nome, senão telefone), em minúsculas, para ordenar e paginar a tela de Leads (0254). Gerada; não escrever.';

create index if not exists idx_contacts_org_nome_ordenacao
  on public.contacts (organization_id, nome_ordenacao, id);

notify pgrst, 'reload schema';
