/**
 * CONVERSA ESPERANDO: o cliente escreveu por último e ninguém respondeu há N minutos (padrão 15).
 *
 * "Esperando" é a mesma régua da tela Início (`lib/inicio/resumo.ts`): conversa aberta, nunca grupo, e a última
 * mensagem do cliente mais nova que a nossa. Duas saídas usam esta função:
 *   - a ferramenta MCP `crm_list_waiting_conversations` (o agente pergunta "quem está esperando?");
 *   - o cron `conversa-esperando`, que emite o evento `conversa.esperando` (webhook de saída assinável pelo agente).
 *
 * UMA VEZ POR CONVERSA POR ESPERA. A espera é identificada pelo `last_inbound_at` que a abriu: enquanto ninguém
 * responde e o cliente não escreve de novo, é a mesma espera. A trava é a chave primária de
 * `conversa_esperas_avisadas (conversation_id, desde)` (migration 0256): o segundo aviso da mesma espera morre no
 * 23505, mesmo com duas rodadas do cron ao mesmo tempo. Cliente que escreve de novo depois de respondido abre outra
 * espera, com outro `desde`, e ela avisa de novo.
 *
 * Só se olha para trás 24 h: a primeira rodada numa instalação antiga não pode disparar um evento por cada conversa
 * esquecida há meses.
 *
 * O evento só é emitido para organização que TEM regra ativa assinando `conversa.esperando` — evento sem consumidor
 * seria ruído no `event_log` (anti-pattern nº 3).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";

export const MINUTOS_DE_ESPERA_PADRAO = 15;
export const HORAS_OLHANDO_PARA_TRAS = 24;
const LIMITE_POR_ORGANIZACAO = 500;

/** N da organização: `settings.agentes_externos.minutos_conversa_esperando`, de 1 a 1440; senão 15. */
export function minutosDeEspera(settings: unknown): number {
  const bloco = settings && typeof settings === "object" ? (settings as Record<string, unknown>).agentes_externos : null;
  const valor = bloco && typeof bloco === "object" ? (bloco as Record<string, unknown>).minutos_conversa_esperando : null;
  return typeof valor === "number" && Number.isInteger(valor) && valor >= 1 && valor <= 1440 ? valor : MINUTOS_DE_ESPERA_PADRAO;
}

export interface ConversaEsperando {
  conversation_id: string;
  contact_id: string;
  assigned_to_user_id: string | null;
  /** O `last_inbound_at` que abriu a espera. */
  desde: string;
  minutos_esperando: number;
}

type LinhaDaConversa = {
  id: string;
  contact_id: string;
  assigned_to_user_id: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
};

export async function listarConversasEsperando(
  db: SupabaseClient,
  orgId: string,
  opcoes: { agora?: Date; minutos?: number; limite?: number } = {},
): Promise<{ ok: true; conversas: ConversaEsperando[] } | { ok: false; erro: string }> {
  const agora = opcoes.agora ?? new Date();
  const minutos = opcoes.minutos ?? MINUTOS_DE_ESPERA_PADRAO;
  const limiteDaEspera = new Date(agora.getTime() - minutos * 60_000).toISOString();
  const horizonte = new Date(agora.getTime() - HORAS_OLHANDO_PARA_TRAS * 3_600_000).toISOString();

  const { data, error } = await db
    .from("conversations")
    .select("id, contact_id, assigned_to_user_id, last_inbound_at, last_outbound_at")
    .eq("organization_id", orgId)
    .eq("is_group", false)
    .in("status", [...OPEN_LOAD_STATUSES])
    .lt("last_inbound_at", limiteDaEspera)
    .gte("last_inbound_at", horizonte)
    .order("last_inbound_at", { ascending: true })
    .limit(opcoes.limite ?? LIMITE_POR_ORGANIZACAO);
  if (error) return { ok: false, erro: (error as { message: string }).message };

  const conversas = ((data ?? []) as LinhaDaConversa[])
    // A régua da Início: a última do cliente é mais nova que a nossa. O PostgREST não compara coluna com coluna.
    .filter((c) => c.last_inbound_at && (!c.last_outbound_at || c.last_inbound_at > c.last_outbound_at))
    .map((c) => ({
      conversation_id: c.id,
      contact_id: c.contact_id,
      assigned_to_user_id: c.assigned_to_user_id,
      desde: c.last_inbound_at!,
      minutos_esperando: Math.floor((agora.getTime() - Date.parse(c.last_inbound_at!)) / 60_000),
    }));
  return { ok: true, conversas };
}

/**
 * Uma rodada do cron: emite `conversa.esperando` uma vez por conversa por espera, nas organizações que assinam o
 * evento. Devolve quantas avisou e as falhas (por organização), para o cron auditar quando houve efeito.
 */
export async function avisarConversasEsperando(
  admin: SupabaseClient,
  agora: Date = new Date(),
): Promise<{ avisadas: number; organizacoes: number; falhas: string[] }> {
  const falhas: string[] = [];
  const { data: regras, error } = await admin
    .from("automation_rules")
    .select("organization_id")
    .eq("trigger_event", "conversa.esperando")
    .eq("is_active", true);
  if (error) return { avisadas: 0, organizacoes: 0, falhas: [`regras: ${error.message}`] };
  const orgs = [...new Set(((regras ?? []) as { organization_id: string }[]).map((r) => r.organization_id))];

  let avisadas = 0;
  for (const orgId of orgs) {
    const { data: org } = await admin.from("organizations").select("settings").eq("id", orgId).maybeSingle();
    const minutos = minutosDeEspera((org as { settings?: unknown } | null)?.settings);
    const r = await listarConversasEsperando(admin, orgId, { agora, minutos });
    if (!r.ok) {
      falhas.push(`${orgId}: ${r.erro}`);
      continue;
    }
    for (const c of r.conversas) {
      const { error: erroDaTrava } = await admin
        .from("conversa_esperas_avisadas")
        .insert({ organization_id: orgId, conversation_id: c.conversation_id, desde: c.desde });
      if (erroDaTrava) {
        // 23505 = esta espera já foi avisada (por esta rodada ou por outra ao mesmo tempo). Não é falha.
        if ((erroDaTrava as { code?: string }).code !== "23505") falhas.push(`${orgId}: ${erroDaTrava.message}`);
        continue;
      }
      const { error: erroDoEvento } = await admin.rpc("emit_event" as never, {
        p_event_type: "conversa.esperando",
        p_entity_kind: "conversation",
        p_entity_id: c.conversation_id,
        p_payload: {
          conversation_id: c.conversation_id,
          contact_id: c.contact_id,
          esperando_desde: c.desde,
          minutos_esperando: c.minutos_esperando,
          limite_minutos: minutos,
          responsavel_user_id: c.assigned_to_user_id,
        },
        p_metadata: { actor_kind: "system", source: "cron:conversa-esperando" },
        p_organization_id: orgId,
      } as never);
      if (erroDoEvento) {
        // Sem o evento, a trava não pode ficar: a rodada seguinte tem de tentar de novo, senão a espera some calada.
        await admin
          .from("conversa_esperas_avisadas")
          .delete()
          .eq("organization_id", orgId)
          .eq("conversation_id", c.conversation_id)
          .eq("desde", c.desde);
        falhas.push(`${orgId}: ${(erroDoEvento as { message: string }).message}`);
        continue;
      }
      avisadas += 1;
    }
  }
  return { avisadas, organizacoes: orgs.length, falhas };
}

/** As travas de `conversa.esperando` ficam 30 dias: o cron só olha 24 h para trás, então a mais velha nunca mais decide nada. */
export const DIAS_DE_RETENCAO_DAS_ESPERAS = 30;

/** Poda das travas velhas, chamada pelo cron diário `data-retention`. Devolve quantas apagou; erro lança. */
export async function podarEsperasAvisadas(admin: SupabaseClient, agora: Date = new Date()): Promise<number> {
  const limite = new Date(agora.getTime() - DIAS_DE_RETENCAO_DAS_ESPERAS * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("conversa_esperas_avisadas")
    .delete()
    .lt("avisado_em", limite)
    .select("conversation_id");
  if (error) throw new Error(`conversa_esperas_avisadas: ${(error as { message: string }).message}`);
  return (data ?? []).length;
}
