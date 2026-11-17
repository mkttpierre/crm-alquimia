-- 0233 — quarto canal: Evolution API (WhatsApp não oficial, v2) em channel_sessions.
--
-- Vocabulário antes do transporte, como na 0131: o tipo TypeScript
-- (`ChannelProvider`), a matriz de capabilities e as colunas de ref nascem
-- juntos. O adapter e a rota de webhook chegam encontrando o schema pronto.
--
-- Três colunas novas, todas NULLABLE (nenhuma linha existente as viola):
--
--   evolution_instance_name  o nome da instância NO servidor Evolution. É o
--                            `sessionRef` deste canal — endereça envio e estado.
--   evolution_base_url       a URL do servidor Evolution desta sessão. Existe
--                            porque duas organizações podem apontar para
--                            servidores diferentes (um container por negócio);
--                            NULL cai no env `EVOLUTION_API_BASE_URL`.
--   evolution_token_encrypted a apikey da instância, cifrada por
--                            `fn_encrypt_oauth` (mesmo caminho de cifra das
--                            demais credenciais). NULL cai no env
--                            `EVOLUTION_API_KEY`.
--
-- Os dois CHECKs são RECRIADOS (drop + add), não criados com
-- `exception when duplicate_object`: aqui eles precisam MUDAR, e um clone que já
-- tem a versão de três providers ficaria com a constraint antiga recusando a
-- sessão nova com o `update.sh` verde.
--
-- O CHECK de `webhook_events_log.provider` também se alarga: a rota de entrada
-- arquiva o corpo cru ANTES de processar, e sem o novo valor o INSERT do arquivo
-- violaria a constraint. Alargamento puro — linha que passava continua passando.
--
-- Índice único parcial no mesmo recorte da 0165 (`archived_at is null`): a
-- instância é única POR SERVIDOR, então a chave é (servidor, instância). Dois
-- servidores podem ter uma instância com o mesmo nome; o mesmo servidor, não.

alter table public.channel_sessions
  add column if not exists evolution_instance_name text,
  add column if not exists evolution_base_url text,
  add column if not exists evolution_token_encrypted bytea;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'evolution'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name       is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id    is not null) or
    (provider = 'zernio'     and zernio_account_id       is not null) or
    (provider = 'evolution'  and evolution_instance_name is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'evolution'
  ));

create unique index if not exists channel_sessions_evolution_instancia_ativo_unique
  on public.channel_sessions (coalesce(evolution_base_url, ''), evolution_instance_name)
  where archived_at is null and evolution_instance_name is not null;

comment on column public.channel_sessions.evolution_instance_name is
  'Nome da instância NO servidor Evolution. É o sessionRef do canal. Espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.evolution_base_url is
  'URL do servidor Evolution desta sessão. NULL = env EVOLUTION_API_BASE_URL.';
comment on column public.channel_sessions.evolution_token_encrypted is
  'apikey da instância Evolution, cifrada por fn_encrypt_oauth. NULL = env EVOLUTION_API_KEY.';
