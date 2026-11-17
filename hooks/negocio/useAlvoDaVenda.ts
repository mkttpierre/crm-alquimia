"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { AlvoDaVenda } from "@/lib/negocio/alvo-da-venda";

/**
 * O negócio que "Registrar venda" vai usar, o que já está nele, a moeda e o "hoje" da organização.
 * Sempre fresco (`staleTime: 0`, refaz ao abrir): o negócio pode ter mudado desde a última vez, e o total final que o quadro
 * mostra depende do que está gravado agora.
 */
export function useAlvoDaVenda(contactId?: string | null, leadId?: string | null) {
  return useQuery({
    queryKey: ["sale-target", contactId ?? null, leadId ?? null],
    enabled: !!contactId || !!leadId,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (contactId) sp.set("contact_id", contactId);
      if (leadId) sp.set("lead_id", leadId);
      return (await apiClient.get<{ data: AlvoDaVenda }>(`/api/v1/sales/alvo?${sp.toString()}`)).data;
    },
  });
}
