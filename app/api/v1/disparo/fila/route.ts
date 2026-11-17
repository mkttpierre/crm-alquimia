/**
 * GET /api/v1/disparo/fila — a fila do motor da organização ativa, com o lead, o passo da
 * cadência, o texto e o horário previsto. Filtro por estado e paginação por página.
 *
 * SÓ LEITURA. Em número FIXO de consultas (a página + os chips dela), sem consulta por linha:
 * o lead vem embutido na mesma consulta, e os chips numa segunda, por `in (ids)`.
 *
 * O corpo mora em `lerFilaDoMotor` (`lib/disparo-painel/operacoes.ts`): a ferramenta MCP dos
 * agentes externos lê a MESMA fila.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { consultaDaFilaSchema } from "@/lib/disparo-painel/esquemas";
import { lerFilaDoMotor } from "@/lib/disparo-painel/operacoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_envios" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const parsed = consultaDaFilaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const r = await lerFilaDoMotor(await createClient(), org.orgId, parsed.data, user.idioma);
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId });
  return ok(r.dados, { requestId });
}
