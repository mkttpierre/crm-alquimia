/**
 * Produto lançado no negócio = venda: o negócio vai para a etapa de Ganho, e o faturamento do Início (que soma só
 * `status = 'won'`, na data de fechamento, ver `receita.ts`) passa a contá-lo. Tirar o ÚLTIMO produto reabre o negócio
 * (um negócio sem produto e sem valor não é venda).
 *
 * Usa a mesma regra do "marcar como ganho" (`encerraDemanda`: idempotente, filtra `organization_id`, registra timeline e
 * audit), e para reabrir só move o negócio para a primeira etapa aberta do funil: o trigger `fn_crm_lead_close_on_stage`
 * volta `status` para `open` e zera `closed_at`. Nunca envia mensagem. Melhor esforço: nunca lança, quem chama decide o
 * que mostrar (o produto já foi gravado).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { logger } from "@/lib/logger";

export interface ResultadoDoGanho {
  marcado: boolean;
  /** Código do motivo quando não marcou (ex.: `pipeline_no_won_stage`: o funil não tem etapa de ganho). */
  motivo?: string;
}

export async function marcarGanhoPorProduto(supabase: SupabaseClient, ctx: HandlerCtx, leadId: string): Promise<ResultadoDoGanho> {
  try {
    await encerraDemanda(supabase, ctx, { leadId, desfecho: "won" });
    return { marcado: true };
  } catch (err) {
    const motivo = err instanceof ApiError ? err.code : "erro";
    logger.warn("[itens] produto lançado, mas o negócio não foi marcado como ganho", { lead_id: leadId, motivo });
    return { marcado: false, motivo };
  }
}

/** Reabre o negócio ganho que ficou sem nenhum produto. Devolve `true` só se reabriu. */
export async function reabrirSeSemItens(supabase: SupabaseClient, ctx: HandlerCtx, leadId: string): Promise<boolean> {
  try {
    const org = ctx.organization_id;
    const { count, error: contErr } = await supabase
      .from("crm_lead_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("lead_id", leadId);
    if (contErr || (count ?? 0) > 0) return false;

    const { data: lead } = await supabase
      .from("crm_leads")
      .select("status, pipeline_id")
      .eq("organization_id", org)
      .eq("id", leadId)
      .maybeSingle();
    const atual = lead as { status: string; pipeline_id: string } | null;
    if (!atual || atual.status !== "won") return false;

    const { data: etapa } = await supabase
      .from("crm_stages")
      .select("id")
      .eq("organization_id", org)
      .eq("pipeline_id", atual.pipeline_id)
      .eq("is_won", false)
      .eq("is_lost", false)
      .eq("is_archived", false)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();
    const alvo = etapa as { id: string } | null;
    if (!alvo) return false;

    const { error } = await supabase
      .from("crm_leads")
      .update({ stage_id: alvo.id })
      .eq("organization_id", org)
      .eq("id", leadId)
      .eq("status", "won");
    if (error) {
      logger.warn("[itens] último produto removido, mas o negócio não reabriu", { lead_id: leadId, error: error.message });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("[itens] reabrir negócio sem produto falhou", { lead_id: leadId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
