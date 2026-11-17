/**
 * /api/v1/disparo/chips/[id] — um chip do motor (manager+).
 *
 * DELETE tira o chip do motor. Não apaga nada: o chip vira `estado = 'desligado'` (o motor não o usa mais,
 * `lib/disparo/fila.ts:chipNaVolta`) e a linha fica, porque `disparo_envios` aponta para ela e o histórico de quem
 * mandou o quê não pode sumir. A conexão (`channel_sessions`) não é tocada: ela continua servindo à Inbox. Os envios
 * PENDENTES do chip são cancelados com o motivo escrito; o que já saiu, ou está saindo agora (`enviando`), fica como
 * está. Registrar de novo a mesma conexão (`POST /api/v1/disparo/chips`) reativa esta linha no dia 1 da rampa, com a
 * saúde que ela tinha (retirar e registrar de novo não solta o freio de saúde). Excluir a conexão do chip também o
 * tira do motor, pela mesma função.
 *
 * PATCH `{ acao: "pausar" | "retomar" }` segura o chip sem tirá-lo do motor:
 *   - pausar: `estado = 'pausado'`. A fila dele fica como está (o motor não manda por chip pausado, `chipNaVolta`).
 *   - retomar: `estado = 'ativo'` a partir do dia maduro da organização, `'rampa'` antes. NUNCA mexe em `saude` nem em
 *     `pausado_ate`: um chip vermelho continua parado até a saúde soltá-lo, e a resposta diz até quando.
 *   Chip retirado (`desligado`) é 409: quem o traz de volta é o `POST /api/v1/disparo/chips`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { mudarChipDoMotor, retirarChipDoMotor } from "@/lib/disparo-painel/operacoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_chips" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });

  // O corpo mora em `retirarChipDoMotor` (lib/disparo-painel/operacoes.ts): excluir a conexão de um chip do motor
  // (`DELETE /api/v1/channel-sessions/[id]`) o tira pelo MESMO caminho, com a mesma auditoria.
  const r = await retirarChipDoMotor(
    { leitura: await createClient(), escrita: createAdminClient() },
    { orgId: org.orgId, chipId: id, autor: { actorUserId: user.id }, requestId, idioma: user.idioma },
  );
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId });
  return ok(r.dados, { requestId });
}

const acaoSchema = z.object({ acao: z.enum(["pausar", "retomar"]) }).strict();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_chips" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const { id } = await params;
  const parsed = acaoSchema.safeParse(await req.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });

  // O corpo mora em `mudarChipDoMotor` (lib/disparo-painel/operacoes.ts): o MCP dos agentes externos pausa e retoma
  // pelo MESMO caminho, com a mesma auditoria.
  const r = await mudarChipDoMotor(
    { leitura: await createClient(), escrita: createAdminClient() },
    { orgId: org.orgId, chipId: id, acao: parsed.data.acao, autor: { actorUserId: user.id }, requestId, idioma: user.idioma },
  );
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId });
  return ok(r.dados, { requestId });
}
