/**
 * O atendimento movendo o card do funil (`crm_leads.stage_id`).
 *
 * Quando a etapa da conversa muda (respondeu, qualificando, pronto_fechar,
 * fechado, perdido, nao_contatar), o card vai para a etapa EQUIVALENTE do funil
 * do próprio lead. A equivalência é DADO da organização —
 * `disparo_config.atendimento.funil`, etapa do atendimento → `crm_stages.slug`
 * — porque cada negócio nomeia o funil do seu jeito (exemplo: 8 etapas com os
 * mesmos nomes; organização B: 10 etapas de prospecção, sem "não contatar"). Etapa
 * sem equivalente não move: não inventamos coluna que a organização não criou.
 *
 * Mesmo desenho dos outros escritores de sistema (`lib/leads/handoff-stage-move.ts`,
 * `agent-stage-sync.ts`): admin client filtrando `organization_id` (fonte
 * confiável: a linha da conversa, nunca corpo de requisição), trava otimista
 * pela etapa de ORIGEM (se um humano moveu o card entre a leitura e a escrita,
 * a decisão dele vence), a linha `stage_changed` na timeline pelo emissor
 * compartilhado e o evento `lead.stage_changed` para automações e follow-up.
 * `status` nunca é escrito aqui: etapa de ganho/perda fecha o negócio pelo
 * trigger `fn_crm_lead_close_on_stage`.
 *
 * Regras próprias do atendimento:
 *  - negócio já fechado (ganho/perdido) não se mexe;
 *  - o card NÃO RECUA: se alguém já o pôs adiante, "respondeu" não o puxa de
 *    volta. Só perdido e nao_contatar (saídas) andam para trás.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";

import type { EtapaAtendimento } from "./estado";

/** De onde veio a mudança, na timeline e no evento (uma constante, nunca string solta). */
export const ORIGEM_DO_ATENDIMENTO = "disparo_atendimento";
/** O tipo da linha na timeline: o mesmo `stage_changed` que o board e o agente gravam. */
export const ATIVIDADE_DO_ATENDIMENTO: ActivityType = "stage_changed";

const ETAPAS_DE_SAIDA: ReadonlySet<EtapaAtendimento> = new Set(["perdido", "nao_contatar"]);

export type MovimentoDoFunil =
  | "movido"
  | "sem_mapa"
  | "sem_etapa_no_funil"
  | "ja_esta_la"
  | "nao_recua"
  | "lead_nao_encontrado"
  | "lead_fechado"
  | "conflito_humano"
  | "indisponivel";

type Etapa = { id: string; name: string; position: number };

export async function moverCardDoAtendimento(
  admin: SupabaseClient,
  input: { organizationId: string; leadId: string; etapa: EtapaAtendimento; slug: string | null; modo: "simulado" | "real" },
): Promise<MovimentoDoFunil> {
  const { organizationId: org, leadId, etapa, slug } = input;
  if (!slug) return "sem_mapa";
  const aviso = (o: string, error: { message: string }) =>
    logger.warn(`[disparo-funil] ${o} falhou`, { lead_id: leadId, organization_id: org, error: error.message });

  const { data: lead, error: e1 } = await admin
    .from("crm_leads")
    .select("id, pipeline_id, stage_id, contact_id, status")
    .eq("organization_id", org)
    .eq("id", leadId)
    .maybeSingle();
  if (e1) return (aviso("leitura do lead", e1), "indisponivel");
  if (!lead) return "lead_nao_encontrado";
  const l = lead as { id: string; pipeline_id: string; stage_id: string; contact_id: string | null; status: string };
  if (l.status !== "open") return "lead_fechado";

  const { data: etapas, error: e2 } = await admin
    .from("crm_stages")
    .select("id, name, slug, position")
    .eq("organization_id", org)
    .eq("pipeline_id", l.pipeline_id)
    .eq("is_archived", false);
  if (e2) return (aviso("leitura das etapas", e2), "indisponivel");
  const lista = (etapas ?? []) as (Etapa & { slug: string })[];
  const destino = lista.find((s) => s.slug === slug);
  if (!destino) return "sem_etapa_no_funil";
  if (destino.id === l.stage_id) return "ja_esta_la";
  const origem = lista.find((s) => s.id === l.stage_id) ?? null;
  if (origem && Number(destino.position) < Number(origem.position) && !ETAPAS_DE_SAIDA.has(etapa)) return "nao_recua";

  const { data: atualizadas, error: e3 } = await admin
    .from("crm_leads")
    .update({ stage_id: destino.id })
    .eq("organization_id", org)
    .eq("id", l.id)
    .eq("stage_id", l.stage_id)
    .eq("status", "open")
    .select("id");
  if (e3) return (aviso("update de stage_id", e3), "indisponivel");
  if (!(atualizadas ?? []).length) return "conflito_humano";

  const atividade = await emitLeadActivity(admin, {
    organizationId: org,
    leadId: l.id,
    contactId: l.contact_id,
    type: ATIVIDADE_DO_ATENDIMENTO,
    sourceModule: ORIGEM_DO_ATENDIMENTO,
    sourceId: l.id,
    actor: { type: "webhook_source", id: ORIGEM_DO_ATENDIMENTO },
    reason: `${stageChangeReason(origem?.name ?? null, destino.name)} (atendimento: ${etapa})`,
    payload: { etapa_do_atendimento: etapa, de: l.stage_id, para: destino.id, pipeline_id: l.pipeline_id, modo: input.modo },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: org,
      leadId: l.id,
      tipo: ATIVIDADE_DO_ATENDIMENTO,
      origem: "lib/disparo/atendimento/funil",
      erro: atividade.error,
    });
  }

  const { error: e4 } = await admin.rpc("emit_event" as never, {
    p_event_type: "lead.stage_changed",
    p_entity_kind: "crm_lead",
    p_entity_id: l.id,
    p_payload: { pipeline_id: l.pipeline_id, from_stage_id: l.stage_id, to_stage_id: destino.id, status: l.status },
    p_metadata: { actor_kind: "system", source: ORIGEM_DO_ATENDIMENTO, etapa_do_atendimento: etapa },
    p_organization_id: org,
  } as never);
  if (e4) aviso("emit_event lead.stage_changed", e4 as { message: string });
  return "movido";
}

/**
 * Move o card para a etapa de um PONTO DE PARADA (`parada.pontos[*].etapa`),
 * opcionalmente de outro funil (`pipelineSlug`). Mesmas garantias de
 * `moverCardDoAtendimento` (filtro de organização, trava otimista pela etapa de
 * origem, timeline e evento `lead.stage_changed`, status nunca escrito), com duas
 * diferenças: o destino vem do ponto, não do mapa de etapas; e no MESMO funil o
 * card não recua (operador que já pôs o card adiante vence). Mudar de funil é
 * decisão explícita do ponto, então não há comparação de posição.
 */
export async function moverCardParaEtapa(
  admin: SupabaseClient,
  input: { organizationId: string; leadId: string; pipelineSlug: string | null; etapaSlug: string; pontoId: string; modo: "simulado" | "real" },
): Promise<MovimentoDoFunil> {
  const { organizationId: org, leadId, etapaSlug } = input;
  const aviso = (o: string, error: { message: string }) =>
    logger.warn(`[disparo-funil] ${o} falhou`, { lead_id: leadId, organization_id: org, error: error.message });

  const { data: lead, error: e1 } = await admin
    .from("crm_leads")
    .select("id, pipeline_id, stage_id, contact_id, status")
    .eq("organization_id", org)
    .eq("id", leadId)
    .maybeSingle();
  if (e1) return (aviso("leitura do lead", e1), "indisponivel");
  if (!lead) return "lead_nao_encontrado";
  const l = lead as { id: string; pipeline_id: string; stage_id: string; contact_id: string | null; status: string };
  if (l.status !== "open") return "lead_fechado";

  let pipelineDestino = l.pipeline_id;
  if (input.pipelineSlug) {
    const { data: p, error: ep } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", org)
      .eq("slug", input.pipelineSlug)
      .eq("is_archived", false)
      .maybeSingle();
    if (ep) return (aviso("leitura do funil", ep), "indisponivel");
    if (!p) return "sem_etapa_no_funil";
    pipelineDestino = (p as { id: string }).id;
  }
  const mudaDeFunil = pipelineDestino !== l.pipeline_id;

  const { data: etapas, error: e2 } = await admin
    .from("crm_stages")
    .select("id, name, slug, position, pipeline_id")
    .eq("organization_id", org)
    .in("pipeline_id", mudaDeFunil ? [l.pipeline_id, pipelineDestino] : [l.pipeline_id])
    .eq("is_archived", false);
  if (e2) return (aviso("leitura das etapas", e2), "indisponivel");
  const lista = (etapas ?? []) as (Etapa & { slug: string; pipeline_id: string })[];
  const destino = lista.find((s) => s.slug === etapaSlug && s.pipeline_id === pipelineDestino);
  if (!destino) return "sem_etapa_no_funil";
  if (destino.id === l.stage_id) return "ja_esta_la";
  const origem = lista.find((s) => s.id === l.stage_id) ?? null;
  if (!mudaDeFunil && origem && Number(destino.position) < Number(origem.position)) return "nao_recua";

  const { data: atualizadas, error: e3 } = await admin
    .from("crm_leads")
    .update(mudaDeFunil ? { pipeline_id: pipelineDestino, stage_id: destino.id } : { stage_id: destino.id })
    .eq("organization_id", org)
    .eq("id", l.id)
    .eq("stage_id", l.stage_id)
    .eq("status", "open")
    .select("id");
  if (e3) return (aviso("update de stage_id", e3), "indisponivel");
  if (!(atualizadas ?? []).length) return "conflito_humano";

  const atividade = await emitLeadActivity(admin, {
    organizationId: org,
    leadId: l.id,
    contactId: l.contact_id,
    type: ATIVIDADE_DO_ATENDIMENTO,
    sourceModule: ORIGEM_DO_ATENDIMENTO,
    sourceId: l.id,
    actor: { type: "webhook_source", id: ORIGEM_DO_ATENDIMENTO },
    reason: `${stageChangeReason(origem?.name ?? null, destino.name)} (ponto de parada: ${input.pontoId})`,
    payload: { ponto_de_parada: input.pontoId, de: l.stage_id, para: destino.id, pipeline_id: pipelineDestino, muda_de_funil: mudaDeFunil, modo: input.modo },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: org,
      leadId: l.id,
      tipo: ATIVIDADE_DO_ATENDIMENTO,
      origem: "lib/disparo/atendimento/funil",
      erro: atividade.error,
    });
  }
  const { error: e4 } = await admin.rpc("emit_event" as never, {
    p_event_type: "lead.stage_changed",
    p_entity_kind: "crm_lead",
    p_entity_id: l.id,
    p_payload: { pipeline_id: pipelineDestino, from_stage_id: l.stage_id, to_stage_id: destino.id, status: l.status },
    p_metadata: { actor_kind: "system", source: ORIGEM_DO_ATENDIMENTO, ponto_de_parada: input.pontoId },
    p_organization_id: org,
  } as never);
  if (e4) aviso("emit_event lead.stage_changed", e4 as { message: string });
  return "movido";
}
