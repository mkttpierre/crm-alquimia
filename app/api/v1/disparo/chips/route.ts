/**
 * /api/v1/disparo/chips — os chips do motor da organização ativa.
 *
 *   GET  (manager+) estado, saúde, dia da rampa, última e próxima vez, quanto já saiu hoje e o teto de hoje, e a
 *        saúde calculada de hoje (o painel diário: aberturas, respostas, bloqueio provável, não quero, irritação e os
 *        motivos). Quatro consultas fixas (config, chips, envios saídos, saúde do dia), qualquer que seja o número
 *        de chips.
 *   POST (manager+) `{ channel_session_id }`: usa uma conexão da organização no motor, no dia 1 da rampa e com saúde
 *        verde. O nome do chip é o apelido da conexão (ou o telefone), com sufixo se já houver um igual. A mesma
 *        conexão de um chip retirado reativa a MESMA linha (o histórico de `disparo_envios` continua apontando para
 *        ela) no dia 1, com a saúde que ela tinha (vermelho continua vermelho); a de um chip ainda no motor devolve
 *        200 sem mudar nada.
 *
 * Tirar o chip do motor é `DELETE /api/v1/disparo/chips/[id]`. A escrita usa o admin client (a migration 0234 não dá
 * INSERT/UPDATE a `authenticated`) e o `organization_id` vem da sessão, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerChipsDoMotor } from "@/lib/disparo-painel/operacoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** O corpo mora em `lerChipsDoMotor` (lib/disparo-painel/operacoes.ts): o MCP dos agentes externos lê os MESMOS chips. */
export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_chips" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const r = await lerChipsDoMotor(await createClient(), org.orgId, { idioma: user.idioma });
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId });
  return ok(r.dados, { requestId });
}

const registroSchema = z.object({ channel_session_id: z.uuid() }).strict();

/** O estado de um chip NOVO no motor: dia 1 da rampa, verde, sem pausa nem vez marcada. */
const DIA_1 = {
  estado: "rampa",
  saude: "verde",
  dia_rampa: 1,
  pausado_ate: null,
  proximo_envio_em: null,
  envios_desde_pausa: 0,
  saude_motivo: null,
  saude_calculada_em: null,
} as const;

/**
 * O que muda num chip RETIRADO que volta ao motor: só o estado e o dia da rampa. NUNCA `saude`, `saude_motivo` nem
 * `pausado_ate`: retirar e registrar de novo não pode ser o atalho que solta o freio de saúde. Um chip vermelho volta
 * vermelho, e o motor o segura até a saúde soltá-lo (`lib/disparo/saude-job.ts`).
 */
const REATIVACAO = { estado: "rampa", dia_rampa: 1 } as const;

/** Nome livre na organização (`disparo_chips` é único por `(organization_id, nome)`): "Comercial", "Comercial (2)"... */
function nomeLivre(base: string, usados: Set<string>): string {
  if (!usados.has(base)) return base;
  for (let n = 2; ; n++) if (!usados.has(`${base} (${n})`)) return `${base} (${n})`;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_chips" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const parsed = registroSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten() as unknown as Record<string, unknown>,
    });
  }
  const conexaoId = parsed.data.channel_session_id;

  const supabase = await createClient();
  const [{ data: conexao, error: erroConexao }, { data: chips, error: erroChips }] = await Promise.all([
    supabase
      .from("channel_sessions")
      .select("id, display_name, phone_number, archived_at")
      .eq("id", conexaoId)
      .eq("organization_id", org.orgId)
      .maybeSingle(),
    supabase.from("disparo_chips").select("id, nome, estado, channel_session_id").eq("organization_id", org.orgId),
  ]);
  if (erroConexao || erroChips) return fail("internal_error", t("Não foi possível registrar o chip."), 500, { requestId });
  if (!conexao) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });
  if (conexao.archived_at) return fail("channel_archived", t("Esta conexão está arquivada."), 422, { requestId });

  const daConexao = (chips ?? []).filter((c) => c.channel_session_id === conexaoId);
  const noMotor = daConexao.find((c) => c.estado !== "desligado");
  if (noMotor) return ok({ chip_id: noMotor.id, nome: noMotor.nome, criado: false, reativado: false }, { requestId });

  const admin = createAdminClient();
  const retirado = daConexao[0];
  if (retirado) {
    const { error } = await admin.from("disparo_chips").update(REATIVACAO).eq("id", retirado.id).eq("organization_id", org.orgId);
    if (error) return fail("internal_error", t("Não foi possível registrar o chip."), 500, { requestId });
    await audit({
      organizationId: org.orgId,
      actorUserId: user.id,
      action: "disparo.config_atualizada",
      resourceType: "disparo_chips",
      resourceId: retirado.id,
      requestId,
      metadata: { operacao: "reativar_chip", channel_session_id: conexaoId, antes: { estado: retirado.estado }, depois: REATIVACAO },
    });
    return ok({ chip_id: retirado.id, nome: retirado.nome, criado: false, reativado: true }, { requestId });
  }

  // Nome do CHIP a partir da CONEXÃO (apelido, senão o número). Não é rótulo de contato:
  // `rotuloDoContato` troca o final por "Sem nome" e barra identificador técnico, o que
  // mudaria o nome que o chip recebe hoje.
  const rotuloDaConexao = [conexao.display_name, conexao.phone_number].map((v) => v?.trim()).find(Boolean);
  const base = (rotuloDaConexao ?? t("Chip")).slice(0, 60);
  const nome = nomeLivre(base, new Set((chips ?? []).map((c) => c.nome)));
  const { data: criado, error } = await admin
    .from("disparo_chips")
    .insert({ organization_id: org.orgId, channel_session_id: conexaoId, nome, ...DIA_1 })
    .select("id")
    .single();
  if (error || !criado) {
    if ((error as { code?: string } | null)?.code === "23505") {
      return fail("state_conflict", t("Outro chip acabou de ser registrado com este nome. Tente de novo."), 409, { requestId });
    }
    return fail("internal_error", t("Não foi possível registrar o chip."), 500, { requestId });
  }

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "disparo.config_atualizada",
    resourceType: "disparo_chips",
    resourceId: criado.id,
    requestId,
    metadata: { operacao: "registrar_chip", channel_session_id: conexaoId, antes: null, depois: { nome, estado: DIA_1.estado, dia_rampa: 1 } },
  });
  return ok({ chip_id: criado.id, nome, criado: true, reativado: false }, { requestId, status: 201 });
}
