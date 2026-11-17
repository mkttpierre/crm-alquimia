import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { carregarRegrasDeOrigem } from "@/lib/leads/regras-de-origem";
import { tagsDeCompra } from "@/lib/leads/tag-de-origem";
import { logger } from "@/lib/logger";

interface ItemDaVenda {
  product_id?: string | null;
  nome?: string | null;
}

/**
 * Venda registrada acrescenta `COMPROU <P>` ao negócio. Melhor esforço: nunca
 * lança, nunca remove tag. Lê SÓ o nome do produto, jamais preço (o preço de
 * produto interno é comissão).
 */
export async function acrescentarTagsDeCompra(
  supabase: SupabaseClient,
  ctx: Pick<HandlerCtx, "organization_id">,
  leadId: string,
  itens: ReadonlyArray<ItemDaVenda>,
): Promise<void> {
  try {
    const regras = await carregarRegrasDeOrigem(supabase, ctx.organization_id);
    if (regras.produtos.length === 0) return;

    const nomes: string[] = [];
    const ids = itens.map((i) => i.product_id).filter((x): x is string => !!x);
    if (ids.length > 0) {
      const { data } = await supabase
        .from("catalog_products")
        .select("nome")
        .eq("organization_id", ctx.organization_id)
        .in("id", ids);
      for (const r of (data ?? []) as Array<{ nome: string }>) nomes.push(r.nome);
    }
    for (const i of itens) if (!i.product_id && i.nome) nomes.push(i.nome);

    const { data: lead } = await supabase
      .from("crm_leads")
      .select("tags")
      .eq("organization_id", ctx.organization_id)
      .eq("id", leadId)
      .maybeSingle();
    const atuais = ((lead as { tags?: string[] } | null)?.tags ?? []) as string[];
    const novas = tagsDeCompra(nomes, regras, atuais);
    if (novas.length === 0) return;

    const { error } = await supabase
      .from("crm_leads")
      .update({ tags: [...atuais, ...novas] })
      .eq("organization_id", ctx.organization_id)
      .eq("id", leadId);
    if (error) {
      logger.warn("[venda] tag de compra: update falhou", { lead_id: leadId, error: error.message });
    }
  } catch (err) {
    logger.warn("[venda] tag de compra falhou", { lead_id: leadId, error: err instanceof Error ? err.message : String(err) });
  }
}
