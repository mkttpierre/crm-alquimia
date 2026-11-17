-- 0260: a credencial do provedor `ollama` (modelo local) não tem chave e tem
-- endereço próprio.
--
-- O Ollama roda na máquina de quem opera (ou na rede dela) e não pede chave. A
-- credencial dele precisa de duas coisas que a tabela não tinha:
--
--  1. As quatro colunas do segredo (`api_key_encrypted`, `api_key_iv`,
--     `api_key_tag`, `api_key_last4`) eram NOT NULL, então não havia como gravar
--     uma credencial sem chave. Passam a aceitar NULL — mas só para o ollama:
--     um CHECK por provedor garante que TODO outro provedor continua exigindo as
--     quatro. Afrouxar a coluna sem o CHECK abriria o banco para uma credencial
--     da Anthropic sem chave, que só falharia na primeira chamada.
--  2. `base_url`: o endereço do servidor Ollama (padrão http://localhost:11434,
--     definido pela aplicação, não pelo banco). Só o ollama tem; para os outros
--     provedores o destino da chave é fixo ou vem do ponto (`ai_purpose_bindings`,
--     sob a regra de `lib/ai/provedores/endereco-proprio.ts`) e a coluna fica NULL.
--
-- Só aditiva: nenhuma coluna apagada nem renomeada. Nenhuma linha existente viola
-- os CHECKs (todas são de outros provedores, com as quatro colunas preenchidas e
-- `base_url` recém-criada, NULL) — por isso o `update.sh` de um clone antigo não
-- precisa corrigir dado antes. A política de REDE do endereço (local só para o
-- ollama e só por admin) mora na aplicação, porque depende de DNS.
--
-- O SELECT da tabela é por COLUNA desde a 0150: sem o grant abaixo, a view
-- (security_invoker) passaria a dar "permission denied" para quem não é dono. A
-- view ganha a coluna no FIM (create or replace view só aceita acrescentar).
alter table public.ai_provider_credentials alter column api_key_encrypted drop not null;
alter table public.ai_provider_credentials alter column api_key_iv drop not null;
alter table public.ai_provider_credentials alter column api_key_tag drop not null;
alter table public.ai_provider_credentials alter column api_key_last4 drop not null;

alter table public.ai_provider_credentials add column if not exists base_url text;

comment on column public.ai_provider_credentials.base_url is
  'Migration 0260: endereço do servidor do provedor LOCAL (ollama). NULL para todo outro provedor (CHECK ai_provider_credentials_endereco_so_ollama).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ai_provider_credentials_chave_por_provedor'
       and conrelid = 'public.ai_provider_credentials'::regclass
  ) then
    -- ollama: nenhuma chave, nunca. Todo o resto: as quatro colunas, sempre.
    alter table public.ai_provider_credentials
      add constraint ai_provider_credentials_chave_por_provedor check (
        (provider = 'ollama'
          and api_key_encrypted is null and api_key_iv is null
          and api_key_tag is null and api_key_last4 is null)
        or
        (provider <> 'ollama'
          and api_key_encrypted is not null and api_key_iv is not null
          and api_key_tag is not null and api_key_last4 is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'ai_provider_credentials_endereco_so_ollama'
       and conrelid = 'public.ai_provider_credentials'::regclass
  ) then
    -- O endereço é obrigatório no ollama (sem ele não há para onde ir) e
    -- proibido nos outros (um `base_url` solto numa credencial da Anthropic seria
    -- destino de chave que nenhuma tela mostra).
    alter table public.ai_provider_credentials
      add constraint ai_provider_credentials_endereco_so_ollama check (
        (provider = 'ollama' and base_url is not null and length(btrim(base_url)) > 0)
        or
        (provider <> 'ollama' and base_url is null)
      );
  end if;
end $$;

grant select (base_url) on public.ai_provider_credentials to authenticated;

create or replace view public.ai_provider_credentials_safe with (security_invoker = true) as
  select id, organization_id, provider, label, api_key_last4, validated_at,
         validation_error, models_available, is_active, created_by, created_at,
         updated_at, models_tools, base_url
    from public.ai_provider_credentials;

grant select on public.ai_provider_credentials_safe to authenticated;

notify pgrst, 'reload schema';
