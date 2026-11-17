/**
 * Quem pode mexer nos provedores de IA pela API para agentes — sessão OU bearer.
 *
 * As rotas `app/api/v1/ai/connected-providers*` e `.../purpose-bindings` são
 * para AGENTES (Claude Code, Codex, um script de quem opera) além da tela. Elas
 * aceitam as duas credenciais do contrato da API (CLAUDE.md, "Auth dual"):
 *
 *  - **Bearer** (`Authorization: Bearer dsk_…`, o mesmo token do MCP, hash
 *    SHA-256 em `api_tokens`): papel `admin` e o escopo `mcp:read` (leitura)
 *    ou `mcp:write` (escrita). A organização é a DO TOKEN. O cliente de banco
 *    é o admin, e por isso as operações filtram `organization_id` sempre.
 *  - **Sessão** (cookie): `requireRole("admin")`, organização ativa do cookie,
 *    cliente de sessão com RLS.
 *
 * Bearer só no cabeçalho — nunca em query string, nunca no corpo. Como estas
 * rotas estão em `PUBLIC_PATHS` (o proxy não exige cookie, porque o agente não
 * tem cookie), a autenticação mora AQUI e falha fechada: sem cabeçalho e sem
 * sessão válida, 401.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, type ApiError } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import {
  McpAuthError,
  ensureRole,
  ensureScope,
  extractBearer,
  validateBearerToken,
} from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type Autorizado = {
  ok: true;
  orgId: string;
  db: SupabaseClient;
  /** Exatamente um dos dois é preenchido — é o ator do audit log. */
  actorUserId: string | null;
  actorApiTokenId: string | null;
  /** Idioma de quem chamou (sessão); bearer responde no padrão do produto. */
  idioma: Idioma | null;
};

const LIMITE_POR_MINUTO = 120;

/**
 * O balde do teto por minuto: o HASH do token (um agente barulhento não
 * derruba os outros, e o token nunca vira chave do Redis em claro) ou, se o
 * cabeçalho não traz token reconhecível, o IP de quem chamou.
 */
function baldeDoTeto(req: Request, cabecalho: string): string {
  const token = extractBearer(cabecalho);
  if (token) {
    return `api_ai_provedores:tok:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  }
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "sem-ip";
  return `api_ai_provedores:ip:${ip}`;
}

export type Negado = { ok: false; response: NextResponse<ApiError> };

export async function autorizarGestaoDeIa(
  req: Request,
  opcoes: { escrita: boolean; requestId: string },
): Promise<Autorizado | Negado> {
  const cabecalho = req.headers.get("authorization");
  if (cabecalho !== null && cabecalho.trim() !== "") {
    // Rota fora do proxy de sessão: o teto por minuto vem antes de qualquer
    // consulta, para que adivinhar token custe caro (CLAUDE.md, DoD 6).
    const rl = await checkRateLimit(baldeDoTeto(req, cabecalho), LIMITE_POR_MINUTO, 60);
    if (!rl.allowed) {
      return {
        ok: false,
        response: fail("rate_limited", "Too many requests.", 429, {
          requestId: opcoes.requestId,
          headers: { "Retry-After": "60" },
        }),
      };
    }
    try {
      const auth = await validateBearerToken(cabecalho);
      ensureScope(auth.scopes, opcoes.escrita ? "mcp:write" : "mcp:read");
      ensureRole(auth.role, "admin");
      return {
        ok: true,
        orgId: auth.organizationId,
        db: createAdminClient(),
        actorUserId: null,
        actorApiTokenId: auth.apiTokenId,
        idioma: null,
      };
    } catch (err) {
      if (err instanceof McpAuthError && (err.httpStatus === 401 || err.httpStatus === 403)) {
        // A mensagem do McpAuthError 401/403 não carrega o token nem o banco
        // (só "não reconhecido", "revogado", "papel insuficiente"…).
        const codigo = err.httpStatus === 401 ? "unauthenticated" : "forbidden_role";
        return {
          ok: false,
          response: fail(codigo, err.message, err.httpStatus, { requestId: opcoes.requestId }),
        };
      }
      if (err instanceof McpAuthError) {
        // 500: a mensagem traz o erro do banco. Ela vai só para o log, com o
        // X-Request-Id que a resposta leva para correlacionar.
        logger.error("[ai.provedores] falha ao validar o token", {
          requestId: opcoes.requestId,
          detalhe: err.message,
        });
        return {
          ok: false,
          response: fail("internal_error", "Erro interno ao validar o token.", 500, {
            requestId: opcoes.requestId,
          }),
        };
      }
      throw err;
    }
  }

  const authz = await requireRole("admin", { requestId: opcoes.requestId, resource: "ai_providers" });
  if (!authz.ok) return { ok: false, response: authz.response };
  return {
    ok: true,
    orgId: authz.org.orgId,
    db: await createClient(),
    actorUserId: authz.user.id,
    actorApiTokenId: null,
    idioma: authz.user.idioma,
  };
}
