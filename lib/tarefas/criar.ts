/**
 * CRIAR UMA TAREFA — o caminho único da tela (`POST /api/v1/tasks`) e do MCP (`crm_create_task`).
 *
 * Dois ingressos, uma regra: o mesmo insert, a mesma auditoria (`crm_task.created`), a mesma linha na timeline do
 * negócio e, quando a tarefa é PARA um agente externo (`agente_externo_id`, migration 0256), o evento
 * `tarefa.criada_para_agente` — o webhook de saída que o agente assina para saber que tem trabalho.
 *
 * O agente da tarefa é conferido aqui: precisa ser desta organização e não estar revogado. A FK sozinha não basta
 * (ela aceita o id de um agente de OUTRA organização).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import type { NovaTarefa, Tarefa } from "@/lib/tarefas/tipos";

export const COLUNAS_DA_TAREFA =
  "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, assigned_to, agente_externo_id, created_by, created_at, updated_at";

export type TarefaCriada = Tarefa;

export type FalhaAoCriarTarefa = "vinculo_inexistente" | "agente_inexistente" | "erro_do_banco";

export async function criarTarefa(
  db: SupabaseClient,
  entrada: {
    orgId: string;
    dados: NovaTarefa;
    /** Pessoa que criou (sessão). Nulo quando quem cria é um token (agente externo). */
    actorUserId: string | null;
    actorApiTokenId?: string | null;
    requestId: string;
  },
): Promise<{ ok: true; tarefa: TarefaCriada } | { ok: false; motivo: FalhaAoCriarTarefa }> {
  const { orgId, dados, actorUserId, requestId } = entrada;

  // Cada vínculo é da ORGANIZAÇÃO, conferido aqui: a FK só diz que a linha existe, em qualquer organização, e pelo MCP
  // quem grava é o admin client (sem RLS). Pessoa responsável = membro ativo (convite não revogado).
  //
  // A pessoa responsável é conferida pelo ADMIN client, filtrado por organização: a policy de SELECT de
  // `user_organizations` é self-OU-admin, e com o client da sessão um atendente (`agent`) só via a PRÓPRIA linha —
  // toda tarefa atribuída a um colega voltava "a pessoa vinculada não existe". A conferência só responde "é membro
  // ativo desta organização?", com a organização vinda de fonte confiável; nada da linha volta a quem chamou.
  const vinculos: { tabela: string; coluna: string; valor: string | null | undefined; leitor: () => SupabaseClient }[] = [
    { tabela: "crm_leads", coluna: "id", valor: dados.lead_id, leitor: () => db },
    { tabela: "contacts", coluna: "id", valor: dados.contact_id, leitor: () => db },
    { tabela: "user_organizations", coluna: "user_id", valor: dados.assigned_to, leitor: createAdminClient },
  ];
  for (const v of vinculos) {
    if (!v.valor) continue;
    let q = v.leitor().from(v.tabela).select(v.coluna).eq("organization_id", orgId).eq(v.coluna, v.valor);
    if (v.tabela === "user_organizations") q = q.is("revoked_at", null);
    const { data: achado, error } = await q.limit(1).maybeSingle();
    if (error) return { ok: false, motivo: "erro_do_banco" };
    if (!achado) return { ok: false, motivo: "vinculo_inexistente" };
  }

  if (dados.agente_externo_id) {
    const { data: agente, error } = await db
      .from("external_agents")
      .select("id, revogado_em")
      .eq("organization_id", orgId)
      .eq("id", dados.agente_externo_id)
      .maybeSingle();
    if (error) return { ok: false, motivo: "erro_do_banco" };
    if (!agente || (agente as { revogado_em: string | null }).revogado_em) return { ok: false, motivo: "agente_inexistente" };
  }

  const { data, error } = await db
    .from("crm_tasks")
    .insert({ ...dados, organization_id: orgId, created_by: actorUserId })
    .select(COLUNAS_DA_TAREFA)
    .single();
  if (error) {
    // 23503 = lead ou contato de outra organização (ou apagado no meio).
    return { ok: false, motivo: (error as { code?: string }).code === "23503" ? "vinculo_inexistente" : "erro_do_banco" };
  }
  const tarefa = data as unknown as TarefaCriada;

  await audit({
    organizationId: orgId,
    actorUserId,
    ...(entrada.actorApiTokenId ? { actorApiTokenId: entrada.actorApiTokenId } : {}),
    action: "crm_task.created",
    resourceType: "crm_tasks",
    resourceId: tarefa.id,
    requestId,
    metadata: {
      due_date: tarefa.due_date,
      priority: tarefa.priority,
      ...(tarefa.agente_externo_id ? { agente_externo_id: tarefa.agente_externo_id } : {}),
    },
  });

  // O laço de retorno: tarefa presa a um negócio aparece na linha do tempo dele (só com autor pessoa: a timeline
  // aponta para auth.users).
  if (actorUserId) {
    await registraAtividadeDaTarefa(db, { organizationId: orgId, tarefa, tipo: "task_created", actorUserId });
  }

  if (tarefa.agente_externo_id) {
    const { error: erroDoEvento } = await db.rpc("emit_event" as never, {
      p_event_type: "tarefa.criada_para_agente",
      p_entity_kind: "crm_task",
      p_entity_id: tarefa.id,
      p_payload: {
        tarefa_id: tarefa.id,
        agente_externo_id: tarefa.agente_externo_id,
        titulo: tarefa.title,
        prazo: tarefa.due_date,
        prioridade: tarefa.priority,
        lead_id: tarefa.lead_id,
        contact_id: tarefa.contact_id,
      },
      p_metadata: { actor_kind: actorUserId ? "user" : "external_agent" },
      p_organization_id: orgId,
    } as never);
    if (erroDoEvento) {
      logger.warn("[tarefas] emit_event tarefa.criada_para_agente falhou", {
        tarefa_id: tarefa.id,
        error: (erroDoEvento as { message: string }).message,
      });
    }
  }
  return { ok: true, tarefa };
}
