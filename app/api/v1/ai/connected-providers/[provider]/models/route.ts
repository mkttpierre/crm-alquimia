/**
 * GET /api/v1/ai/connected-providers/:provider/models?purpose=&credential_id=
 *
 * Os modelos AO VIVO do provedor: por chave testada, a lista que o provedor
 * devolveu no último teste, só modelos de conversa, com a capacidade de
 * ferramentas (do provedor, senão do catálogo). Com `purpose` de um ponto que
 * exige ferramentas, some quem comprovadamente não as tem. Para atualizar a
 * lista: `POST /api/v1/ai/credentials/:id/revalidate`.
 *
 * Papel admin, sessão ou bearer `mcp:read`. A chave nunca volta.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizarGestaoDeIa } from "@/lib/ai/provedores/autorizar";
import { modelosAoVivo } from "@/lib/ai/provedores/operacoes";

export const dynamic = "force-dynamic";

const consulta = z.object({
  purpose: z.string().min(1).max(100).optional(),
  credential_id: z.string().uuid().optional(),
});

export async function GET(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarGestaoDeIa(req, { escrita: false, requestId });
  if (!authz.ok) return authz.response;

  const { provider } = await ctx.params;
  const url = new URL(req.url);
  const parsed = consulta.safeParse({
    purpose: url.searchParams.get("purpose") ?? undefined,
    credential_id: url.searchParams.get("credential_id") ?? undefined,
  });
  if (!parsed.success) {
    return fail("invalid_query", "parâmetros inválidos", 422, {
      details: { issues: parsed.error.issues },
      requestId,
    });
  }

  const r = await modelosAoVivo(authz.db, authz.orgId, {
    provider,
    purpose: parsed.data.purpose ?? null,
    credentialId: parsed.data.credential_id ?? null,
  });
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId });
  return ok(
    { provider, exige_ferramentas: r.exigeFerramentas, credenciais: r.credenciais },
    { requestId },
  );
}
