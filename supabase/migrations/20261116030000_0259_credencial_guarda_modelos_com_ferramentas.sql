-- 0259: a credencial de IA guarda QUAIS modelos o provedor diz que sabem usar
-- ferramentas.
--
-- A tela de Provedores passa a listar os modelos da CHAVE do operador
-- (`models_available`, gravada pelo validador) em vez do catálogo global. Para
-- o ponto que exige ferramentas (o agente que cria o lead e move o funil), a
-- lista precisa dizer quem sabe usá-las. A OpenRouter informa isso em
-- `supported_parameters` na própria listagem de modelos; os outros provedores
-- não informam, e aí a coluna fica NULL e quem decide é `ai_models`, como antes.
--
-- Só aditiva: coluna nova, anulável, sem default. A view segura ganha a coluna
-- no FIM (create or replace view só aceita acrescentar no fim). O SELECT da
-- tabela é por COLUNA desde a 0150 — sem o grant abaixo, a view
-- (security_invoker) passaria a dar "permission denied" para quem não é dono.
alter table public.ai_provider_credentials add column if not exists models_tools text[];

comment on column public.ai_provider_credentials.models_tools is
  'Migration 0259: ids que o provedor declarou suportar ferramentas (OpenRouter: supported_parameters contém "tools"). NULL = o provedor não informa; a capacidade vem de ai_models.';

grant select (models_tools) on public.ai_provider_credentials to authenticated;

create or replace view public.ai_provider_credentials_safe with (security_invoker = true) as
  select id, organization_id, provider, label, api_key_last4, validated_at,
         validation_error, models_available, is_active, created_by, created_at,
         updated_at, models_tools
    from public.ai_provider_credentials;

grant select on public.ai_provider_credentials_safe to authenticated;

notify pgrst, 'reload schema';
