/**
 * Leitura do histórico de compra de um contato com o cliente da SESSÃO (a RLS decide o que o usuário enxerga) e
 * `organization_id` explícito. Só lê; o cálculo é de `historico-compras.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { NegocioGanho, PedidoDaLoja } from "./historico-compras";
import { STATUS_DE_PEDIDO_COM_RECEITA } from "./receita";

/** Teto de linhas por contato: um cliente com mais que isso em compras é caso para relatório, não para esta aba. */
const LIMITE = 500;

export interface RepositorioHistorico {
  carregar(org: string, contactId: string): Promise<{ negocios: NegocioGanho[]; pedidos: PedidoDaLoja[] }>;
}

export function repositorioHistoricoSupabase(db: SupabaseClient): RepositorioHistorico {
  return {
    async carregar(org, contactId) {
      const [leads, pedidos] = await Promise.all([
        db
          .from("crm_leads")
          .select("id, title, closed_at, value_cents, currency")
          .eq("organization_id", org)
          .eq("contact_id", contactId)
          .eq("status", "won")
          .not("closed_at", "is", null)
          .order("closed_at", { ascending: false })
          .limit(LIMITE),
        db
          .from("orders")
          .select("id, external_id, ordered_at, total_cents, currency, status")
          .eq("organization_id", org)
          .eq("contact_id", contactId)
          .in("status", [...STATUS_DE_PEDIDO_COM_RECEITA])
          .order("ordered_at", { ascending: false })
          .limit(LIMITE),
      ]);
      if (leads.error) throw leads.error;
      if (pedidos.error) throw pedidos.error;

      const ganhos = (leads.data ?? []) as Array<{ id: string; title: string; closed_at: string; value_cents: number | null; currency: string | null }>;
      const ids = ganhos.map((l) => l.id);
      const porLead = new Map<string, NegocioGanho["itens"]>();
      if (ids.length > 0) {
        const itens = await db
          .from("crm_lead_items")
          .select("lead_id, nome, quantidade, total_cents")
          .eq("organization_id", org)
          .in("lead_id", ids)
          .order("created_at", { ascending: true });
        if (itens.error) throw itens.error;
        for (const i of (itens.data ?? []) as Array<{ lead_id: string; nome: string; quantidade: number; total_cents: number }>) {
          const lista = porLead.get(i.lead_id) ?? [];
          lista.push({ nome: i.nome, quantidade: i.quantidade, total_cents: i.total_cents });
          porLead.set(i.lead_id, lista);
        }
      }

      return {
        negocios: ganhos.map((l) => ({
          lead_id: l.id,
          titulo: l.title,
          closed_at: l.closed_at,
          value_cents: l.value_cents,
          currency: l.currency,
          itens: porLead.get(l.id) ?? [],
        })),
        pedidos: (pedidos.data ?? []) as PedidoDaLoja[],
      };
    },
  };
}
