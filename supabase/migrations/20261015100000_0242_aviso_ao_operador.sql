-- 0242 — aviso ao celular do operador pelo chip da conversa (Fase 5, etapa 3: SÓ SIMULADO).
--
-- O ponto de parada do atendimento (`disparo_config.atendimento.parada`) avisa o
-- WhatsApp pessoal do operador. Até aqui o aviso só ficava na timeline do lead,
-- porque `disparo_envios` é sempre para o telefone do LEAD. Decisão do operador
-- (15/10/2026): o aviso sai pelo MESMO chip em que a lead conversa — chegou nos
-- valores no chip A, é o chip A que avisa o celular dele.
--
--   disparo_avisos_operador  a saída de avisos: org, lead, conversa e sessão de
--                            origem, chip de origem, número de destino, texto,
--                            estado (pendente|enviando|enviado|simulado|
--                            cancelado|falhou), tentativas e horários. O índice
--                            parcial impede dois avisos abertos do mesmo ponto
--                            para o mesmo lead. Quem consome é o motor
--                            (`lib/disparo/motor.ts`), pelo MESMO caminho e
--                            pelas MESMAS travas do envio real: modo real E
--                            DISPARO_REAL_LIBERADO=sim (e a allowlist, se houver).
--   disparo_envios.da_parada marca as respostas decididas junto com um ponto de
--                            parada que pausa a conversa. A pausa que o próprio
--                            ponto põe não pode derrubar o pacote que ele mesmo
--                            decidiu mandar (fechamento, links do site...).
--
-- Em simulado a linha nasce `simulado` e nada fala com canal nenhum.
--
-- RLS como as outras disparo_*: leitura para membros da organização
-- (`fn_user_org_ids()`), escrita só pelo `service_role`. Nenhuma função nova.
-- Idempotente: pode ser re-aplicada.

alter table public.disparo_envios
  add column if not exists da_parada boolean not null default false;

create table if not exists public.disparo_avisos_operador (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  -- Onde a lead conversa. Apagar a conversa não apaga o registro do aviso.
  conversation_id uuid references public.conversations(id) on delete set null,
  channel_session_id uuid,
  chip_id uuid,
  ponto text not null check (ponto ~ '^[a-z0-9_]{2,40}$'),
  destino text not null check (destino ~ '^[0-9]{10,15}$'),
  texto text not null check (length(texto) between 1 and 2000),
  estado text not null default 'pendente'
    check (estado in ('pendente', 'enviando', 'enviado', 'simulado', 'cancelado', 'falhou')),
  motivo text,
  tentativas integer not null default 0 check (tentativas >= 0),
  external_id text,
  enviar_apos timestamptz not null default now(),
  enviado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint disparo_avisos_operador_chip_da_org foreign key (organization_id, chip_id)
    references public.disparo_chips (organization_id, id) on delete set null (chip_id),
  constraint disparo_avisos_operador_sessao_da_org foreign key (organization_id, channel_session_id)
    references public.channel_sessions (organization_id, id) on delete set null (channel_session_id),
  constraint disparo_avisos_operador_saiu_tem_hora check (estado not in ('enviado', 'simulado') or enviado_em is not null)
);

create unique index if not exists disparo_avisos_operador_aberto_por_ponto
  on public.disparo_avisos_operador (organization_id, lead_id, ponto)
  where estado in ('pendente', 'enviando');
create index if not exists disparo_avisos_operador_vencidos
  on public.disparo_avisos_operador (organization_id, chip_id, enviar_apos)
  where estado = 'pendente';
create index if not exists disparo_avisos_operador_saidos_do_chip
  on public.disparo_avisos_operador (organization_id, chip_id, enviado_em desc)
  where estado in ('enviado', 'simulado');
create index if not exists disparo_avisos_operador_do_lead
  on public.disparo_avisos_operador (organization_id, lead_id, created_at desc);

drop trigger if exists trg_disparo_avisos_operador_updated_at on public.disparo_avisos_operador;
create trigger trg_disparo_avisos_operador_updated_at before update on public.disparo_avisos_operador
  for each row execute function public.fn_set_updated_at();

alter table public.disparo_avisos_operador enable row level security;

revoke all on public.disparo_avisos_operador from anon, authenticated;
grant select on public.disparo_avisos_operador to authenticated;
grant all on public.disparo_avisos_operador to service_role;

drop policy if exists tenant_isolation_disparo_avisos_operador_all on public.disparo_avisos_operador;
create policy tenant_isolation_disparo_avisos_operador_all on public.disparo_avisos_operador for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

comment on table public.disparo_avisos_operador is
  'Saída de avisos ao celular do operador, pelo chip em que a lead conversa. Envio real atrás da trava dupla (lib/disparo/trava.ts).';
comment on column public.disparo_envios.da_parada is
  'Resposta decidida junto com um ponto de parada que pausa a conversa: a pausa do próprio ponto não a cancela.';

notify pgrst, 'reload schema';
