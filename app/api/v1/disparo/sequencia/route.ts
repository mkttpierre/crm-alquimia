/**
 * POST   /api/v1/disparo/sequencia — atalho `/funil-valores` da tela de conversas: agenda a sequência de mensagens
 *        (hoje, as 7 do funil de valores) para a lead da conversa, em ordem e com pausa entre elas. Responde na hora
 *        com o resumo ("7 mensagens em ~1 min 24 s"); quem as leva ao canal é o motor de disparo (`lib/disparo/motor.ts`),
 *        pelo chip da conversa, na cadência pedida pelo operador: 3 s depois de texto/imagem, 29-34 s depois de áudio.
 *        Lógica em `lib/disparo/atendimento/sequencia-operador.ts`.
 * DELETE /api/v1/disparo/sequencia?conversation_id=… — cancela as partes que ainda não saíram.
 *
 * Auth: agent+ (quem pode responder na conversa). A organização vem da sessão, nunca do corpo; a conversa precisa
 * ser visível ao usuário (RLS) e o lead, o chip e os modelos são buscados com `organization_id` explícito (service
 * role). Chip parado, contato bloqueado, modelo faltando ou texto barrado recusam o pedido INTEIRO e dizem por quê.
 * A trava do envio real vale como em todo o motor: com ela fechada as linhas nascem `simulado` e a resposta diz `ensaio`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { agendarSequencia, cancelarSequencia, ErroDaSequencia } from "@/lib/disparo/atendimento/sequencia-operador";
import { repositorioSequenciaSupabase } from "@/lib/disparo/atendimento/sequencia-operador-supabase";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z
  .object({
    conversation_id: z.string().uuid(),
    /** O atalho do funil, com ou sem a barra: "funil-valores". */
    atalho: z.string().min(1).max(60).optional(),
    /** O funil escolhido na barra de atalhos (`operator_funnels.id`). */
    funnel_id: z.string().uuid().optional(),
    /** Uma mensagem avulsa da barra (`message_templates.id`): vira um funil de um passo. */
    template_id: z.string().uuid().optional(),
    /** Reenvio consciente: o mesmo funil já saiu para o lead nas últimas 24 h e o operador confirmou mandar de novo. */
    confirmar: z.boolean().optional(),
  })
  .refine((c) => [c.atalho, c.funnel_id, c.template_id].filter(Boolean).length === 1, {
    message: "Informe exatamente um: atalho, funnel_id ou template_id.",
  });

/** A conversa existe e o usuário a enxerga (RLS da sessão). */
async function conversaVisivel(conversationId: string, orgId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.from("conversations").select("id").eq("organization_id", orgId).eq("id", conversationId).maybeSingle();
  return Boolean(data);
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "disparo_sequencia" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let input;
  try {
    input = await validateRequest(corpoSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { details: err.details as Record<string, unknown> | undefined, requestId });
    }
    throw err;
  }

  if (!(await conversaVisivel(input.conversation_id, org.orgId))) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const repo = repositorioSequenciaSupabase(createAdminClient());
  // `Idempotency-Key` (o apiClient manda em todo POST): o mesmo pedido repetido (retry, duplo clique) devolve o
  // resultado do primeiro, sem agendar de novo. O primeiro fica no audit log com a chave e a resposta.
  const chave = req.headers.get("idempotency-key")?.trim().slice(0, 200) || null;
  if (chave && repo.repeticaoDoPedido) {
    const anterior = await repo.repeticaoDoPedido(org.orgId, input.conversation_id, chave);
    if (anterior) return ok(anterior, { status: 200, requestId });
  }

  try {
    const r = await agendarSequencia(
      {
        repo,
        agora: new Date(),
        ambiente: { DISPARO_REAL_LIBERADO: env.DISPARO_REAL_LIBERADO, DISPARO_SO_PARA: env.DISPARO_SO_PARA },
        sortear: Math.random,
      },
      org.orgId,
      {
        conversationId: input.conversation_id,
        usuarioId: user.id,
        ...(input.funnel_id ? { funnelId: input.funnel_id } : input.template_id ? { templateId: input.template_id } : { atalho: input.atalho! }),
        confirmar: input.confirmar === true,
      },
    );
    const resposta = {
      titulo: r.titulo,
      partes: r.partes,
      modo: r.modo,
      motivo_simulado: r.motivoSimulado,
      chip: r.chip,
      primeira_em: r.primeiraEm.toISOString(),
      ultima_em: r.ultimaEm.toISOString(),
      duracao_seg: r.duracaoSeg,
    };
    await audit({
      organizationId: org.orgId,
      actorUserId: user.id,
      action: "disparo.sequencia_agendada",
      resourceType: "conversation",
      resourceId: input.conversation_id,
      requestId,
      metadata: {
        atalho: input.atalho ?? null,
        funnel_id: input.funnel_id ?? null,
        template_id: input.template_id ?? null,
        partes: r.partes,
        modo: r.modo,
        chip: r.chip,
        duracao_seg: r.duracaoSeg,
        confirmar: input.confirmar === true,
        conversa: input.conversation_id,
        idempotency_key: chave,
        resposta,
      },
    });
    return ok(resposta, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ErroDaSequencia) {
      return fail(`sequencia_${err.codigo}`, err.message, err.status, { details: err.detalhes, requestId });
    }
    throw err;
  }
}

/** Funil do operador com parte nascida nas últimas 2 h conta como "o funil desta conversa". */
const JANELA_DO_ANDAMENTO_MS = 2 * 60 * 60 * 1000;

/** GET ?conversation_id=… — o funil em andamento na conversa (a faixa acima da caixa: "2 de 7 · próxima às 14:32"). */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "disparo_sequencia" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const parametro = z.string().uuid().safeParse(req.nextUrl.searchParams.get("conversation_id"));
  if (!parametro.success) return fail("validation_failed", "conversation_id inválido.", 422, { requestId });
  if (!(await conversaVisivel(parametro.data, org.orgId))) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }
  const repo = repositorioSequenciaSupabase(createAdminClient());
  const vazio = { em_andamento: false, tipo: null, enviadas: 0, total: 0, proxima_em: null };
  const leadId = await repo.leadDaConversa(org.orgId, parametro.data);
  if (!leadId || !repo.andamento) return ok(vazio, { requestId });
  const a = await repo.andamento(org.orgId, leadId, new Date(Date.now() - JANELA_DO_ANDAMENTO_MS));
  return ok(
    { em_andamento: a.pendentes > 0, tipo: a.prefixo, enviadas: a.enviadas, total: a.total, proxima_em: a.proximaEm?.toISOString() ?? null },
    { requestId },
  );
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "disparo_sequencia" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parametro = z.string().uuid().safeParse(req.nextUrl.searchParams.get("conversation_id"));
  if (!parametro.success) return fail("validation_failed", "conversation_id inválido.", 422, { requestId });
  if (!(await conversaVisivel(parametro.data, org.orgId))) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  try {
    const r = await cancelarSequencia({ repo: repositorioSequenciaSupabase(createAdminClient()) }, org.orgId, { conversationId: parametro.data });
    const conversaId = parametro.data;
    if (r.canceladas > 0) {
      await audit({
        organizationId: org.orgId,
        actorUserId: user.id,
        action: "disparo.sequencia_cancelada",
        resourceType: "conversation",
        resourceId: conversaId,
        requestId,
        metadata: { canceladas: r.canceladas },
      });
    }
    return ok({ canceladas: r.canceladas }, { requestId });
  } catch (err) {
    if (err instanceof ErroDaSequencia) {
      return fail(`sequencia_${err.codigo}`, err.message, err.status, { details: err.detalhes, requestId });
    }
    throw err;
  }
}
