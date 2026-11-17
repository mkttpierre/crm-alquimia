/**
 * Os números da tela Início (`/app/inicio`) — as consultas num lugar só.
 *
 * Cada número responde uma pergunta que o dono abre o CRM para fazer, e todos
 * saem do banco da organização: nenhum é estimado, nenhum é inventado. Onde não
 * há dado, o número é 0 (ou `null`, quando 0 mentiria — a taxa de resposta de
 * um motor que nunca abriu conversa não é 0%, é "ainda não existe").
 *
 * Toda consulta filtra `organization_id` explicitamente, mesmo rodando com o
 * client do usuário (RLS): a doutrina manda, e o teste de isolamento deste
 * arquivo prova que dado de outra organização não entra em número nenhum.
 *
 * O "hoje" é o dia LOCAL da organização. O fuso vem do ritmo do motor
 * (`disparo_config.ritmo.fusoMinutos`, lido só por `lerRitmo`) — o mesmo
 * relógio com que a tela do motor conta "enviados hoje"; sem motor, vale o
 * padrão do produto (UTC-3).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerRitmo } from "@/lib/disparo/config";
import { inicioDoDia } from "@/lib/disparo/ritmo";
import { activityLabel, actorName } from "@/lib/leads/activity-vocabulary";
import { OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";
import { buscarEmLotes, buscarTodasAsPaginas } from "@/lib/supabase/em-lotes";

const MIN = 60_000;
const DIA = 24 * 60 * MIN;
const SEMANAS = 8;
/** Janela da taxa de resposta — a mesma janela longa padrão da saúde do chip. */
const JANELA_DA_TAXA_DIAS = 7;
const ATIVIDADES = 6;

/*
 * ⚠️ O `max_rows` do PostgREST (supabase/config.toml: 1000) CORTA toda resposta
 * em 1.000 linhas, calado — um `.limit(10000)` não passa disso. Por isso aqui:
 * o que é contagem vai por `count` (head, sem linha nenhuma), e o que precisa
 * olhar linha a linha (comparar duas colunas, juntar abertura com resposta)
 * pagina com `.range()` por `buscarTodasAsPaginas`/`buscarEmLotes`
 * (lib/supabase/em-lotes.ts), sempre com ordem total (por `id`).
 */

export interface SemanaDoGrafico {
  /** Início da semana (instante UTC da meia-noite local). */
  inicio: string;
  /** Conversas que nasceram na semana. */
  iniciadas: number;
  /** Das que nasceram na semana, as que tiveram mensagem dos dois lados. */
  respondidas: number;
}

export interface FunilDoInicio {
  id: string;
  nome: string;
  leads: number;
  etapas: number;
  /** O motor está ligado e puxa leads de uma etapa deste funil (sempre `false` sem `incluirMotor`). */
  motorLigado: boolean;
  /** Fração (0–1) dos leads do funil que já saíram da primeira etapa. */
  alemDaPrimeira: number;
}

export interface AtividadeDoInicio {
  id: string;
  tipo: string;
  rotulo: string;
  autor: string;
  especie: string | null;
  lead: string | null;
  em: string;
}

export interface MotorDoInicio {
  enviadosHoje: number;
  chipsHoje: number;
  aberturas7d: number;
  respondidas7d: number;
  /** `null` = o motor não abriu conversa na janela; a tela mostra "—". */
  taxaDeResposta: number | null;
}

export interface ResumoDoInicio {
  conversas: { abertas: number; esperandoResposta: number };
  leads: { hoje: number; ontem: number };
  /** `null` = quem olha não é gestor (a tela do motor é `manager+`): os números do motor não são lidos. */
  motor: MotorDoInicio | null;
  semanas: SemanaDoGrafico[];
  funis: FunilDoInicio[];
  atividades: AtividadeDoInicio[];
}

export interface OpcoesDoResumo {
  agora: Date;
  /**
   * Ler os números do motor de disparo. A página passa `true` só para
   * `manager+` — a mesma régua do destino `/app/disparo` no catálogo.
   * Padrão `true`.
   */
  incluirMotor?: boolean;
  /** Nome de quem fez cada atividade (só `full_name`; ver `lib/users/nome-do-atendente`). */
  nomesDeUsuarios?: (ids: string[]) => Promise<Map<string, string | null>>;
}

type Linha = Record<string, unknown>;

function lancar(onde: string, error: { message: string } | string | null | undefined): void {
  if (error) {
    throw new Error(`[inicio] ${onde}: ${typeof error === "string" ? error : error.message}`);
  }
}

export async function carregarResumoDoInicio(
  db: SupabaseClient,
  orgId: string,
  opcoes: OpcoesDoResumo,
): Promise<ResumoDoInicio> {
  const { agora } = opcoes;
  const incluirMotor = opcoes.incluirMotor ?? true;

  const { data: config, error: eConfig } = await db
    .from("disparo_config")
    .select("ligado, fonte_stage_id, ritmo")
    .eq("organization_id", orgId)
    .maybeSingle();
  lancar("disparo_config", eConfig);
  const fuso = lerRitmo((config as Linha | null)?.ritmo ?? null).fusoMinutos;
  const hoje = inicioDoDia(agora, fuso);

  const [conversas, leads, motor, semanas, funis, atividades] = await Promise.all([
    contarConversas(db, orgId),
    contarLeads(db, orgId, hoje),
    incluirMotor ? medirMotor(db, orgId, agora, hoje) : Promise.resolve(null),
    semanasDoGrafico(db, orgId, hoje),
    listarFunis(db, orgId, incluirMotor ? ((config as Linha | null) ?? null) : null),
    ultimasAtividades(db, orgId, opcoes.nomesDeUsuarios),
  ]);
  return { conversas, leads, motor, semanas, funis, atividades };
}

/**
 * "Esperando resposta" = a última mensagem do cliente é mais nova que a nossa.
 * O total vem do `count`; a comparação entre as duas colunas é feita aqui,
 * porque o PostgREST não compara coluna com coluna — lendo TODAS as abertas,
 * em páginas.
 */
async function contarConversas(
  db: SupabaseClient,
  org: string,
): Promise<ResumoDoInicio["conversas"]> {
  const { count, error: eTotal } = await db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org)
    .eq("is_group", false)
    .in("status", [...OPEN_LOAD_STATUSES]);
  lancar("conversas_total", eTotal);
  const { data, error } = await buscarTodasAsPaginas<{
    last_inbound_at: string | null;
    last_outbound_at: string | null;
  }>((de, ate) =>
    db
      .from("conversations")
      .select("id, last_inbound_at, last_outbound_at")
      .eq("organization_id", org)
      .eq("is_group", false)
      .in("status", [...OPEN_LOAD_STATUSES])
      .order("id", { ascending: true })
      .range(de, ate),
  );
  lancar("conversas", error);
  const esperando = data.filter(
    (c) => c.last_inbound_at && (!c.last_outbound_at || c.last_inbound_at > c.last_outbound_at),
  ).length;
  return { abertas: count ?? data.length, esperandoResposta: esperando };
}

async function contarLeads(
  db: SupabaseClient,
  org: string,
  hoje: Date,
): Promise<ResumoDoInicio["leads"]> {
  const ontem = new Date(hoje.getTime() - DIA);
  const [h, o] = await Promise.all([
    db
      .from("crm_leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .gte("created_at", hoje.toISOString()),
    db
      .from("crm_leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .gte("created_at", ontem.toISOString())
      .lt("created_at", hoje.toISOString()),
  ]);
  lancar("leads_hoje", h.error);
  lancar("leads_ontem", o.error);
  return { hoje: h.count ?? 0, ontem: o.count ?? 0 };
}

/**
 * Enviados hoje: só o que SAIU de verdade (`estado = 'enviado'`). O simulado
 * conta para o ritmo do motor, mas não chegou a ninguém — numa tela de
 * resultado ele seria número inventado.
 *
 * Taxa de resposta: a régua da saúde do chip (`lib/disparo/saude.ts`), na
 * organização inteira — leads abertos pelo motor na janela que mandaram
 * mensagem de gente DEPOIS da abertura. Resposta automática de empresa
 * (`metadata.automatica`) não é resposta.
 */
async function medirMotor(
  db: SupabaseClient,
  org: string,
  agora: Date,
  hoje: Date,
): Promise<MotorDoInicio> {
  const desde = new Date(agora.getTime() - JANELA_DA_TAXA_DIAS * DIA);
  const [total, deHoje, aberturas] = await Promise.all([
    db
      .from("disparo_envios")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("estado", "enviado")
      .gte("enviado_em", hoje.toISOString()),
    buscarTodasAsPaginas<{ chip_id: string | null }>((de, ate) =>
      db
        .from("disparo_envios")
        .select("id, chip_id")
        .eq("organization_id", org)
        .eq("estado", "enviado")
        .gte("enviado_em", hoje.toISOString())
        .order("id", { ascending: true })
        .range(de, ate),
    ),
    buscarTodasAsPaginas<{ lead_id: string; enviado_em: string }>((de, ate) =>
      db
        .from("disparo_envios")
        .select("id, lead_id, enviado_em")
        .eq("organization_id", org)
        .eq("tipo", "abertura")
        .eq("estado", "enviado")
        .gte("enviado_em", desde.toISOString())
        .order("id", { ascending: true })
        .range(de, ate),
    ),
  ]);
  lancar("envios_hoje", total.error);
  lancar("chips_hoje", deHoje.error);
  lancar("aberturas", aberturas.error);

  const chips = new Set(deHoje.data.map((e) => e.chip_id).filter(Boolean));

  const abertaEm = new Map<string, string>();
  for (const a of aberturas.data) {
    const antes = abertaEm.get(a.lead_id);
    if (!antes || a.enviado_em < antes) abertaEm.set(a.lead_id, a.enviado_em);
  }

  const leads = await buscarEmLotes<{ id: string; contact_id: string | null }>(
    [...abertaEm.keys()],
    (lote, de, ate) =>
      db
        .from("crm_leads")
        .select("id, contact_id")
        .eq("organization_id", org)
        .in("id", lote)
        .order("id", { ascending: true })
        .range(de, ate),
  );
  lancar("leads_abertos", leads.error);
  const leadDoContato = new Map<string, string>();
  for (const l of leads.data) if (l.contact_id) leadDoContato.set(l.contact_id, l.id);

  const msgs = await buscarEmLotes<{
    contact_id: string;
    created_at: string;
    metadata: Record<string, unknown> | null;
    type: string;
  }>([...leadDoContato.keys()], (lote, de, ate) =>
    db
      .from("messages")
      .select("id, contact_id, created_at, metadata, type")
      .eq("organization_id", org)
      .eq("direction", "inbound")
      .in("contact_id", lote)
      .gte("created_at", desde.toISOString())
      .order("id", { ascending: true })
      .range(de, ate),
  );
  lancar("respostas", msgs.error);

  const responderam = new Set<string>();
  for (const m of msgs.data) {
    if (m.type === "system" || m.metadata?.["automatica"] === true) continue;
    const lead = leadDoContato.get(m.contact_id);
    const quando = lead ? abertaEm.get(lead) : undefined;
    if (lead && quando && m.created_at >= quando) responderam.add(lead);
  }

  const abertos = abertaEm.size;
  return {
    enviadosHoje: total.count ?? deHoje.data.length,
    chipsHoje: chips.size,
    aberturas7d: abertos,
    respondidas7d: responderam.size,
    taxaDeResposta: abertos > 0 ? responderam.size / abertos : null,
  };
}

/**
 * Oito janelas de 7 dias terminando no fim de hoje (local), cada uma com duas
 * contagens (`count`, sem linha nenhuma: 16 consultas pequenas que o `max_rows`
 * não corta). "Respondida" é a conversa com mensagem dos DOIS lados — seja quem
 * começou.
 */
async function semanasDoGrafico(
  db: SupabaseClient,
  org: string,
  hoje: Date,
): Promise<SemanaDoGrafico[]> {
  const fim = hoje.getTime() + DIA;
  const inicio = fim - SEMANAS * 7 * DIA;
  const daSemana = (de: number) =>
    db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("is_group", false)
      .gte("created_at", new Date(de).toISOString())
      .lt("created_at", new Date(de + 7 * DIA).toISOString());

  return Promise.all(
    Array.from({ length: SEMANAS }, async (_, i) => {
      const de = inicio + i * 7 * DIA;
      const [iniciadas, respondidas] = await Promise.all([
        daSemana(de),
        daSemana(de).not("last_inbound_at", "is", null).not("last_outbound_at", "is", null),
      ]);
      lancar("semana_iniciadas", iniciadas.error);
      lancar("semana_respondidas", respondidas.error);
      return {
        inicio: new Date(de).toISOString(),
        iniciadas: iniciadas.count ?? 0,
        respondidas: respondidas.count ?? 0,
      };
    }),
  );
}

async function listarFunis(
  db: SupabaseClient,
  org: string,
  config: Linha | null,
): Promise<FunilDoInicio[]> {
  const [{ data: pipes, error: e1 }, { data: etapas, error: e2 }] = await Promise.all([
    db
      .from("crm_pipelines")
      .select("id, name, position")
      .eq("organization_id", org)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
    db
      .from("crm_stages")
      .select("id, pipeline_id, position")
      .eq("organization_id", org)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
  ]);
  lancar("funis", e1);
  lancar("etapas", e2);

  const porFunil = new Map<string, Array<{ id: string; position: number }>>();
  for (const s of (etapas ?? []) as Array<{ id: string; pipeline_id: string; position: number }>) {
    porFunil.set(s.pipeline_id, [...(porFunil.get(s.pipeline_id) ?? []), s]);
  }
  const etapaDoMotor =
    config?.ligado === true && typeof config.fonte_stage_id === "string"
      ? config.fonte_stage_id
      : null;

  return Promise.all(
    ((pipes ?? []) as Array<{ id: string; name: string }>).map(async (p) => {
      const lista = [...(porFunil.get(p.id) ?? [])].sort((a, b) => a.position - b.position);
      const primeira = lista[0]?.id ?? null;
      const [total, naPrimeira] = await Promise.all([
        db
          .from("crm_leads")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org)
          .eq("pipeline_id", p.id),
        primeira
          ? db
              .from("crm_leads")
              .select("id", { count: "exact", head: true })
              .eq("organization_id", org)
              .eq("pipeline_id", p.id)
              .eq("stage_id", primeira)
          : Promise.resolve({ count: 0, error: null }),
      ]);
      lancar("leads_do_funil", total.error);
      lancar("leads_na_primeira", naPrimeira.error);
      const leads = total.count ?? 0;
      const alem = Math.max(0, leads - (naPrimeira.count ?? 0));
      return {
        id: p.id,
        nome: p.name,
        leads,
        etapas: lista.length,
        motorLigado: !!etapaDoMotor && lista.some((s) => s.id === etapaDoMotor),
        alemDaPrimeira: leads > 0 ? alem / leads : 0,
      };
    }),
  );
}

async function ultimasAtividades(
  db: SupabaseClient,
  org: string,
  nomesDeUsuarios: OpcoesDoResumo["nomesDeUsuarios"],
): Promise<AtividadeDoInicio[]> {
  const { data, error } = await db
    .from("crm_lead_activities")
    .select("id, type, actor_kind, actor_agent_id, performed_by_user_id, lead_id, performed_at")
    .eq("organization_id", org)
    .order("performed_at", { ascending: false })
    .limit(ATIVIDADES);
  lancar("atividades", error);
  const linhas = (data ?? []) as Array<{
    id: string;
    type: string;
    actor_kind: string | null;
    actor_agent_id: string | null;
    performed_by_user_id: string | null;
    lead_id: string | null;
    performed_at: string;
  }>;
  if (linhas.length === 0) return [];

  const ids = <K extends keyof (typeof linhas)[number]>(k: K) =>
    [
      ...new Set(linhas.map((l) => l[k]).filter((v): v is NonNullable<typeof v> => !!v)),
    ] as string[];
  const leadIds = ids("lead_id");
  const agenteIds = ids("actor_agent_id");
  const usuarioIds = ids("performed_by_user_id");

  const [leads, agentes, usuarios] = await Promise.all([
    leadIds.length
      ? db.from("crm_leads").select("id, title").eq("organization_id", org).in("id", leadIds)
      : Promise.resolve({ data: [], error: null }),
    agenteIds.length
      ? db.from("ai_agents").select("id, name").eq("organization_id", org).in("id", agenteIds)
      : Promise.resolve({ data: [], error: null }),
    usuarioIds.length && nomesDeUsuarios ? nomesDeUsuarios(usuarioIds) : Promise.resolve(new Map()),
  ]);
  lancar("titulos", leads.error);
  lancar("agentes", agentes.error);
  const titulo = new Map(
    ((leads.data ?? []) as Array<{ id: string; title: string }>).map((l) => [l.id, l.title]),
  );
  const agente = new Map(
    ((agentes.data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]),
  );

  return linhas.map((l) => ({
    id: l.id,
    tipo: l.type,
    rotulo: activityLabel(l.type),
    autor: actorName(l.actor_kind, {
      agente: l.actor_agent_id ? (agente.get(l.actor_agent_id) ?? null) : null,
      usuario: l.performed_by_user_id ? (usuarios.get(l.performed_by_user_id) ?? null) : null,
    }),
    especie: l.actor_kind,
    lead: l.lead_id ? (titulo.get(l.lead_id) ?? null) : null,
    em: l.performed_at,
  }));
}
