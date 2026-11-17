/**
 * Marca da mensagem de ENTRADA que não chegou pelo webhook e foi RECUPERADA depois pela
 * reconciliação de entrada (`lib/channels/evolution/reconciliacao.ts`): fica em
 * `messages.metadata.recuperada = true`, gravada no mesmo INSERT da ingestão.
 *
 * Quem lê: o dreno do `event_log` (`lib/event-log/drain.ts`), para que o `message.received` que o
 * gatilho do banco emite para ela não acorde consumidor que envia (IA, automação, follow-up).
 * Mensagem que chega horas ou dias depois não pode fazer o sistema responder sozinho.
 */
export const CHAVE_MENSAGEM_RECUPERADA = "recuperada";

export function mensagemFoiRecuperada(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>)[CHAVE_MENSAGEM_RECUPERADA] === true
  );
}
