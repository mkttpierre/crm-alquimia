"use client";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { atualizarConversaNasListas } from "@/lib/inbox/atualizar-conversa-no-cache";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { desfechoDoErroDeEnvio, envioComResultadoIncerto } from "@/lib/inbox/desfecho-do-envio";
import type { Message } from "@/lib/types/messaging";

/**
 * Quanto a tela espera pelo envio. Acima do pior caso do canal (120 s de mídia na Evolution, 30 s de texto) com folga
 * para a fila da conversa e o banco: a resposta que vale é a do PRIMEIRO pedido. Sem nova tentativa por rede ou tempo
 * (`retryOnNetworkError: false`): repetir não envia de novo (a rota honra a `Idempotency-Key`), só troca o desfecho
 * real por "em andamento". Caso de 06/11: limite de 10 s e duas repetições, três envios da mesma frase.
 */
export const TEMPO_LIMITE_DO_ENVIO_MS = 150_000;

const AVISO_INCERTO = "Não deu para confirmar o envio: a mensagem pode ter saído. Confira a conversa antes de mandar de novo.";
const AVISO_CANAL_LENTO = "O WhatsApp demorou a responder e a mensagem pode ter sido entregue. Confira no celular antes de reenviar.";
const AVISO_DUPLICADA = "Você acabou de enviar esta mesma mensagem.";
const AVISO_TALVEZ_ENVIADA = "Você enviou esta mesma mensagem há pouco e o WhatsApp não confirmou: ela pode ter sido entregue.";
const AVISO_EM_ANDAMENTO = "Esta mensagem ainda está sendo enviada. Aguarde a confirmação.";

interface SendArgs {
  conversation_id: string;
  body?: string;
  media_url?: string;
  media_mime?: string;
  media_storage_path?: string;
  media_size_bytes?: number;
  type?: string;
  /**
   * Definição aprovada — o caminho de volta quando a janela de 24h fechou. A
   * rota já aceitava estes campos; só o front nunca os mandava, então não havia
   * como disparar um modelo pelo inbox.
   */
  template_name?: string;
  template_language?: string;
  template_values?: Record<string, string>;
  /** A mensagem citada — id da NOSSA linha; o handler traduz para o do canal. */
  reply_to_message_id?: string;
  metadata?: Record<string, unknown>;
  /** Reenvio confirmado pelo operador: a mesma mensagem já saiu (ou pode ter saído) há pouco. */
  allow_duplicate?: boolean;
}

interface MessagesPage {
  data: Message[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

export function useSendMessage() {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: SendArgs) =>
      apiClient.post<{ data: Message }>("/api/v1/messages", input, {
        timeoutMs: TEMPO_LIMITE_DO_ENVIO_MS,
        retryOnNetworkError: false,
      }),
    onMutate: async (args) => {
      if (args.media_storage_path || args.media_url || args.type === "contact") return {};

      const queryKey = ["messages", args.conversation_id];
      await qc.cancelQueries({ queryKey });

      const tempId = `temp-${Date.now()}`;
      const tempMsg: Message = {
        id: tempId,
        organization_id: "",
        conversation_id: args.conversation_id,
        channel_session_id: "",
        contact_id: "",
        external_id: null,
        type: args.type ?? "text",
        direction: "outbound",
        status: "queued",
        ack: null,
        error_code: null,
        error_message: null,
        body: args.body ?? null,
        media_url: args.media_url ?? null,
        media_mime: args.media_mime ?? null,
        media_size_bytes: null,
        media_storage_path: null,
        reply_to_message_id: args.reply_to_message_id ?? null,
        sent_via: "user",
        sent_by_user_id: null,
        sent_at: new Date().toISOString(),
        delivered_at: null,
        read_at: null,
        metadata: { _optimistic: true },
        // Mensagem que acaba de sair não foi editada nem apagada — mas os
        // campos precisam existir: sem eles o otimista não é do mesmo tipo do
        // que volta do servidor, e a bolha passaria a renderizar dois formatos.
        edited_at: null,
        revoked_at: null,
        created_at: new Date().toISOString(),
      };

      qc.setQueryData<InfiniteData<MessagesPage>>(queryKey, (old) => {
        if (!old) return old;
        const pages = [...old.pages];
        if (pages.length > 0) {
          const lastIdx = pages.length - 1;
          const lastPage = pages[lastIdx]!;
          pages[lastIdx] = {
            ...lastPage,
            data: [...lastPage.data, tempMsg],
          };
        }
        return { ...old, pages };
      });

      return { tempId };
    },
    onSuccess: (res) => {
      if (envioComResultadoIncerto(res?.data)) toast.warning(AVISO_CANAL_LENTO, { duration: 20_000 });
    },
    onError: (err, args) => {
      qc.invalidateQueries({ queryKey: ["messages", args.conversation_id] });
      const desfecho = desfechoDoErroDeEnvio(err);
      // Nunca bloqueia sem saída: a duplicata (certa ou provável) sai com um clique explícito do operador.
      if ((desfecho === "duplicada" || desfecho === "talvez_enviada") && !args.allow_duplicate) {
        toast.warning(desfecho === "duplicada" ? AVISO_DUPLICADA : AVISO_TALVEZ_ENVIADA, {
          duration: 20_000,
          action: { label: "Enviar de novo", onClick: () => mutation.mutate({ ...args, allow_duplicate: true }) },
        });
        return;
      }
      if (desfecho === "em_andamento") {
        toast.info(AVISO_EM_ANDAMENTO);
        return;
      }
      // Sem resposta: tentar de novo SEM confirmar passa pela trava do servidor, que recusa se a primeira chegou lá.
      if (desfecho === "incerto") {
        toast.warning(AVISO_INCERTO, {
          duration: 20_000,
          action: { label: "Tentar de novo", onClick: () => mutation.mutate(args) },
        });
        return;
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      qc.invalidateQueries({ queryKey: ["messages", args.conversation_id] });
      void atualizarConversaNasListas(qc, args.conversation_id);
    },
  });
  return mutation;
}
