/**
 * Leitura do que o faturamento precisa, com o cliente da SESSÃO (a RLS decide o que o usuário enxerga) e
 * `organization_id` explícito em TODA consulta. Só lê; a conta é de `faturamento.ts`.
 *
 * A janela vem alargada (ver `janelaDeBusca`) e é filtrada por dia civil do fuso da organização no cálculo. A leitura é
 * paginada em blocos de 1.000 até um teto; passando dele, `truncado = true` e a tela avisa em vez de mostrar número
 * incompleto como se fosse inteiro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ItemDeNegocioGanho, NegocioGanhoParaFaturar, PedidoParaFaturar } from "./faturamento";
import { STATUS_DE_PEDIDO_COM_RECEITA } from "./receita";

const PAGINA = 1000;
const MAX_PAGINAS = 20;
const LOTE_DE_IDS = 100;

export interface DadosDeFaturamento {
  negocios: NegocioGanhoParaFaturar[];
  pedidos: PedidoParaFaturar[];
  pipelines: Map<string, string>;
  /** A organização tem produto `so_interno` (valor de comissão): o total do painel conta só negócios ganhos. */
  temProdutoInterno: boolean;
  truncado: boolean;
}

export interface RepositorioFaturamento {
  /** Fuso da organização (`organizations.timezone`); `null` se não achar. */
  fuso(org: string): Promise<string | null>;
  carregar(org: string, janela: { de: string; ate: string }): Promise<DadosDeFaturamento>;
}

interface GanhoLido {
  id: string;
  pipeline_id: string;
  closed_at: string;
  value_cents: number | null;
  currency: string | null;
  title: string | null;
  owner_user_id: string | null;
  owner_kind: string | null;
}

type Pagina<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

async function paginar<T>(consulta: (de: number, ate: number) => Pagina<T>): Promise<{ linhas: T[]; truncado: boolean }> {
  const linhas: T[] = [];
  for (let p = 0; p < MAX_PAGINAS; p += 1) {
    const { data, error } = await consulta(p * PAGINA, p * PAGINA + PAGINA - 1);
    if (error) throw error;
    const bloco = data ?? [];
    linhas.push(...bloco);
    if (bloco.length < PAGINA) return { linhas, truncado: false };
  }
  return { linhas, truncado: true };
}

export function repositorioFaturamentoSupabase(db: SupabaseClient): RepositorioFaturamento {
  return {
    async fuso(org) {
      const { data, error } = await db.from("organizations").select("timezone").eq("id", org).maybeSingle();
      if (error) throw error;
      return (data as { timezone?: string } | null)?.timezone ?? null;
    },

    async carregar(org, janela) {
      const [ganhos, pedidos, pipes, interno] = await Promise.all([
        paginar<GanhoLido>((de, ate) =>
          db
            .from("crm_leads")
            .select("id, pipeline_id, closed_at, value_cents, currency, title, owner_user_id, owner_kind")
            .eq("organization_id", org)
            .eq("status", "won")
            .gte("closed_at", janela.de)
            .lt("closed_at", janela.ate)
            .order("closed_at", { ascending: true })
            .order("id", { ascending: true })
            .range(de, ate) as unknown as Pagina<GanhoLido>,
        ),
        paginar<PedidoParaFaturar>((de, ate) =>
          db
            .from("orders")
            .select("id, ordered_at, total_cents, currency, status")
            .eq("organization_id", org)
            .in("status", [...STATUS_DE_PEDIDO_COM_RECEITA])
            .gte("ordered_at", janela.de)
            .lt("ordered_at", janela.ate)
            .order("ordered_at", { ascending: true })
            .order("id", { ascending: true })
            .range(de, ate) as unknown as Pagina<PedidoParaFaturar>,
        ),
        db.from("crm_pipelines").select("id, name").eq("organization_id", org),
        db.from("catalog_products").select("id").eq("organization_id", org).eq("so_interno", true).limit(1),
      ]);
      if (pipes.error) throw pipes.error;
      if (interno.error) throw interno.error;

      const itensPorLead = new Map<string, ItemDeNegocioGanho[]>();
      const ids = ganhos.linhas.map((l) => l.id);
      let itensTruncados = false;
      for (let i = 0; i < ids.length; i += LOTE_DE_IDS) {
        const lote = ids.slice(i, i + LOTE_DE_IDS);
        // ⚠️ PAGINADO, com ordem estável (`created_at`, depois `id`, que é único). Sem `range` o PostgREST corta a resposta em
        // `max_rows` (1000, supabase/config.toml) e a leitura "terminava" sem erro com itens faltando — o faturamento por
        // produto ficava menor que o dos negócios, sem aviso. Passando do teto de leitura, `truncado` avisa a tela.
        const lidos = await paginar<ItemDeNegocioGanho & { lead_id: string }>(
          (de, ate) =>
            db
              .from("crm_lead_items")
              .select("lead_id, product_id, nome, quantidade, total_cents, currency")
              .eq("organization_id", org)
              .in("lead_id", lote)
              .order("created_at", { ascending: true })
              .order("id", { ascending: true })
              .range(de, ate) as unknown as Pagina<ItemDeNegocioGanho & { lead_id: string }>,
        );
        if (lidos.truncado) itensTruncados = true;
        for (const it of lidos.linhas) {
          const lista = itensPorLead.get(it.lead_id) ?? [];
          lista.push({ product_id: it.product_id, nome: it.nome, quantidade: it.quantidade, total_cents: it.total_cents, currency: it.currency });
          itensPorLead.set(it.lead_id, lista);
        }
      }

      return {
        negocios: ganhos.linhas.map((l) => ({
          lead_id: l.id,
          pipeline_id: l.pipeline_id,
          closed_at: l.closed_at,
          value_cents: l.value_cents,
          currency: l.currency,
          titulo: l.title,
          owner_user_id: l.owner_user_id,
          owner_kind: l.owner_kind,
          itens: itensPorLead.get(l.id) ?? [],
        })),
        pedidos: pedidos.linhas,
        pipelines: new Map(((pipes.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name])),
        temProdutoInterno: (interno.data ?? []).length > 0,
        truncado: ganhos.truncado || pedidos.truncado || itensTruncados,
      };
    },
  };
}
