/**
 * MCP server endpoint (Spec 11 §2 + §5.4).
 *
 * Streamable HTTP transport via `WebStandardStreamableHTTPServerTransport`
 * (Next.js App Router recebe Web `Request`). Stateless: cada request abre
 * um transport+server fresh. Auth via Bearer (`api_tokens`).
 *
 * NUNCA logamos plaintext do bearer. Em erro retornamos JSON-RPC 2.0
 * envelope com `error.code` MCP (-32001/-32002/etc).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { registrarPresenca } from "@/lib/agentes-externos/presenca";
import { createMcpServer } from "@/lib/mcp/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function jsonRpcError(code: number, message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

/** O `method` do JSON-RPC (o primeiro, num lote), lido de uma CÓPIA do corpo — o original segue para o transporte. */
async function metodoDaChamada(req: NextRequest): Promise<string | null> {
  try {
    const corpo = (await req.clone().json()) as unknown;
    const primeiro = Array.isArray(corpo) ? corpo[0] : corpo;
    const metodo = (primeiro as { method?: unknown } | null)?.method;
    return typeof metodo === "string" ? metodo : null;
  } catch {
    return null;
  }
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  let auth;
  try {
    auth = await validateBearerToken(req.headers.get("authorization"));
  } catch (err) {
    if (err instanceof McpAuthError) {
      return jsonRpcError(err.mcpCode, err.message, err.httpStatus);
    }
    const msg = err instanceof Error ? err.message : "auth_failed";
    return jsonRpcError(-32603, msg, 500);
  }

  // Presença do agente externo também no `initialize` e no `tools/list`: conectar e olhar as ferramentas é
  // uso. A chamada de ferramenta grava a sua dentro do servidor (`lib/mcp/server.ts`), com o nome dela.
  if (auth.agenteExterno && req.method === "POST") {
    const metodo = await metodoDaChamada(req);
    if (metodo === "initialize" || metodo === "tools/list") {
      void registrarPresenca(createAdminClient(), auth.apiTokenId, metodo);
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({});
  const server = createMcpServer(auth, requestId);

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req as unknown as Request);
    response.headers.set("X-Request-Id", requestId);
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "transport_error";
    return jsonRpcError(-32603, msg, 500);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handle(req);
}
