import { tipoContato } from "@/lib/negocio/tipo-contato";
/**
 * GET /api/v1/pipelines/[id]/board
 *
 * Returns the board for the Kanban: pipeline metadata + active stages (ordered
 * by position) + a PAGE of leads per stage (first `por_etapa`, default 50, in
 * column order) with each stage's real total in `stage_pages`. All RLS-filtered
 * to the caller's org via cookie session.
 *
 * Paginado: uma organização com uns 2 mil leads baixava tudo num JSON de alguns
 * MB para mostrar 50 cards por coluna. Contrato da query string no `GET`.
 *
 * Why this exists: previously useBoard hit supabase-js directly from the
 * browser. The auth cookie is httpOnly, which the browser Supabase client
 * cannot read — auth.uid() came back null and RLS dropped the pipeline row,
 * surfacing as PostgREST "Cannot coerce result to a single JSON object"
 * (PGRST116). Routing through the API ensures the server-side cookie reader
 * runs, same as every other authed query.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  roteiaProximasAcoes,
  type EstadoDoContato,
  type PropostaAmbigua,
} from "@/lib/leads/next-action";
import type { LeadCandidate } from "@/lib/leads/active-lead";
import { createClient } from "@/lib/supabase/server";
import { buscarEmLotes, buscarTodasAsPaginas } from "@/lib/supabase/em-lotes";
import {
  aplicarFiltrosDoBoard,
  cortarPagina,
  lerPedidoDoBoard,
} from "@/lib/kanban/board-pagina";
import type { LeadFilters } from "@/lib/kanban/filters";
import type {
  BoardData,
  Pipeline,
  Stage,
  StagePage,
  StagePageData,
} from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * Anexa a identidade do agente dono (nome + versão publicada) aos leads que têm
 * `owner_kind='ai'`.
 *
 * **Sem filtro de `is_active`/`archived_at` de propósito.** Quem é o dono é
 * pergunta de EXIBIÇÃO e vale para qualquer agente: desativar um bot não pode
 * transformar os negócios dele em cards anônimos. A lista de agentes que PODEM
 * receber um lead (o picker, `/api/v1/ai/agents/assignable`) é outra pergunta e
 * lá os filtros estão certos.
 *
 * `organization_id` é filtrado explicitamente — vem do pipeline já validado pela
 * RLS do caller, nunca do body.
 */
async function withOwnerAgents(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
): Promise<{ leads: Lead[]; error: string | null }> {
  const agentIds = [
    ...new Set(
      leads
        .filter((l) => l.owner_kind === "ai" && l.owner_agent_id)
        .map((l) => l.owner_agent_id as string),
    ),
  ];
  if (agentIds.length === 0) return { leads, error: null };

  const { data: agents, error: agentsErr } = await supabase
    .from("ai_agents")
    .select("id, name, published_version_id")
    .eq("organization_id", organizationId)
    .in("id", agentIds);
  if (agentsErr) return { leads, error: agentsErr.message };

  const agentRows = (agents ?? []) as Array<{
    id: string;
    name: string;
    published_version_id: string | null;
  }>;

  const publishedIds = agentRows
    .map((a) => a.published_version_id)
    .filter((v): v is string => !!v);
  const versionById = new Map<string, number>();
  if (publishedIds.length > 0) {
    const { data: versions, error: versionsErr } = await supabase
      .from("ai_agent_versions")
      .select("id, version_number")
      .eq("organization_id", organizationId)
      .in("id", publishedIds);
    if (versionsErr) return { leads, error: versionsErr.message };
    for (const v of (versions ?? []) as Array<{ id: string; version_number: number }>) {
      versionById.set(v.id, v.version_number);
    }
  }

  const byId = new Map(agentRows.map((a) => [a.id, a]));
  return {
    leads: leads.map((lead) => {
      if (lead.owner_kind !== "ai" || !lead.owner_agent_id) return lead;
      const agent = byId.get(lead.owner_agent_id);
      if (!agent) return lead;
      return {
        ...lead,
        owner_agent: {
          id: agent.id,
          name: agent.name,
          version_number: agent.published_version_id
            ? (versionById.get(agent.published_version_id) ?? null)
            : null,
        },
      };
    }),
    error: null,
  };
}

/**
 * Anexa a próxima ação proposta pelo agente aos leads que a receberam.
 *
 * Os candidatos são buscados por CONTATO na org inteira, e não só neste
 * pipeline: `resolveActiveLeadForContact` precisa enxergar todos os negócios
 * abertos da pessoa para poder chamar de ambíguo o que é ambíguo. Recortando a
 * lista por pipeline, dois negócios ambíguos em boards diferentes apareceriam
 * como um único negócio em cada board, e os dois exibiriam a mesma proposta.
 */
/**
 * Abre um item de caixa por proposta sem dono — no máximo um por contato.
 *
 * Deduplicado por (kind, ref_id, status='open') porque o board é lido a cada
 * refresh: sem isto, um contato ambíguo produziria um item por render até a
 * caixa virar ruído e ninguém mais olhar.
 *
 * Falha aqui NÃO derruba o board: o aviso é importante, mas menos que a tela
 * abrir. O erro sobe para o Sentry pelo caminho normal de exceção não tratada
 * do handler — o que não pode é o usuário perder o board por causa do aviso.
 */
async function avisaAmbiguas(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  ambiguas: PropostaAmbigua[],
): Promise<void> {
  if (ambiguas.length === 0) return;

  const { data: jaAbertos } = await buscarEmLotes(
    ambiguas.map((a) => a.contact_id),
    (lote, de, ate) =>
      supabase
        .from("agent_inbox_items")
        .select("id, ref_id")
        .eq("organization_id", organizationId)
        .eq("kind", "next_action_ambiguous")
        .eq("status", "open")
        .in("ref_id", lote)
        .order("id")
        .range(de, ate),
  );
  const abertos = new Set((jaAbertos as Array<{ ref_id: string }>).map((r) => r.ref_id));

  const novos = ambiguas
    .filter((a) => !abertos.has(a.contact_id))
    .map((a) => ({
      organization_id: organizationId,
      kind: "next_action_ambiguous",
      severity: "warn",
      title: `A IA propôs uma próxima ação, mas o contato tem ${a.candidateIds.length} negócios abertos`,
      body: `Proposta: "${a.texto}". Escolha a qual negócio ela pertence — o sistema não adivinha para não executar no negócio errado.`,
      ref_kind: "contact",
      ref_id: a.contact_id,
      status: "open",
    }));
  if (novos.length === 0) return;

  await supabase.from("agent_inbox_items").insert(novos);
}

/**
 * Anexa o score aos leads que o têm — LEFT JOIN, nunca INNER.
 *
 * Score ausente é estado legítimo (sinal insuficiente, cenário 17). Um INNER
 * apagaria do quadro justamente os leads sem sinal, que são os que mais
 * precisam de atenção humana — o oposto do que o produto existe para fazer.
 *
 * A faixa vem PERSISTIDA e é entregue como está: recalculá-la aqui (ou na UI)
 * ignoraria a histerese e devolveria o card piscando na fronteira, no único
 * lugar onde o CHECK de coerência não alcança.
 */
async function withScores(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
): Promise<{ leads: Lead[]; error: string | null }> {
  if (leads.length === 0) return { leads, error: null };

  // Em lotes: centenas de ids num `.in()` só estouravam a URL ("URI too long").
  const { data, error } = await buscarEmLotes(
    leads.map((l) => l.id),
    (lote, de, ate) =>
      supabase
        .from("crm_lead_scores")
        .select(
          "lead_id, ai_probability, ai_probability_reason, ai_probability_band, ai_probability_evidence, ai_probability_at",
        )
        .eq("organization_id", organizationId)
        .in("lead_id", lote)
        .order("lead_id")
        .range(de, ate),
  );
  if (error) return { leads, error };

  const porLead = new Map<string, NonNullable<Lead["score"]>>();
  for (const row of (data ?? []) as Array<{
    lead_id: string;
    ai_probability: number | string | null;
    ai_probability_reason: string | null;
    ai_probability_band: string | null;
    ai_probability_evidence: { factors?: unknown } | null;
    ai_probability_at: string | null;
  }>) {
    // `numeric` chega como string no supabase-js; `null` continua null — e a
    // diferença entre null e 0 é justamente o que não pode se perder aqui.
    if (row.ai_probability === null || row.ai_probability_band === null) continue;
    const factors = Array.isArray(row.ai_probability_evidence?.factors)
      ? (row.ai_probability_evidence.factors as NonNullable<Lead["score"]>["factors"])
      : [];
    porLead.set(row.lead_id, {
      probability: Number(row.ai_probability),
      reason: row.ai_probability_reason ?? "",
      band: row.ai_probability_band as NonNullable<Lead["score"]>["band"],
      factors,
      at: row.ai_probability_at,
    });
  }

  return {
    leads: leads.map((lead) => {
      const score = porLead.get(lead.id);
      return score ? { ...lead, score } : lead;
    }),
    error: null,
  };
}

/**
 * Anexa a conversa mais recente do contato — o atalho do quadro para o inbox.
 *
 * LEFT, como o score: lead sem contato (criado à mão, vindo de webhook) e
 * contato sem conversa são estados normais, e sumir com esses cards do quadro
 * seria esconder justamente os que ninguém atendeu ainda.
 *
 * A MAIS RECENTE por contato, não todas: o card mostra uma linha, e escolher na
 * UI exigiria trazer o histórico inteiro de cada lead para descartar quase tudo.
 *
 * Ordena por `last_message_at` e fica com a primeira de cada contato — as
 * conversas já vêm ordenadas, então o primeiro visto é o mais recente.
 */
async function withConversas(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
): Promise<{ leads: Lead[]; error: string | null }> {
  const contactIds = [...new Set(leads.map((l) => l.contact_id).filter((c): c is string => !!c))];
  const links = await buscarEmLotes(leads.map((lead) => lead.id), (lote, de, ate) =>
    supabase.from("crm_lead_links").select("lead_id, target_id, id")
      .eq("organization_id", organizationId).eq("target_kind", "conversation")
      .in("lead_id", lote).order("id").range(de, ate),
  );
  if (links.error) return { leads, error: links.error };
  const conversationIds = [...new Set(links.data.map((link) => link.target_id))];
  const vinculadas = await buscarEmLotes(conversationIds, (lote, de, ate) =>
    supabase.from("conversations")
      .select("id, contact_id, last_message_preview, last_message_at, unread_count_for_assignee")
      .eq("organization_id", organizationId).in("id", lote).order("id").range(de, ate),
  );
  if (vinculadas.error) return { leads, error: vinculadas.error };

  // Lote por CONTATO: todas as conversas de um contato caem no mesmo lote, então
  // a ordem por atividade dentro do lote basta para o "primeiro visto vence".
  const { data, error } = await buscarEmLotes(contactIds, (lote, de, ate) =>
    supabase
      .from("conversations")
      .select("id, contact_id, last_message_preview, last_message_at, unread_count_for_assignee")
      .eq("organization_id", organizationId)
      .in("contact_id", lote)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id")
      .range(de, ate),
  );
  if (error) return { leads, error };

  const porContato = new Map<string, NonNullable<Lead["conversa"]>>();
  const porId = new Map(vinculadas.data.map((row) => [row.id, {
    id: row.id, preview: row.last_message_preview, last_message_at: row.last_message_at,
    unread: row.unread_count_for_assignee ?? 0,
  }]));
  const porLead = new Map<string, NonNullable<Lead["conversa"]>>();
  for (const link of links.data) {
    const conversa = porId.get(link.target_id);
    if (conversa && !porLead.has(link.lead_id)) porLead.set(link.lead_id, conversa);
  }
  for (const row of (data ?? []) as Array<{
    id: string;
    contact_id: string;
    last_message_preview: string | null;
    last_message_at: string | null;
    unread_count_for_assignee: number | null;
  }>) {
    // Primeira vista vence: a consulta já veio ordenada por atividade.
    if (porContato.has(row.contact_id)) continue;
    porContato.set(row.contact_id, {
      id: row.id,
      preview: row.last_message_preview,
      last_message_at: row.last_message_at,
      unread: row.unread_count_for_assignee ?? 0,
    });
  }

  return {
    leads: leads.map((lead) => {
      const conversa = porLead.get(lead.id) ?? (lead.contact_id ? porContato.get(lead.contact_id) : undefined);
      return conversa ? { ...lead, conversa } : lead;
    }),
    error: null,
  };
}

async function withNextActions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leads: Lead[],
  defaultPipelineId: string | null,
): Promise<{ leads: Lead[]; error: string | null }> {
  const contactIds = [
    ...new Set(leads.map((l) => l.contact_id).filter((c): c is string => !!c)),
  ];
  if (contactIds.length === 0) return { leads, error: null };

  const [{ data: estados, error: estadosErr }, { data: candidatos, error: candErr }] =
    await Promise.all([
      buscarEmLotes(contactIds, (lote, de, ate) =>
        supabase
          .from("lead_state")
          .select("contact_id, next_action, next_action_seq, updated_at")
          .eq("organization_id", organizationId)
          .in("contact_id", lote)
          .not("next_action", "is", null)
          .order("contact_id")
          .range(de, ate),
      ),
      buscarEmLotes(contactIds, (lote, de, ate) =>
        supabase
          .from("crm_leads")
          .select(
            "id, organization_id, pipeline_id, status, last_activity_at, created_at, contact_id",
          )
          .eq("organization_id", organizationId)
          .eq("status", "open")
          .in("contact_id", lote)
          .order("id")
          .range(de, ate),
      ),
    ]);
  if (estadosErr) return { leads, error: estadosErr };
  if (candErr) return { leads, error: candErr };
  if (!estados || estados.length === 0) return { leads, error: null };

  const { porLead, ambiguas } = roteiaProximasAcoes(
    estados as EstadoDoContato[],
    (candidatos ?? []) as Array<LeadCandidate & { contact_id: string | null }>,
    { defaultPipelineId },
  );

  // Recusar o palpite não pode virar silêncio: a proposta que não achou dono vai
  // para a caixa, onde um humano desambigua. Escrever a partir de um GET não é
  // bonito, e é deliberado — a ambiguidade só EXISTE quando se olha o conjunto
  // de negócios abertos AGORA, e é aqui que esse olhar acontece. Fazer no
  // momento da escrita da proposta perderia o caso em que o segundo negócio
  // nasce depois dela.
  await avisaAmbiguas(supabase, organizationId, ambiguas);

  if (porLead.size === 0) return { leads, error: null };

  return {
    leads: leads.map((lead) => {
      const acao = porLead.get(lead.id);
      return acao ? { ...lead, next_action: acao } : lead;
    }),
    error: null,
  };
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Uma página de UMA etapa: `limite + 1` linhas na ordem da coluna (a extra só
 * diz onde a próxima começa) e o total da etapa com o filtro — `count: exact`,
 * contagem no banco, nunca o tamanho do array.
 *
 * `organization_id` explícito além da RLS: casa com o índice
 * `idx_crm_leads_org_stage_position (organization_id, stage_id, position_in_stage)`.
 */
async function paginaDaEtapa(
  supabase: Supabase,
  organizationId: string,
  pipelineId: string,
  stageId: string,
  offset: number,
  limite: number,
  filtros: LeadFilters,
  hoje: string,
): Promise<{ leads: Lead[]; total: number; next_position: number | null; error: string | null }> {
  const base = supabase
    .from("crm_leads")
    .select("*", { count: "exact" })
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("stage_id", stageId)
    .neq("status", "archived");
  const { data, error, count } = await aplicarFiltrosDoBoard(base, filtros, hoje)
    .order("position_in_stage")
    .order("id")
    .range(offset, offset + limite);
  if (error) return { leads: [], total: 0, next_position: null, error: error.message };
  const { leads, next_position } = cortarPagina((data ?? []) as Lead[], limite);
  return { leads, total: count ?? offset + leads.length, next_position, error: null };
}

/**
 * Soma de valor por etapa, com o filtro. Só as linhas com valor (`> 0`) e só
 * duas colunas: numa organização nenhuma tem valor e a consulta volta vazia.
 */
async function valoresPorEtapa(
  supabase: Supabase,
  organizationId: string,
  pipelineId: string,
  filtros: LeadFilters,
  hoje: string,
): Promise<{ data: Map<string, number>; error: string | null }> {
  const { data, error } = await buscarTodasAsPaginas((de, ate) =>
    aplicarFiltrosDoBoard(
      supabase
        .from("crm_leads")
        .select("id, stage_id, value_cents")
        .eq("organization_id", organizationId)
        .eq("pipeline_id", pipelineId)
        .neq("status", "archived")
        .gt("value_cents", 0),
      filtros,
      hoje,
    )
      .order("id")
      .range(de, ate),
  );
  const soma = new Map<string, number>();
  for (const r of data as Array<{ stage_id: string; value_cents: number | null }>) {
    soma.set(r.stage_id, (soma.get(r.stage_id) ?? 0) + Number(r.value_cents ?? 0));
  }
  return { data: soma, error };
}

/**
 * Tags em uso no funil INTEIRO, sem os filtros da tela — as opções do filtro
 * de tag saíam de todos os leads, e com página parcial sumiriam.
 */
async function tagsDoFunil(
  supabase: Supabase,
  organizationId: string,
  pipelineId: string,
): Promise<{ data: string[]; error: string | null }> {
  const { data, error } = await buscarTodasAsPaginas((de, ate) =>
    supabase
      .from("crm_leads")
      .select("id, tags")
      .eq("organization_id", organizationId)
      .eq("pipeline_id", pipelineId)
      .neq("status", "archived")
      .neq("tags", "{}")
      .order("id")
      .range(de, ate),
  );
  const set = new Set<string>();
  for (const r of data as Array<{ tags: string[] | null }>) for (const t of r.tags ?? []) set.add(t);
  return { data: [...set].sort(), error };
}

/**
 * Os dados auxiliares do card (dono agente, próxima ação, score, conversa) —
 * só para os leads que a resposta vai levar.
 */
async function enriquecer(
  supabase: Supabase,
  organizationId: string,
  leads: Lead[],
): Promise<{ leads: Lead[]; error: string | null }> {
  if (leads.length === 0) return { leads, error: null };
  const comDono = await withOwnerAgents(supabase, organizationId, leads);
  if (comDono.error) return comDono;

  const { data: pipelinePadrao } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .maybeSingle();

  const comAcao = await withNextActions(
    supabase,
    organizationId,
    comDono.leads,
    (pipelinePadrao as { id: string } | null)?.id ?? null,
  );
  if (comAcao.error) return comAcao;
  const comScore = await withScores(supabase, organizationId, comAcao.leads);
  if (comScore.error) return comScore;
  const leadsComConversa = await withConversas(supabase, organizationId, comScore.leads);
  if (leadsComConversa.error) return leadsComConversa;
  const ids = [...new Set(leads.map((lead) => lead.contact_id).filter((id): id is string => !!id))];
  if (!ids.length) return leadsComConversa;
  const contatos = await buscarEmLotes(ids, (lote, de, ate) => supabase.from("contacts")
    .select("id, source_metadata").eq("organization_id", organizationId).in("id", lote).order("id").range(de, ate));
  if (contatos.error) return { leads: leadsComConversa.leads, error: contatos.error };
  const tipos = new Map((contatos.data ?? []).map((contato) => [contato.id, tipoContato(contato.source_metadata)]));
  return { leads: leadsComConversa.leads.map((lead) => {
    const tipo = lead.contact_id ? tipos.get(lead.contact_id) : undefined;
    return tipo ? { ...lead, tipo_contato: tipo } : lead;
  }), error: null };
}

/**
 * Query string (toda opcional):
 *  - filtros da tela, com os mesmos nomes da URL do quadro: `owner`, `status`,
 *    `tag`, `q`, `overdue=1` — aplicados no banco, na página E no total;
 *  - `por_etapa` (padrão 50, máx. 500) e `limites=<etapa>:<n>,…` — quantos
 *    cards cada etapa já tinha aberta (o refetch não fecha as páginas extras);
 *  - `stage_id` + `offset`: só a página seguinte daquela etapa
 *    (`{ stage_id, offset, leads, total, value_cents, next_position }`);
 *  - `lead`: deep link; se o lead não cair em nenhuma página vem em `lead_em_foco`.
 */
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: pipelineId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");

  const lido = lerPedidoDoBoard(req.nextUrl.searchParams);
  if (!lido.ok) return fail("validation_error", lido.erro, 400, { requestId });
  const { filtros, porEtapa, limites, etapa, leadEmFoco } = lido.pedido;
  const hoje = new Date().toISOString().slice(0, 10);

  const [{ data: pipeline, error: pipelineErr }, { data: stages, error: stagesErr }] =
    await Promise.all([
      supabase.from("crm_pipelines").select("*").eq("id", pipelineId).maybeSingle(),
      supabase
        .from("crm_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .eq("is_archived", false)
        .order("position"),
    ]);

  if (pipelineErr) return fail("internal_error", pipelineErr.message, 500, { requestId });
  if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });
  if (!pipeline) return fail("resource_not_found", t("Pipeline não encontrado."), 404, { requestId });
  const orgId = (pipeline as Pipeline).organization_id;
  const etapas = (stages ?? []) as Stage[];

  // ── Página seguinte de UMA etapa ("Mostrar mais") ──────────────────────────
  if (etapa) {
    // A etapa tem de ser DESTE pipeline (já filtrado pela RLS): um stage_id de
    // outro funil não pode virar porta para ler os leads dele por aqui.
    if (!etapas.some((s) => s.id === etapa.id)) {
      return fail("resource_not_found", t("Etapa não encontrada."), 404, { requestId });
    }
    const [pagina, valores] = await Promise.all([
      paginaDaEtapa(supabase, orgId, pipelineId, etapa.id, etapa.offset, porEtapa, filtros, hoje),
      valoresPorEtapa(supabase, orgId, pipelineId, filtros, hoje),
    ]);
    if (pagina.error) return fail("internal_error", pagina.error, 500, { requestId });
    if (valores.error) return fail("internal_error", valores.error, 500, { requestId });
    const ricos = await enriquecer(supabase, orgId, pagina.leads);
    if (ricos.error) return fail("internal_error", ricos.error, 500, { requestId });
    const resposta: StagePageData = {
      stage_id: etapa.id,
      offset: etapa.offset,
      leads: ricos.leads,
      total: pagina.total,
      value_cents: valores.data.get(etapa.id) ?? 0,
      next_position: pagina.next_position,
    };
    return ok(resposta, { requestId });
  }

  // ── Primeira carga / refetch: uma página por etapa ─────────────────────────
  const [paginas, valores, tags, foco] = await Promise.all([
    Promise.all(
      etapas.map((s) =>
        paginaDaEtapa(
          supabase,
          orgId,
          pipelineId,
          s.id,
          0,
          Math.max(porEtapa, limites.get(s.id) ?? 0),
          filtros,
          hoje,
        ),
      ),
    ),
    valoresPorEtapa(supabase, orgId, pipelineId, filtros, hoje),
    tagsDoFunil(supabase, orgId, pipelineId),
    leadEmFoco
      ? supabase
          .from("crm_leads")
          .select("*")
          .eq("organization_id", orgId)
          .eq("pipeline_id", pipelineId)
          .eq("id", leadEmFoco)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const erroPagina = paginas.find((p) => p.error)?.error;
  if (erroPagina) return fail("internal_error", erroPagina, 500, { requestId });
  if (valores.error) return fail("internal_error", valores.error, 500, { requestId });
  if (tags.error) return fail("internal_error", tags.error, 500, { requestId });
  if (foco.error) return fail("internal_error", foco.error.message, 500, { requestId });

  const leadsDasPaginas = paginas.flatMap((p) => p.leads);
  const focoBruto = foco.data as Lead | null;
  const focoAvulso =
    focoBruto && !leadsDasPaginas.some((l) => l.id === focoBruto.id) ? focoBruto : null;

  const ricos = await enriquecer(
    supabase,
    orgId,
    focoAvulso ? [...leadsDasPaginas, focoAvulso] : leadsDasPaginas,
  );
  if (ricos.error) return fail("internal_error", ricos.error, 500, { requestId });

  const stage_pages: Record<string, StagePage> = {};
  etapas.forEach((s, i) => {
    stage_pages[s.id] = {
      total: paginas[i]!.total,
      value_cents: valores.data.get(s.id) ?? 0,
      next_position: paginas[i]!.next_position,
    };
  });

  const board: BoardData = {
    pipeline: pipeline as Pipeline,
    stages: etapas,
    leads: focoAvulso ? ricos.leads.slice(0, -1) : ricos.leads,
    stage_pages,
    tags: tags.data,
    lead_em_foco: focoAvulso ? (ricos.leads.at(-1) ?? null) : null,
  };

  return ok(board, { requestId });
}

