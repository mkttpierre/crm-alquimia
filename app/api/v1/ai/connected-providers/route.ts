/**
 * GET /api/v1/ai/connected-providers — para agentes e para a tela.
 *
 * Cada provedor da organização: conectado (chave ativa e testada) ou o motivo
 * de não estar, se a instalação tem chave dele (só o booleano) e de quando é a
 * lista de modelos. A chave nunca volta. Papel admin, por sessão ou por
 * `Authorization: Bearer dsk_…` com escopo `mcp:read`
 * (`lib/ai/provedores/autorizar.ts`).
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { autorizarGestaoDeIa } from "@/lib/ai/provedores/autorizar";
import { provedoresConectados } from "@/lib/ai/provedores/operacoes";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarGestaoDeIa(req, { escrita: false, requestId });
  if (!authz.ok) return authz.response;

  const ambiente = lerAmbiente();
  const dados = await provedoresConectados(authz.db, authz.orgId, {
    chavesDeProvedor: ambiente.chavesDeProvedor,
    gateway: ambiente.gateway,
  });
  return ok(dados, { requestId });
}
