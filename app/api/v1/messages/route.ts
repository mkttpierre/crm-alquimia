import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages — envia mensagem outbound (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { chaveDoPedido, concluirChave, hashDoPedido, reservarChave, type AlvoDaChave } from "@/lib/api/idempotencia";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { requireRole } from "@/lib/auth/require-role";
import { atalhoDoComando } from "@/lib/inbox/sequencias";
import { sendMessageSchema, validateRequest, type SendMessageInput } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { sendMessageHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  let input;
  try {
    input = await validateRequest(sendMessageSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // `/funil-valores` e os demais funis do operador (operator_funnels, migration 0248) são comandos (POST
  // /api/v1/disparo/sequencia): o texto do comando nunca vai ao lead, nem por cliente de API que o mande como mensagem.
  const atalho = input.type === "text" && input.body ? atalhoDoComando(input.body) : null;
  if (atalho) {
    const { data: funil, error } = await supabase
      .from("operator_funnels")
      .select("id")
      .eq("organization_id", activeOrg.orgId)
      .eq("atalho", atalho)
      .limit(1)
      .maybeSingle();
    if (error) return fail("internal_error", "Não foi possível verificar o funil.", 500, { requestId });
    if (funil) {
      return fail("sequencia_comando_nao_e_mensagem", "Um funil é um comando: use o atalho na caixa de conversa da tela, não o envio de mensagem.", 422, { requestId });
    }
  }

  if (input.type === "text" && input.body && /^\s*\//.test(input.body)) {
    return fail("sequencia_comando_nao_e_mensagem", "Um funil é um comando: use o atalho na caixa de conversa da tela, não o envio de mensagem.", 422, { requestId });
  }

  // `Idempotency-Key` (o apiClient manda em todo POST, a MESMA em todas as tentativas de um clique): a segunda
  // requisição com a chave nunca chega ao canal. Caso de 06/11: o cliente estourou 10 s esperando um chip lento e
  // repetiu o POST duas vezes; sem ler a chave, a mesma frase saiu três vezes. Ver `lib/api/idempotencia.ts`.
  const chave = chaveDoPedido(req.headers);
  const alvo: AlvoDaChave | null = chave ? { organizationId: activeOrg.orgId, endpoint: `POST /api/v1/messages:${user.id}`, chave } : null;
  if (alvo) {
    let reserva;
    try {
      reserva = await reservarChave(supabase, alvo, hashDoPedido(input), requestId);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
      throw err;
    }
    if (reserva.tipo === "em_andamento") {
      return fail("envio_em_andamento", "Esta mensagem ainda está sendo enviada. Aguarde a confirmação antes de mandar de novo.", 409, { requestId });
    }
    if (reserva.tipo === "conflito") {
      return fail("idempotency_conflict", "Esta Idempotency-Key já foi usada com outro conteúdo.", 422, { requestId });
    }
    if (reserva.tipo === "repetida") {
      const corpo = reserva.corpo;
      return "data" in corpo
        ? ok(corpo.data, { status: reserva.status === 201 ? 201 : 200, requestId })
        : fail(corpo.error.code, corpo.error.message, reserva.status, { requestId });
    }
  }
  const concluir = async (status: number, corpo: Parameters<typeof concluirChave>[3]) => {
    if (alvo && !(await concluirChave(supabase, alvo, status, corpo))) {
      logger.warn("[messages.send] não guardei a resposta da Idempotency-Key; a chave fica em andamento", { requestId });
    }
  };

  try {
    const message = await sendMessageHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      input as SendMessageInput,
    );
    await concluir(201, { data: message });
    return ok(message, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      await concluir(err.status, { error: { code: err.code, message: err.message } });
      return fail(err.code, err.message, err.status, { requestId });
    }
    await concluir(500, { error: { code: "internal_error", message: "O envio terminou com erro. Confira a conversa antes de mandar de novo." } });
    throw err;
  }
}
