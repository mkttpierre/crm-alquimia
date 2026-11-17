/**
 * REGISTRAR VENDA: a camada TS em volta de `fn_registrar_venda` (migration 0251).
 *
 * O que precisa ser tudo-ou-nada (achar/criar o negócio, gravar as linhas de produto, ganhar na data informada) acontece
 * DENTRO do banco, numa função só: o cliente PostgREST não abre transação, e três chamadas em sequência deixariam uma
 * venda pela metade se a segunda falhasse. Aqui ficam só as coisas que sobram DEPOIS do commit: a linha na timeline e a
 * entrada no audit log (as mesmas do "marcar como ganho", por `registraDesfecho`) e a tradução dos erros do banco.
 *
 * NUNCA envia mensagem nem agenda envio ao lead, e não toca `disparo_config`: vender no CRM é registro, não disparo.
 * A organização vem do contexto (sessão), jamais do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { registraDesfecho } from "@/lib/leads/encerramento";

import { acrescentarTagsDeCompra } from "./tag-de-compra";
import { instanteDaVenda, itensParaRpc, type VendaCriarInput } from "./venda";

export interface VendaRegistrada {
  lead_id: string;
  contact_id: string | null;
  pipeline_id: string;
  /** `true` = a venda abriu um negócio novo (contato sem negócio aberto, ou recompra). */
  criado: boolean;
  /** `true` = a mesma `Idempotency-Key` já tinha registrado esta venda; nada foi gravado de novo. */
  ja_registrada: boolean;
  /** O total que ficou GRAVADO no negócio (`crm_leads.value_cents`, já com o que havia nele antes), na moeda `currency`. */
  total_cents: number;
  currency: string;
  closed_at: string;
  title: string;
}

interface RetornoDaFuncao {
  ja_registrada: boolean;
  criado: boolean;
  lead_id: string;
  contact_id: string | null;
  pipeline_id: string;
  from_stage_id: string | null;
  to_stage_id: string;
  total_cents: number;
  currency: string;
  closed_at: string;
  title: string;
}

const MOTIVOS_404 = new Set(["contato_nao_encontrado", "negocio_nao_encontrado"]);
/** O alvo mostrado no quadro deixou de ser o real: 409, o quadro recarrega a prévia e o operador confirma de novo. */
const MOTIVOS_409 = new Set(["alvo_mudou"]);

const MENSAGENS: Record<string, string> = {
  data_futura: "A data da venda não pode ser futura.",
  data_invalida: "Data da venda inválida.",
  contato_nao_encontrado: "Contato não encontrado.",
  negocio_nao_encontrado: "Negócio não encontrado.",
  negocio_de_outro_contato: "Este negócio é de outro contato.",
  contato_anonimizado: "Contato anonimizado (LGPD): não dá para registrar venda nele.",
  produto_nao_encontrado: "Algum produto escolhido não existe mais no cadastro.",
  moeda_divergente: "Algum produto está em outra moeda que a do negócio.",
  pipeline_no_won_stage: "O funil deste negócio não tem etapa de ganho.",
  sem_funil: "A organização não tem funil para abrir o negócio da venda.",
  sem_etapa: "O funil padrão não tem etapa inicial para abrir o negócio da venda.",
  sem_contato_para_novo_negocio: "Este negócio já foi encerrado e não tem contato para abrir um novo.",
  item_sem_preco: "Informe o valor de cada produto.",
  item_sem_nome: "Dê um nome ao item avulso.",
  itens_invalidos: "Adicione de 1 a 50 produtos.",
  entrada_invalida: "Informe o contato da venda.",
  chave_invalida: "Chave de idempotência inválida.",
  alvo_mudou: "O negócio desta venda mudou enquanto você preenchia (talvez outra pessoa o tenha encerrado). Revise o que já está nele e confirme de novo.",
};

function erroDaFuncao(err: { message: string; code?: string }, ctx: HandlerCtx): ApiError {
  const idioma = ctx.idioma ?? "pt-BR";
  const achado = /^venda:([a-z_]+)/.exec(err.message);
  if (achado) {
    const motivo = achado[1]!;
    const texto = traduzir(MENSAGENS[motivo] ?? "Não foi possível registrar a venda.", idioma);
    if (MOTIVOS_409.has(motivo)) return new ApiError(409, "state_conflict", { motivo }, ctx.requestId, texto);
    return MOTIVOS_404.has(motivo)
      ? new ApiError(404, "not_found", { motivo }, ctx.requestId, texto)
      : new ApiError(422, "validation_failed", { motivo }, ctx.requestId, texto);
  }
  // Papel de leitura ou negócio de outra organização: a RLS negou. Sem repassar o texto do banco (nome de tabela/policy).
  if (err.code === "42501" || /row-level security|permission denied/i.test(err.message)) {
    return new ApiError(403, "forbidden", undefined, ctx.requestId, traduzir("Você não tem permissão para registrar vendas.", idioma));
  }
  return new ApiError(500, "internal_error", undefined, ctx.requestId, traduzir("Erro ao registrar a venda.", idioma));
}

export async function registrarVenda(
  supabase: SupabaseClient,
  ctx: HandlerCtx,
  input: VendaCriarInput,
  chave: string | null,
  opts: { agora?: Date } = {},
): Promise<VendaRegistrada> {
  const idioma = ctx.idioma ?? "pt-BR";
  const agora = opts.agora ?? new Date();

  // O "hoje" da venda é o do fuso da organização, não o do servidor.
  const { data: org, error: orgErr } = await supabase.from("organizations").select("timezone").eq("id", ctx.organization_id).maybeSingle();
  if (orgErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, traduzir("Erro ao registrar a venda.", idioma));
  const timezone = (org as { timezone?: string | null } | null)?.timezone ?? "America/Sao_Paulo";

  const quando = instanteDaVenda(input.data_venda, timezone, agora);
  if (!quando.ok) {
    throw new ApiError(422, "validation_failed", { motivo: quando.motivo }, ctx.requestId, traduzir(MENSAGENS[quando.motivo]!, idioma));
  }

  const { data, error } = await supabase.rpc("fn_registrar_venda", {
    p_org: ctx.organization_id,
    p_contact: input.contact_id ?? null,
    p_lead: input.lead_id ?? null,
    p_fechada_em: quando.instante.toISOString(),
    p_itens: itensParaRpc(input.itens),
    p_chave: chave,
    p_negocio_previsto: input.negocio_previsto ?? null,
  });
  if (error) throw erroDaFuncao(error, ctx);

  const r = data as RetornoDaFuncao;
  const venda: VendaRegistrada = {
    lead_id: r.lead_id,
    contact_id: r.contact_id,
    pipeline_id: r.pipeline_id,
    criado: r.criado,
    ja_registrada: r.ja_registrada,
    total_cents: r.total_cents,
    currency: r.currency,
    closed_at: r.closed_at,
    title: r.title,
  };
  // Repetição da mesma chave: a primeira requisição já deixou o rastro. Não duplica.
  if (r.ja_registrada) return venda;

  const actorUserId = ctx.actor.type === "user" ? ctx.actor.id : null;
  if (r.criado) {
    await audit({
      action: "lead.created",
      actorUserId,
      organizationId: ctx.organization_id,
      resourceType: "crm_lead",
      resourceId: r.lead_id,
      requestId: ctx.requestId,
      metadata: { origem: "registrar_venda", pipeline_id: r.pipeline_id, stage_id: r.from_stage_id, title: r.title },
    });
  }
  await registraDesfecho(supabase, ctx, {
    leadId: r.lead_id,
    contactId: r.contact_id,
    desfecho: "won",
    fromStageId: r.from_stage_id ?? r.to_stage_id,
    toStageId: r.to_stage_id,
    payloadExtra: { origem: "registrar_venda", total_cents: r.total_cents, itens: input.itens.length, data_venda: r.closed_at },
    metadataExtra: { origem: "registrar_venda", total_cents: r.total_cents, itens: input.itens.length, data_venda: r.closed_at },
  });
  await emitirVendaPaga(supabase, ctx, r);
  await acrescentarTagsDeCompra(supabase, ctx, r.lead_id, input.itens);
  return venda;
}

/**
 * `venda.paga` — o webhook de saída que os agentes externos assinam. Venda registrada É venda paga neste
 * CRM. SEM VALOR: o valor do negócio de uma
 * venda é sigiloso (0251) e não sai para terceiro nenhum. Sem a marca `origem: registrar_venda` na metadata de
 * propósito: aquela marca bloqueia toda ação que não seja etiqueta ou responsável, e o aviso a um agente é justamente
 * o que este evento existe para entregar. Falha ao emitir não desfaz a venda; vira log.
 */
async function emitirVendaPaga(supabase: SupabaseClient, ctx: HandlerCtx, r: RetornoDaFuncao): Promise<void> {
  try {
    const { error } = await supabase.rpc("emit_event" as never, {
      p_event_type: "venda.paga",
      p_entity_kind: "crm_lead",
      p_entity_id: r.lead_id,
      p_payload: { lead_id: r.lead_id, contact_id: r.contact_id, pipeline_id: r.pipeline_id, fechada_em: r.closed_at },
      p_metadata: { actor_kind: ctx.actor.type, fonte: "registrar_venda", request_id: ctx.requestId },
      p_organization_id: ctx.organization_id,
    } as never);
    if (error) throw new Error((error as { message: string }).message);
  } catch (err) {
    logger.warn("[venda] emit_event venda.paga falhou", { lead_id: r.lead_id, error: err instanceof Error ? err.message : String(err) });
  }
}
