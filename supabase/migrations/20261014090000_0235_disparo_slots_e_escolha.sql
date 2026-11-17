-- 0235 — motor de disparo: slots fixos e escolha de modelo por organização.
--
-- A 0234 guardou os textos (`modelos`) mas não tinha onde guardar DUAS coisas
-- que os textos completos dos CRMs portados exigem:
--
--   slots    valores iguais para todo lead da organização (ex.: `{operador}`,
--            o nome de quem assina numa organização) e quando o nome do lead NÃO vai
--            no texto (`semNomeQuando`: número da recepção). Objeto.
--   escolha  regras EM ORDEM que apontam qual lista de `modelos` cada lead
--            recebe em cada passo, pelas condições sobre `custom_fields`
--            (trilha/classe numa organização; porta/segmento em outra). Array — a ordem
--            importa, e jsonb não guarda ordem de chave de objeto.
--
-- Os dois são lidos SÓ por `lib/disparo/config.ts` (Zod), como o `ritmo`
-- (anti-pattern nº 6). Default vazio = comportamento da 0234 (lista `tipo` e
-- `tipo:grupo`, slots só os do lead). Nenhuma linha muda de comportamento.

alter table public.disparo_config
  add column if not exists slots jsonb not null default '{}'::jsonb,
  add column if not exists escolha jsonb not null default '[]'::jsonb;

alter table public.disparo_config drop constraint if exists disparo_config_slots_objeto;
alter table public.disparo_config add constraint disparo_config_slots_objeto check (jsonb_typeof(slots) = 'object');
alter table public.disparo_config drop constraint if exists disparo_config_escolha_lista;
alter table public.disparo_config add constraint disparo_config_escolha_lista check (jsonb_typeof(escolha) = 'array');

comment on column public.disparo_config.slots is
  'Slots fixos da organização ({operador}) e semNomeQuando. Lido só por lib/disparo/config.ts.';
comment on column public.disparo_config.escolha is
  'Regras em ordem: tipo + condições sobre custom_fields -> lista de modelos. Lido só por lib/disparo/config.ts.';

notify pgrst, 'reload schema';
