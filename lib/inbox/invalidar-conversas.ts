import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidação AGRUPADA da lista de conversas.
 *
 * Cada evento de realtime (mensagem, status, leitura) invalidava `["conversations"]`
 * na hora, e numa conversa movimentada chegam rajadas de eventos por segundo: cada
 * um disparava um GET da lista inteira. Aqui o primeiro evento arma um timer e os
 * seguintes dentro da janela entram de carona — no máximo UM refetch por janela, com
 * atraso limitado a `ms` (não é debounce que adia para sempre).
 *
 * Os dois hooks de realtime (lista e mensagens) usam o mesmo agrupador por
 * QueryClient, então um evento de mensagem + o de conversa viram uma ida só.
 *
 * NÃO use para a conversa ABERTA: a mensagem nova dela segue invalidando na hora.
 */
export const JANELA_PADRAO_MS = 1500;

const timers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

export function invalidarConversasAgrupado(qc: QueryClient, ms: number = JANELA_PADRAO_MS): void {
  if (timers.has(qc)) return;
  timers.set(
    qc,
    setTimeout(() => {
      timers.delete(qc);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }, ms),
  );
}
