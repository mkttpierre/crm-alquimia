import type { MeetingBookingContext } from "@/lib/agenda/meet-delivery";
/**
 * Tipos compartilhados do MCP server interno (Spec 11).
 *
 * Cada tool MCP é uma `McpToolDefinition` que declara name + description +
 * inputSchema (Zod) + handler. Handlers recebem `McpContext` resolvido pelo
 * server core (org, role, actor, supabase admin client).
 */
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import type { Role } from "@/lib/auth/types";

export interface McpContext {
  /** Somente o runtime in-process fornece o job original, nunca o cliente MCP. */
  meetingBooking?: MeetingBookingContext;
  organizationId: string;
  role: Role;
  actor: Actor;
  apiTokenId: string;
  requestId: string;
  /** Service-role admin client. Tools devem filtrar `organization_id` em toda query. */
  supabase: SupabaseClient;
  /** Agente externo dono do token: vai NOMEADO na auditoria das mudanças. */
  agenteExterno?: { id: string; nome: string; pode_motor: boolean } | null;
}

export type McpToolCategory = "read" | "write" | "handoff";

export interface McpToolDefinition<TInput extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: TInput;
  category: McpToolCategory;
  /** Role mínima para invocar. Read default agent; Write default manager. */
  requiresRole: Role;
  /**
   * Scope obrigatório no `api_tokens.scopes` (ex: `mcp:read`, `mcp:write`).
   * Ausência → -32002 forbidden.
   */
  requiresScope: "mcp:read" | "mcp:write";
  /**
   * Ferramenta do motor de disparo. Para token de IA (`actor:ai_agent`) a chave é por agente
   * (`lib/mcp/server.ts`): só passa o agente cadastrado na equipe (`external_agents`) com `pode_motor = true`. Agente
   * com `pode_motor = false` E token de IA SEM cadastro são recusados (`MENSAGEM_SEM_MOTOR`), qualquer que seja o papel.
   * Token comum (de pessoa ou integração, sem `actor:ai_agent`) segue só papel e escopo: manager+ com `mcp:write` opera
   * o motor; trocar o modo continua exigindo admin.
   */
  motor?: boolean;
  handler: (
    input: z.infer<z.ZodObject<TInput>>,
    ctx: McpContext,
  ) => Promise<unknown>;
}
