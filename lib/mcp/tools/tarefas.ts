/**
 * TAREFAS pelo MCP — até aqui as tarefas da equipe (`crm_tasks`, migration 0210) não tinham ferramenta.
 *
 * É a outra metade de "o agente para antes de fechar a venda": a recusa diz "crie uma tarefa para uma pessoa da
 * equipe", e o agente precisa de como criá-la. E é a porta de entrada de trabalho PARA o agente: tarefa com
 * `agente_externo_id` dispara `tarefa.criada_para_agente`, e `crm_list_tasks { para_mim: true }` devolve as dele.
 *
 * Criar passa pelo MESMO caminho da tela (`criarTarefa`, `lib/tarefas/criar.ts`): insert, auditoria e evento.
 * Service role bypassa RLS: TODA consulta filtra `ctx.organizationId`, nunca o input.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import { COLUNAS_DA_TAREFA, criarTarefa } from "@/lib/tarefas/criar";
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA } from "@/lib/tarefas/tipos";

import type { McpToolDefinition } from "../types";

// ---------------------------------------------------------------------------
// listar
// ---------------------------------------------------------------------------

const listarShape = {
  para_mim: z
    .boolean()
    .optional()
    .default(false)
    .describe("true = só as tarefas criadas PARA este agente (agente externo da equipe)."),
  abertas: z.boolean().optional().default(true).describe("true = só pendentes e em andamento."),
  lead_id: z.string().uuid().optional(),
  limite: z.number().int().min(1).max(100).optional().default(30),
};

export const crmListTasks: McpToolDefinition<typeof listarShape> = {
  name: "crm_list_tasks",
  description:
    "Lista as tarefas da equipe em ordem de prazo: título, prazo, prioridade, situação, negócio e contato vinculados, " +
    "para quem é (pessoa ou agente). Use para_mim=true para ver o que pediram a você.",
  inputSchema: listarShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    if (input.para_mim && !ctx.agenteExterno) {
      return { tarefas: [], aviso: "Este token não é de um agente da equipe: não há tarefas 'para mim'." };
    }
    let q = ctx.supabase
      .from("crm_tasks")
      .select(COLUNAS_DA_TAREFA)
      .eq("organization_id", ctx.organizationId)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(input.limite);
    if (input.para_mim && ctx.agenteExterno) q = q.eq("agente_externo_id", ctx.agenteExterno.id);
    if (input.abertas) q = q.in("status", ["pending", "in_progress"]);
    if (input.lead_id) q = q.eq("lead_id", input.lead_id);
    const { data, error } = await q;
    if (error) throw new Error(`listar_tarefas_falhou: ${error.message}`);
    return { tarefas: data ?? [] };
  },
};

// ---------------------------------------------------------------------------
// criar
// ---------------------------------------------------------------------------

const criarShape = {
  titulo: z.string().trim().min(1).max(255),
  descricao: z.string().max(5000).optional(),
  prazo: z.string().datetime({ offset: true }).optional().describe("ISO-8601 com fuso. Sem prazo: omita."),
  prioridade: z.enum(PRIORIDADES_DA_TAREFA).optional().default("medium"),
  lead_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  para_pessoa_id: z.string().uuid().optional().describe("Pessoa da equipe responsável (veja crm_list_team_members)."),
  para_agente_id: z.string().uuid().optional().describe("Agente externo da equipe responsável."),
};

export const crmCreateTask: McpToolDefinition<typeof criarShape> = {
  name: "crm_create_task",
  description:
    "Cria uma tarefa para a equipe — por exemplo, para uma pessoa fechar uma venda que você conduziu até o fim. Vincule " +
    "o negócio (lead_id) e o contato, diga o que falta e o prazo. Tarefa para um agente avisa quem assina o evento " +
    "tarefa.criada_para_agente.",
  inputSchema: criarShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const r = await criarTarefa(ctx.supabase, {
      orgId: ctx.organizationId,
      dados: {
        title: input.titulo,
        description: input.descricao ?? null,
        due_date: input.prazo ?? null,
        priority: input.prioridade,
        lead_id: input.lead_id ?? null,
        contact_id: input.contact_id ?? null,
        assigned_to: input.para_pessoa_id ?? null,
        agente_externo_id: input.para_agente_id ?? null,
      },
      actorUserId: null,
      actorApiTokenId: ctx.apiTokenId,
      requestId: ctx.requestId,
    });
    if (!r.ok) {
      const mensagem =
        r.motivo === "vinculo_inexistente"
          ? "O negócio, o contato ou a pessoa vinculada não existe nesta organização."
          : r.motivo === "agente_inexistente"
            ? "O agente escolhido não existe nesta organização ou foi revogado."
            : "Não foi possível salvar a tarefa.";
      return { criada: false, motivo: r.motivo, mensagem };
    }
    return { criada: true, tarefa: r.tarefa };
  },
};

// ---------------------------------------------------------------------------
// mudar a situação
// ---------------------------------------------------------------------------

const situacaoShape = {
  tarefa_id: z.string().uuid(),
  situacao: z.enum(SITUACOES_DA_TAREFA),
};

export const crmUpdateTaskStatus: McpToolDefinition<typeof situacaoShape> = {
  name: "crm_update_task_status",
  description: "Muda a situação de uma tarefa: pending, in_progress, done ou cancelled.",
  inputSchema: situacaoShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data: antes, error: erroLeitura } = await ctx.supabase
      .from("crm_tasks")
      .select("id, status")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.tarefa_id)
      .maybeSingle();
    if (erroLeitura) throw new Error(`ler_tarefa_falhou: ${erroLeitura.message}`);
    if (!antes) return { atualizada: false, motivo: "not_found", mensagem: "Tarefa não encontrada." };
    if ((antes as { status: string }).status === input.situacao) return { atualizada: false, ja_estava: true };

    const { error } = await ctx.supabase
      .from("crm_tasks")
      .update({ status: input.situacao })
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.tarefa_id);
    if (error) throw new Error(`mudar_tarefa_falhou: ${error.message}`);
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: null,
      actorApiTokenId: ctx.apiTokenId,
      action: "crm_task.updated",
      resourceType: "crm_tasks",
      resourceId: input.tarefa_id,
      requestId: ctx.requestId,
      metadata: {
        antes: { status: (antes as { status: string }).status },
        depois: { status: input.situacao },
        ...(ctx.agenteExterno ? { autor: { tipo: "agente_externo", id: ctx.agenteExterno.id, nome: ctx.agenteExterno.nome } } : {}),
      },
    });
    return { atualizada: true, tarefa_id: input.tarefa_id, situacao: input.situacao };
  },
};
