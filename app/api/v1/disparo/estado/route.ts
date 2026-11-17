/**
 * GET /api/v1/disparo/estado — o cartão de estado do motor de disparo da
 * organização ativa: modo (gravado e efetivo), as duas chaves da trava, janela
 * e ritmo vigentes, teto diário, próximo envio e as contagens da fila.
 *
 * SÓ LEITURA. Quem decide o modo é o operador, fora da tela (`lib/disparo/trava.ts`).
 * A segunda chave (`DISPARO_REAL_LIBERADO`) sai daqui como booleano, nunca como valor.
 *
 * A organização vem da sessão (`requireRole`), nunca do corpo ou da query. A RLS das
 * `disparo_*` já limita aos membros da org; o `.eq("organization_id")` é a segunda trava.
 *
 * O corpo mora em `lerEstadoDoMotor` (`lib/disparo-painel/operacoes.ts`): a ferramenta MCP
 * dos agentes externos lê o MESMO estado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerEstadoDoMotor } from "@/lib/disparo-painel/operacoes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_config" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;

  const r = await lerEstadoDoMotor(await createClient(), org.orgId, { idioma: user.idioma, ambiente: process.env });
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId });
  return ok(r.dados, { requestId });
}
