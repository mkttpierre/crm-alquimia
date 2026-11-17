"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { atualizarConversaNasListas } from "@/lib/inbox/atualizar-conversa-no-cache";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

interface ClaimArgs {
  conversation_id: string;
  expected_assignee?: string | null;
}

export function useClaimConversation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: ClaimArgs) =>
      apiClient.post<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}/claim`,
        { expected_assignee: args.expected_assignee ?? null },
      ),
    onError: (err, args) => {
      void atualizarConversaNasListas(qc, args.conversation_id);
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      showApiError(err);
    },
    onSuccess: (_data, args) => {
      void atualizarConversaNasListas(qc, args.conversation_id);
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
