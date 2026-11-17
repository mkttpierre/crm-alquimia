"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { AgentInboxSeverity } from "@/lib/ai/agent-inbox-copy";
import type { DestinoDoAviso } from "@/lib/ai/inbox-destino";

export interface AgentInboxItem {
  id: string;
  kind: string;
  severity: AgentInboxSeverity;
  title: string;
  body: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  status: "open" | "ack" | "resolved";
  created_at: string;
  destination: DestinoDoAviso;
}

export interface AgentInboxData {
  items: AgentInboxItem[];
  open_count: number;
}

/** Central de avisos do runtime (F1). Polling 60s — avisos nascem no worker. */
export function useAgentInbox(status: "open" | "resolved" = "open") {
  const podeConsultar = usePermission("ai.inbox.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: ["agent-inbox", status],
    refetchInterval: 60_000,
    queryFn: () =>
      apiClient
        .get<{ data: AgentInboxData }>(`/api/v1/ai/inbox?status=${status}`)
        .then((r) => r.data),
  });
}

/**
 * Só o número de avisos abertos, para o selo do sino que aparece em toda tela.
 *
 * A chave começa em `["agent-inbox"]` de propósito: `useUpdateInboxItem` e
 * `useResolveAllInboxItems` invalidam esse prefixo, e o selo acompanha. Não
 * baixa a lista (~23 KB) — quem precisa dela usa `useAgentInbox`.
 */
export function useAgentInboxCount() {
  const podeConsultar = usePermission("ai.inbox.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: ["agent-inbox", "count"],
    refetchInterval: 60_000,
    queryFn: () =>
      apiClient
        .get<{ data: { open_count: number } }>("/api/v1/ai/inbox/count")
        .then((r) => r.data.open_count),
  });
}

export function useUpdateInboxItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: "open" | "resolved" }) =>
      apiClient.patch(`/api/v1/ai/inbox/${id}`, { status }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["agent-inbox"] }),
  });
}

/**
 * Resolve TODOS os avisos abertos da organização de uma vez.
 *
 * Não recebe ids: quem decide o conjunto é o servidor, a partir da org do
 * cookie. Mandar a lista da tela seria pior — a tela carrega no máximo 50, e
 * "marcar todos" com 144 abertos precisa alcançar os 144.
 */
export function useResolveAllInboxItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<{ data: { resolved_count: number } }>(
      "/api/v1/ai/inbox/resolve-all",
      {},
    ),
    onSettled: () => qc.invalidateQueries({ queryKey: ["agent-inbox"] }),
  });
}
