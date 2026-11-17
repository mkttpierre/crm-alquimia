/**
 * `crm_list_waiting_conversations` — quem está esperando resposta.
 *
 * A mesma régua do evento `conversa.esperando` e da tela Início (`lib/agentes-externos/esperando.ts`): conversa
 * aberta, nunca grupo, a última mensagem do cliente mais nova que a nossa, há pelo menos N minutos (padrão: o N da
 * organização, 15 se ninguém mudou). Só lê.
 */
import { z } from "zod";

import { listarConversasEsperando, minutosDeEspera } from "@/lib/agentes-externos/esperando";

import type { McpToolDefinition } from "../types";

const shape = {
  minutos: z.number().int().min(0).max(1440).optional().describe("Esperando há pelo menos N minutos. Padrão: o da organização."),
  limite: z.number().int().min(1).max(200).optional().default(50),
};

export const crmListWaitingConversations: McpToolDefinition<typeof shape> = {
  name: "crm_list_waiting_conversations",
  description:
    "Lista as conversas em que o cliente escreveu por último e ninguém respondeu há pelo menos N minutos (padrão da " +
    "organização, 15), das que esperam há mais tempo para as mais novas, olhando as últimas 24 h. Grupos nunca entram.",
  inputSchema: shape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let minutos = input.minutos;
    if (minutos === undefined) {
      const { data: org } = await ctx.supabase.from("organizations").select("settings").eq("id", ctx.organizationId).maybeSingle();
      minutos = minutosDeEspera((org as { settings?: unknown } | null)?.settings);
    }
    const r = await listarConversasEsperando(ctx.supabase, ctx.organizationId, { minutos, limite: input.limite });
    if (!r.ok) throw new Error(`listar_esperando_falhou: ${r.erro}`);
    return { minutos, conversations: r.conversas };
  },
};
