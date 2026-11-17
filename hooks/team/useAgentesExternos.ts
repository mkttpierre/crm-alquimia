"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type { AgenteExterno, CriacaoDoAgente, EdicaoDoAgente } from "@/lib/agentes-externos/modelo";
import { apiClient } from "@/lib/api/client";

/** Um agente como a lista devolve: a linha mais a presença calculada (online < 5 min). */
export type AgenteDaLista = AgenteExterno & { online: boolean };

export interface ListaDeAgentes {
  agentes: AgenteDaLista[];
  /** Só para admin. */
  app_url?: string;
  /** Falso quando NEXT_PUBLIC_APP_URL está vazio e o endereço veio da requisição (pode ser host interno). */
  app_url_configurado?: boolean;
  minutos_conversa_esperando?: number;
}

const CHAVE = ["team", "agentes-externos"] as const;

/** Os agentes externos da equipe (agent+). A barra "Equipe agora" e a tela de agentes leem daqui. */
export function useAgentesExternos(opcoes: { ligado?: boolean } = {}) {
  return useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: ListaDeAgentes }>("/api/v1/team/agentes")).data,
    // A presença muda sozinha (o agente trabalha sem ninguém olhar a tela): relê a cada minuto.
    refetchInterval: 60_000,
    staleTime: 15_000,
    enabled: opcoes.ligado ?? true,
  });
}

export function useCriarAgente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entrada: CriacaoDoAgente) =>
      (
        await apiClient.post<{ data: { agente: AgenteDaLista; token: string; app_url: string } }>(
          "/api/v1/team/agentes",
          entrada,
        )
      ).data,
    onError: (err) => showApiError(err),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

export function useEditarAgente() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async ({ id, edicao }: { id: string; edicao: EdicaoDoAgente }) =>
      apiClient.patch(`/api/v1/team/agentes/${id}`, edicao),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Agente atualizado."));
      qc.invalidateQueries({ queryKey: CHAVE });
    },
  });
}

export function useRevogarAgente() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/team/agentes/${id}`),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Agente revogado. O acesso dele foi cortado."));
      qc.invalidateQueries({ queryKey: CHAVE });
    },
  });
}

export function useSalvarMinutosDeEspera() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (minutos: number) => apiClient.patch("/api/v1/team/agentes", { minutos_conversa_esperando: minutos }),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Aviso de conversa esperando atualizado."));
      qc.invalidateQueries({ queryKey: CHAVE });
    },
  });
}
