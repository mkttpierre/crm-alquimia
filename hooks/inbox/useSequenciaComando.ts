"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { atualizarConversaNasListas } from "@/lib/inbox/atualizar-conversa-no-cache";
import { toast } from "sonner";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { duracaoEmTexto } from "@/lib/inbox/sequencias";

export interface SequenciaArgs {
  conversation_id: string;
  /** Exatamente um dos três: o atalho do funil ("funil-valores"), o funil da barra ou uma mensagem avulsa. */
  atalho?: string;
  funnel_id?: string;
  template_id?: string;
  /** Reenvio consciente: a mesma sequência já saiu para a lead nas últimas 24 h (o servidor recusou com `sequencia_ja_enviada`). */
  confirmar?: boolean;
}

interface SequenciaResposta {
  data: {
    titulo: string;
    partes: number;
    modo: "real" | "simulado";
    motivo_simulado: string | null;
    chip: string;
    primeira_em: string;
    ultima_em: string;
    duracao_seg: number;
  };
}

/** Cancela o que ainda não saiu da sequência da conversa. */
async function cancelarSequencia(conversationId: string) {
  try {
    const r = await apiClient.delete<{ data: { canceladas: number } }>(`/api/v1/disparo/sequencia?conversation_id=${encodeURIComponent(conversationId)}`);
    toast.success(r.data.canceladas > 0 ? `Sequência cancelada: ${r.data.canceladas} mensagens não serão enviadas.` : "Nada a cancelar: a sequência já terminou de sair.");
  } catch (err) {
    showApiError(err);
  }
}

/**
 * Atalho `/funil-valores` da caixa de conversa: AGENDA a sequência de mensagens para a lead (em ordem, com pausa
 * entre elas) e responde com o resumo. Não envia nada na hora: o motor de disparo leva cada parte ao canal.
 */
export function useSequenciaComando() {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: SequenciaArgs) => apiClient.post<SequenciaResposta>("/api/v1/disparo/sequencia", input),
    onSuccess: (res, args) => {
      const d = res.data;
      const quanto = d.partes === 1 ? `1 mensagem em ${duracaoEmTexto(d.duracao_seg)}` : `${d.partes} mensagens em ${duracaoEmTexto(d.duracao_seg)}`;
      if (d.modo === "simulado") {
        toast.warning(`Ensaio: ${quanto}, só simuladas (${d.motivo_simulado ?? "trava do envio real fechada"}). Nada vai ao WhatsApp.`, { duration: 12_000 });
        return;
      }
      toast.success(`${d.partes === 1 ? "Mensagem" : "Funil"} agendado: ${quanto}, pelo chip ${d.chip}.`, {
        duration: 20_000,
        description: "Para sozinha se a lead responder. Cada mensagem sai na ordem, com pausa entre elas.",
        action: { label: "Cancelar", onClick: () => void cancelarSequencia(args.conversation_id) },
      });
    },
    onError: (err, args) => {
      // A mesma sequência já saiu para esta lead há pouco (caso de exemplo): nada foi agendado; reenviar só com o clique.
      if (err instanceof ApiError && err.code === "sequencia_ja_enviada" && !args.confirmar) {
        toast.warning(err.message, {
          duration: 20_000,
          action: { label: "Enviar de novo", onClick: () => mutation.mutate({ ...args, confirmar: true }) },
        });
        return;
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      qc.invalidateQueries({ queryKey: ["messages", args.conversation_id] });
      void atualizarConversaNasListas(qc, args.conversation_id);
      qc.invalidateQueries({ queryKey: ["andamento-do-funil", args.conversation_id] });
    },
  });
  return mutation;
}

export interface AndamentoDoFunil {
  em_andamento: boolean;
  /** Prefixo do tipo na fila (`funil_valores`): o composer o casa com o atalho do funil para mostrar o nome. */
  tipo: string | null;
  enviadas: number;
  total: number;
  proxima_em: string | null;
}

/** O funil em andamento na conversa: a faixa "Funil · 2 de 7 · próxima às 14:32" acima da caixa. Atualiza a cada 5 s enquanto anda. */
export function useAndamentoDoFunil(conversationId: string | null) {
  return useQuery({
    queryKey: ["andamento-do-funil", conversationId],
    enabled: Boolean(conversationId),
    queryFn: async () =>
      (await apiClient.get<{ data: AndamentoDoFunil }>(`/api/v1/disparo/sequencia?conversation_id=${encodeURIComponent(conversationId!)}`)).data,
    refetchInterval: (q) => (q.state.data?.em_andamento ? 5_000 : false),
  });
}

/** Cancela o que ainda não saiu do funil da conversa (o botão da faixa de andamento). */
export const cancelarFunilDaConversa = cancelarSequencia;
