-- 0240 — biblioteca de mídia por organização + anexo em resposta rápida.
--
-- Até aqui `message_templates` só guardava TEXTO, e o único lugar onde um
-- arquivo existia era a mensagem já enviada (`messages.media_storage_path`, no
-- bucket privado `whatsapp-media`, sob `<org>/<conversa>/`). Um áudio ou uma
-- tabela de preços que a empresa reenvia toda semana não tinha casa: cada envio
-- exigia subir o arquivo de novo.
--
--   media_library            o arquivo da casa: tipo, nome legível, caminho no
--                            Storage, mime, tamanho e sha256. Uma linha por
--                            conteúdo distinto da organização — `unique
--                            (organization_id, sha256)` é o que faz a mesma
--                            importação rodada duas vezes não duplicar nada, e
--                            `legacy_names` guarda os nomes antigos do mesmo
--                            arquivo (enc-014 = obj-golpe nos CRMs de origem).
--   message_templates.media_id  o anexo da resposta rápida (0 ou 1 arquivo).
--
-- Bucket: REUSA `whatsapp-media` (privado, 50 MB), sob `<org>/biblioteca/`.
-- Nenhum bucket novo e nenhuma policy em `storage.objects`: como o resto do
-- `whatsapp-media`, o objeto só é alcançado pelo `service_role`, por rota
-- que antes passou pela RLS desta tabela (URL assinada). O isolamento é o
-- prefixo do caminho + a RLS abaixo + a FK composta.
--
-- Isolamento: `message_templates (media_id, organization_id)` aponta para
-- `media_library (id, organization_id)`. Um template NÃO consegue anexar o
-- arquivo de outra organização nem com a service key. `on delete set null
-- (media_id)` (Postgres 15+, o piso do projeto) solta o anexo sem anular a
-- organização.
--
-- RLS: leitura para membros (`fn_user_org_ids()`); escrita só pelo
-- `service_role` (o importador e as rotas, que filtram a organização). Nenhuma
-- função nova: nada a revogar de anon/PUBLIC.
--
-- `kind` é text + CHECK (tabela nova: não há linha legada para quebrar o
-- `update.sh` de um clone). Idempotente: pode ser re-aplicada.

create table if not exists public.media_library (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('audio', 'image', 'video', 'document')),
  name text not null check (length(btrim(name)) > 0),
  description text,
  storage_path text not null check (length(storage_path) > 0),
  mime text not null check (length(mime) > 0),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  legacy_names text[] not null default '{}',
  tags text[] not null default '{}',
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, sha256),
  unique (organization_id, storage_path)
);

create index if not exists media_library_da_org on public.media_library (organization_id, kind, name);

drop trigger if exists trg_media_library_updated_at on public.media_library;
create trigger trg_media_library_updated_at before update on public.media_library
  for each row execute function public.fn_set_updated_at();

alter table public.message_templates
  add column if not exists media_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'message_templates_media_da_org'
      and conrelid = 'public.message_templates'::regclass
  ) then
    alter table public.message_templates
      add constraint message_templates_media_da_org
      foreign key (media_id, organization_id)
      references public.media_library (id, organization_id)
      on delete set null (media_id);
  end if;
end $$;

create index if not exists idx_message_templates_media
  on public.message_templates (media_id) where media_id is not null;

alter table public.media_library enable row level security;

revoke all on public.media_library from anon, authenticated;
grant select on public.media_library to authenticated;
grant all on public.media_library to service_role;

drop policy if exists tenant_isolation_media_library_all on public.media_library;
create policy tenant_isolation_media_library_all on public.media_library for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

comment on table public.media_library is
  'Biblioteca de mídia da organização (áudios, imagens, documentos). Arquivo em whatsapp-media sob <org>/biblioteca/; uma linha por sha256.';
comment on column public.message_templates.media_id is
  'Anexo da resposta rápida (media_library da MESMA organização). Null = só texto.';
