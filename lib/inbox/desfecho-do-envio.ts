/**
 * O que a tela faz depois de um envio de mensagem que não terminou bem.
 *
 * A diferença que importa é CERTO x INCERTO. Falha certa (o servidor recusou antes de falar com o canal, o canal disse
 * "não") devolve o texto à caixa: nada saiu. Incerto (sem resposta do servidor, proxy que desistiu, canal que estourou
 * o tempo) NÃO devolve: a mensagem pode ter chegado ao lead, e o texto de volta na caixa convida a clicar de novo —
 * foi assim que a mesma frase saiu três vezes em 06/11.
 */
import { ApiError } from "@/lib/api/types";

export type DesfechoDoErroDeEnvio =
  /** A mesma mensagem acabou de sair: reenviar só com confirmação. */
  | "duplicada"
  /** A mesma mensagem estourou o tempo há pouco e pode ter chegado: reenviar só com confirmação. */
  | "talvez_enviada"
  /** Este mesmo pedido ainda está no canal. */
  | "em_andamento"
  /** Não se sabe se saiu. */
  | "incerto"
  /** Falha certa: nada saiu. */
  | "falha";

/** Status que vêm de proxy ou de gateway que desistiu de esperar: o pedido pode ter sido processado. */
const STATUS_INCERTOS = new Set([502, 503, 504]);

export function desfechoDoErroDeEnvio(err: unknown): DesfechoDoErroDeEnvio {
  if (!(err instanceof ApiError)) return "incerto";
  if (err.code === "mensagem_duplicada") return "duplicada";
  if (err.code === "mensagem_talvez_enviada") return "talvez_enviada";
  if (err.code === "envio_em_andamento") return "em_andamento";
  if (STATUS_INCERTOS.has(err.status)) return "incerto";
  return "falha";
}

/** A linha voltou `failed` porque o canal estourou o tempo (o servidor marca `metadata.resultado_incerto`). */
export function envioComResultadoIncerto(message: { status?: string | null; metadata?: Record<string, unknown> | null } | null | undefined): boolean {
  return message?.status === "failed" && message.metadata?.resultado_incerto === true;
}
