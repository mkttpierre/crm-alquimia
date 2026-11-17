/**
 * Leituras do painel "Vendas e faturamento" que a tela Faturamento não faz, com o cliente da SESSÃO (a RLS decide o que a
 * pessoa enxerga) e `organization_id` explícito em TODA consulta. Só lê; a conta é de `painel-vendas.ts`.
 *
 * Não lê preço de catálogo (`catalog_products.preco`/`price`) nem `valor_sigiloso`: o painel não precisa de nenhum dos dois, e
 * o que não é lido não vaza.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CompraDoContato, ContagemDeLeads } from "./painel-vendas";

const PAGINA = 1000;
const MAX_PAGINAS = 20;
const LOTE_DE_CONTATOS = 100;

export interface RepositorioDoPainelDeVendas {
  /** Leads criados em [de, ate) e, desses, os que hoje estão ganhos. */
  contarLeads(org: string, janela: { de: string; ate: string }): Promise<ContagemDeLeads>;
  /** Todos os negócios ganhos desses contatos, fechados antes de `ateExclusivo`. */
  comprasDosContatos(org: string, contatos: string[], ateExclusivo: string): Promise<{ compras: CompraDoContato[]; truncado: boolean }>;
  /** `organizations.meta_mensal_cents`; `null` sem meta (ou sem a coluna ainda). */
  metaMensal(org: string): Promise<number | null>;
}

async function contar(consulta: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const { count, error } = await consulta;
  if (error) throw error;
  return count ?? 0;
}

export function repositorioPainelDeVendasSupabase(db: SupabaseClient): RepositorioDoPainelDeVendas {
  return {
    async contarLeads(org, janela) {
      const base = () =>
        db
          .from("crm_leads")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org)
          .gte("created_at", janela.de)
          .lt("created_at", janela.ate);
      const [criados, ganhos] = await Promise.all([contar(base()), contar(base().eq("status", "won"))]);
      return { criados, ganhos };
    },

    async comprasDosContatos(org, contatos, ateExclusivo) {
      const compras: CompraDoContato[] = [];
      let truncado = false;
      for (let i = 0; i < contatos.length; i += LOTE_DE_CONTATOS) {
        const lote = contatos.slice(i, i + LOTE_DE_CONTATOS);
        let fechou = false;
        for (let p = 0; p < MAX_PAGINAS && !fechou; p += 1) {
          const { data, error } = await db
            .from("crm_leads")
            .select("id, contact_id, closed_at")
            .eq("organization_id", org)
            .eq("status", "won")
            .in("contact_id", lote)
            .not("closed_at", "is", null)
            .lt("closed_at", ateExclusivo)
            .order("closed_at", { ascending: true })
            .order("id", { ascending: true })
            .range(p * PAGINA, p * PAGINA + PAGINA - 1);
          if (error) throw error;
          const bloco = (data ?? []) as Array<{ id: string; contact_id: string | null; closed_at: string | null }>;
          for (const l of bloco) {
            if (l.contact_id && l.closed_at) compras.push({ contact_id: l.contact_id, lead_id: l.id, closed_at: l.closed_at });
          }
          if (bloco.length < PAGINA) fechou = true;
          else if (p === MAX_PAGINAS - 1) truncado = true;
        }
      }
      return { compras, truncado };
    },

    async metaMensal(org) {
      const { data, error } = await db.from("organizations").select("meta_mensal_cents").eq("id", org).maybeSingle();
      // Banco que ainda não recebeu a 0262: o painel segue, sem meta, em vez de cair por um número opcional.
      if (error) return null;
      const meta = (data as { meta_mensal_cents?: number | string | null } | null)?.meta_mensal_cents;
      const n = typeof meta === "string" ? Number(meta) : meta;
      return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
    },
  };
}
