"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Lead } from "@/lib/types/leads";
import type { BoardData } from "@/lib/kanban/types";
import { moverNoCache } from "@/lib/kanban/board-pagina";

interface MoveArgs {
  leadId: string;
  stageId: string;
  positionInStage: number;
  expectedUpdatedAt: string;
}

export function useMoveCard(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;

  return useMutation({
    mutationFn: async (args: MoveArgs) => {
      // Minha própria ação não pulsa: o card já se moveu sob o cursor.
      marcarEcoLocal(args.leadId);
      return apiClient.post<{ data: Lead }>(`/api/v1/leads/${args.leadId}/move`, {
        stage_id: args.stageId,
        position_in_stage: args.positionInStage,
        expected_updated_at: args.expectedUpdatedAt,
      });
    },
    onMutate: async (args) => {
      // Por PREFIXO: a chave do board leva os filtros (`["board", id, filtros]`),
      // e o movimento vale para toda lista deste pipeline que estiver no cache.
      await qc.cancelQueries({ queryKey });
      const snapshots = qc.getQueriesData<BoardData>({ queryKey });
      qc.setQueriesData<BoardData>({ queryKey }, (b) =>
        b ? moverNoCache(b, args.leadId, args.stageId, args.positionInStage) : b,
      );
      return { snapshots };
    },
    onError: (err, _args, ctx) => {
      for (const [chave, dado] of ctx?.snapshots ?? []) qc.setQueryData(chave, dado);
      if (err instanceof ApiError && err.status === 409) {
        // Reconcile authoritative state — server already gave new updated_at.
        qc.invalidateQueries({ queryKey });
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      // A marca fecha com a AÇÃO, não com o relógio: daqui em diante só a folga
      // curta do último evento da cascata (ver lib/kanban/local-echo.ts).
      liberarEcoLocal(args.leadId);
      qc.invalidateQueries({ queryKey });
    },
  });
}
