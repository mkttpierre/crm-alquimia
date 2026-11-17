"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { HistoricoDeCompras } from "@/lib/negocio/historico-compras";

export function usePurchaseHistory(contactId: string) {
  return useQuery({
    queryKey: ["purchase-history", contactId],
    enabled: !!contactId,
    queryFn: async () => (await apiClient.get<{ data: HistoricoDeCompras }>(`/api/v1/contacts/${contactId}/purchase-history`)).data,
  });
}
