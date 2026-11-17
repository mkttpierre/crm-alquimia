/**
 * Leitura e escrita dos itens do negócio (`crm_lead_items`) com o cliente da SESSÃO: a RLS da 0249 faz o item valer o
 * que o negócio vale. `organization_id` explícito em toda consulta (doutrina), e sempre o da sessão — nunca o do corpo.
 *
 * O valor do negócio (`crm_leads.value_cents`) é derivado dos itens por trigger no banco; aqui só se LÊ de volta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ItemDoNegocio {
  id: string;
  lead_id: string;
  product_id: string | null;
  nome: string;
  sku: string | null;
  quantidade: number;
  preco_unit_cents: number;
  desconto_cents: number;
  acrescimo_cents: number;
  cupom: string | null;
  currency: string;
  total_cents: number;
  created_at: string;
  updated_at: string;
}

export interface NegocioResumo {
  id: string;
  currency: string | null;
  value_cents: number | null;
}

export interface ProdutoDoCatalogo {
  id: string;
  codigo: string;
  nome: string;
  preco_cents: number;
  moeda: string;
  ativo: boolean;
}

export interface LinhaNova {
  product_id: string | null;
  nome: string;
  sku: string | null;
  quantidade: number;
  preco_unit_cents: number;
  desconto_cents: number;
  acrescimo_cents: number;
  cupom: string | null;
  currency: string;
}

export type LinhaParcial = Partial<Pick<LinhaNova, "nome" | "sku" | "quantidade" | "preco_unit_cents" | "desconto_cents" | "acrescimo_cents" | "cupom">>;

/** Igual ao `max_rows` do PostgREST (supabase/config.toml): uma página nunca passa disso. */
const PAGINA = 1000;

const COLS =
  "id, lead_id, product_id, nome, sku, quantidade, preco_unit_cents, desconto_cents, acrescimo_cents, cupom, currency, total_cents, created_at, updated_at";

export interface RepositorioItens {
  buscarNegocio(org: string, leadId: string): Promise<NegocioResumo | null>;
  buscarProduto(org: string, productId: string): Promise<ProdutoDoCatalogo | null>;
  listar(org: string, leadId: string): Promise<ItemDoNegocio[]>;
  criar(org: string, usuarioId: string, leadId: string, linha: LinhaNova): Promise<ItemDoNegocio>;
  atualizar(org: string, leadId: string, itemId: string, parcial: LinhaParcial): Promise<ItemDoNegocio | null>;
  apagar(org: string, leadId: string, itemId: string): Promise<boolean>;
}

export function repositorioItensSupabase(db: SupabaseClient): RepositorioItens {
  return {
    async buscarNegocio(org, leadId) {
      const { data, error } = await db.from("crm_leads").select("id, currency, value_cents").eq("organization_id", org).eq("id", leadId).maybeSingle();
      if (error) throw error;
      return (data as NegocioResumo | null) ?? null;
    },

    async buscarProduto(org, productId) {
      const { data, error } = await db.from("catalog_products").select("id, codigo, nome, preco_cents, moeda, ativo").eq("organization_id", org).eq("id", productId).maybeSingle();
      if (error) throw error;
      return (data as ProdutoDoCatalogo | null) ?? null;
    },

    async listar(org, leadId) {
      // Pagina até esgotar: o PostgREST corta cada consulta em `max_rows` (1000) em silêncio, e quem soma (a prévia do
      // quadro "Registrar venda") mentiria com mais linhas que isso. `id` desempata `created_at` para a ordem ser estável
      // entre as páginas (linhas inseridas no mesmo instante não se repetem nem se perdem).
      const todas: ItemDoNegocio[] = [];
      for (let de = 0; ; de += PAGINA) {
        const { data, error } = await db
          .from("crm_lead_items")
          .select(COLS)
          .eq("organization_id", org)
          .eq("lead_id", leadId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(de, de + PAGINA - 1);
        if (error) throw error;
        const pagina = (data ?? []) as ItemDoNegocio[];
        todas.push(...pagina);
        if (pagina.length < PAGINA) break;
      }
      return todas;
    },

    async criar(org, usuarioId, leadId, linha) {
      const { data, error } = await db
        .from("crm_lead_items")
        .insert({ ...linha, organization_id: org, lead_id: leadId, created_by_user_id: usuarioId })
        .select(COLS)
        .single();
      if (error) throw error;
      return data as ItemDoNegocio;
    },

    async atualizar(org, leadId, itemId, parcial) {
      const { data, error } = await db
        .from("crm_lead_items")
        .update(parcial)
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("id", itemId)
        .select(COLS)
        .maybeSingle();
      if (error) throw error;
      return (data as ItemDoNegocio | null) ?? null;
    },

    async apagar(org, leadId, itemId) {
      const { data, error } = await db.from("crm_lead_items").delete().eq("organization_id", org).eq("lead_id", leadId).eq("id", itemId).select("id");
      if (error) throw error;
      return (data ?? []).length > 0;
    },
  };
}
