/**
 * Core do MCP server (Spec 11 §5.3).
 *
 * `createMcpServer(authResult, requestId)` retorna instancia `McpServer` com
 * todas as tools desta wave registradas. Cada tool e exposta com:
 *   - Zod raw shape como inputSchema (registerTool aceita ZodRawShape).
 *   - Handler async que (a) checa role + scope, (b) chama o handler da
 *     wave 2, (c) audita em api_audit_log, (d) retorna content[] padrao
 *     MCP. Erros viram `{ isError: true, content: [...] }` (e o codigo
 *     MCP fica no metadata, nao no JSON-RPC error envelope).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { auditMcpToolCall } from "./audit";
import { GUIA_DO_AGENTE_EXTERNO, URI_DO_GUIA } from "@/lib/agentes-externos/guia";
import { registrarPresenca } from "@/lib/agentes-externos/presenca";
import { ensureRole, ensureScope, type McpAuthResult } from "./auth";
import { FERRAMENTAS_DE_PRECO, recusaDeFechamento, semPrecos } from "./fechamento-humano";
import { semComissao } from "./sem-comissao";
import { allTools } from "./tools";
import { higienizarUuidsDeAterro } from "./uuid-de-aterro";
import type { McpContext } from "./types";

const SERVER_NAME = "crm-alquimia";

/** Recusa das ferramentas do motor para um agente externo com `pode_motor = false`. */
/** O que acompanha o catálogo e as compras sem preço, para o agente não inventar um. */
export const AVISO_DE_PRECO = "Preços e valores ficam com a equipe: para fechar, crie uma tarefa para uma pessoa.";

export const MENSAGEM_SEM_MOTOR =
  "Este agente não tem acesso ao motor de disparo. Um administrador libera em Equipe › Agentes externos.";
const SERVER_VERSION = "0.1.0";

function summarizeResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.contacts)) return `${r.contacts.length} contacts`;
  if (Array.isArray(r.conversations)) return `${r.conversations.length} conversations`;
  if (Array.isArray(r.messages)) return `${r.messages.length} messages`;
  if (typeof r.id === "string") return `id=${r.id}`;
  return undefined;
}

export function createMcpServer(auth: McpAuthResult, requestId: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const supabase = createAdminClient();

  // O guia que o agente externo lê antes de trabalhar: o que pode, as ferramentas por área e as regras.
  server.registerResource(
    "guia-do-agente-externo",
    URI_DO_GUIA,
    {
      title: "Como operar o CRM",
      description: "O que um agente externo pode fazer, as ferramentas por área, as regras e exemplos de pedidos.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIA_DO_AGENTE_EXTERNO }] }),
  );

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (rawArgs) => {
        const startedAt = Date.now();
        // A MESMA higiene do outro ingresso (`lib/ai/runtime/tools.ts`), pela
        // mesma razão: um uuid de aterro em campo opcional vira filtro por um
        // id que não existe, e o resultado vazio é lido como "não há". Aqui é o
        // caminho do MCP externo; lá é o do agente. Os dois entram no mesmo
        // handler, então os dois higienizam — deixar um de fora seria fechar a
        // porta e esquecer a janela. Ver `lib/mcp/uuid-de-aterro.ts`.
        const higiene = higienizarUuidsDeAterro(
          tool.inputSchema as Record<string, z.ZodTypeAny>,
          (rawArgs ?? {}) as Record<string, unknown>,
        );
        const args = higiene.limpos;
        const ctx: McpContext = {
          organizationId: auth.organizationId,
          role: auth.role,
          actor: auth.actor,
          apiTokenId: auth.apiTokenId,
          requestId,
          supabase,
          agenteExterno: auth.agenteExterno ?? null,
        };

        // Presença do agente externo: a ferramenta chamada, no máximo 1 escrita a cada 30 s. Não espera.
        if (auth.agenteExterno) void registrarPresenca(supabase, auth.apiTokenId, tool.name);

        try {
          ensureScope(auth.scopes, tool.requiresScope);
          ensureRole(auth.role, tool.requiresRole);

          // Agente de IA externo PARA antes de fechar a venda: sem preço, sem link de pagamento, sem registro de venda
          // (lib/mcp/fechamento-humano.ts). A recusa vira erro e fica no histórico pela auditoria abaixo.
          if (auth.actor.type === "ai_agent") {
            const recusa = await recusaDeFechamento(tool.name, args, { supabase, organizationId: auth.organizationId });
            if (recusa) throw new Error(recusa);
          }
          // A chave do motor é por agente: o papel pode ser admin e o motor continuar fora do alcance dele. Token de IA
          // SEM cadastro na equipe (external_agents) não tem a chave: o motor só vai a agente que alguém liberou.
          if (tool.motor && auth.actor.type === "ai_agent" && !auth.agenteExterno?.pode_motor) {
            throw new Error(MENSAGEM_SEM_MOTOR);
          }

          // A comissão do operador não sai por ferramenta nenhuma (ver sem-comissao.ts).
          let result = semComissao(await tool.handler(args as never, ctx));
          // Catálogo e compras chegam ao agente de IA externo SEM preço nem valor: ele sabe o que existe, e o preço é
          // de uma pessoa da equipe (lib/mcp/fechamento-humano.ts).
          if (auth.actor.type === "ai_agent" && FERRAMENTAS_DE_PRECO.has(tool.name)) {
            result = { ...(semPrecos(result) as Record<string, unknown>), aviso_de_preco: AVISO_DE_PRECO };
          }
          const durationMs = Date.now() - startedAt;

          await auditMcpToolCall({
            ctx,
            toolName: tool.name,
            args,
            durationMs,
            success: true,
            resultSummary: summarizeResult(result),
          });

          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown_error";
          const durationMs = Date.now() - startedAt;

          await auditMcpToolCall({
            ctx,
            toolName: tool.name,
            args,
            durationMs,
            success: false,
            errorMessage: message,
          });

          return {
            isError: true,
            content: [{ type: "text", text: message }],
          };
        }
      },
    );
  }

  return server;
}
