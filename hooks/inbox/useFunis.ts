"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { FunilInput } from "@/lib/inbox/atalhos/schema-funil";
import type { Funil } from "@/lib/inbox/atalhos/tipos";

/** Funis do operador visíveis (compartilhados + os próprios): a barra de atalhos do chat e a tela Atalhos. */
export function useFunis() {
  return useQuery({
    queryKey: ["funis-do-operador"],
    queryFn: async () => apiClient.get<{ data: Funil[] }>("/api/v1/funnels"),
    staleTime: 60_000,
    select: (r) => r.data,
  });
}

/** Cria (sem `id`) ou regrava (com `id`) um funil inteiro. */
export function useSalvarFunil() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...funil }: FunilInput & { id?: string }) =>
      id ? apiClient.patch<{ data: Funil }>(`/api/v1/funnels/${id}`, funil) : apiClient.post<{ data: Funil }>("/api/v1/funnels", funil),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["funis-do-operador"] }),
  });
}

export function useApagarFunil() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/funnels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["funis-do-operador"] }),
  });
}
