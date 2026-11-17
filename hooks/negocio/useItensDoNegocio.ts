"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ItemAtualizarInput, ItemCriarInput } from "@/lib/negocio/schema-item";
import type { ItemDoNegocio } from "@/lib/negocio/repositorio-itens";

export interface ListaDeItens {
  itens: ItemDoNegocio[];
  currency: string;
  total_cents: number;
  ignorados_outra_moeda: number;
  valor_do_negocio_cents: number | null;
}

interface Resposta<T> {
  data: T;
}

export interface ProdutoDoCatalogoNaLista {
  id: string;
  codigo: string;
  nome: string;
  preco_cents: number;
  moeda: string;
  ativo: boolean;
  marca: string | null;
  /** Plano interno (valor de comissão): só serve para registrar venda. Vem da mesma rota do catálogo. */
  so_interno: boolean;
}

const chave = (leadId: string) => ["lead-items", leadId] as const;

export function useItensDoNegocio(leadId: string | null) {
  return useQuery({
    queryKey: leadId ? chave(leadId) : ["lead-items", "none"],
    enabled: !!leadId,
    queryFn: async () => (await apiClient.get<Resposta<ListaDeItens>>(`/api/v1/leads/${leadId}/items`)).data,
  });
}

/** Catálogo para o seletor "adicionar produto" (só carrega quando o formulário abre). */
export function useCatalogoParaNegocio(ativo: boolean) {
  return useQuery({
    queryKey: ["catalogo-para-negocio"],
    enabled: ativo,
    staleTime: 60_000,
    queryFn: async () => (await apiClient.get<Resposta<ProdutoDoCatalogoNaLista[]>>("/api/v1/products")).data,
  });
}

/**
 * Depois de mexer nos itens o banco já recalculou `crm_leads.value_cents`: invalida a lista, o quadro e o resumo do
 * contato para o valor novo aparecer em todo lugar sem recarregar a página.
 */
export function useMutacoesDeItens(leadId: string) {
  const qc = useQueryClient();
  const aoTerminar = () => {
    void qc.invalidateQueries({ queryKey: chave(leadId) });
    void qc.invalidateQueries({ queryKey: ["board"] });
    void qc.invalidateQueries({ queryKey: ["purchase-history"] });
  };
  const aoFalhar = (err: unknown) => showApiError(err);
  return {
    criar: useMutation({
      mutationFn: (corpo: ItemCriarInput) => apiClient.post(`/api/v1/leads/${leadId}/items`, corpo),
      onSuccess: aoTerminar,
      onError: aoFalhar,
    }),
    atualizar: useMutation({
      mutationFn: (corpo: ItemAtualizarInput) => apiClient.patch(`/api/v1/leads/${leadId}/items`, corpo),
      onSuccess: aoTerminar,
      onError: aoFalhar,
    }),
    apagar: useMutation({
      mutationFn: (itemId: string) => apiClient.delete(`/api/v1/leads/${leadId}/items?item_id=${itemId}`),
      onSuccess: aoTerminar,
      onError: aoFalhar,
    }),
  };
}
