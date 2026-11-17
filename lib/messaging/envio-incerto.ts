/**
 * O canal não respondeu a tempo: a mensagem PODE ter saído.
 *
 * Tempo esgotado não é falha certa. O pedido chegou ao transporte, e quem desistiu fomos nós (`AbortSignal.timeout`
 * no cliente da Evolution, `waha_timeout` no do WAHA). Com o chip lento de 06/11 a Evolution levou ~30 s, o mesmo
 * teto do envio de texto: a linha ficou `failed` e a mensagem chegou ao lead. Tratar isso como falha certa libera o
 * reenvio idêntico em silêncio.
 *
 * Só o relógio conta como incerto. Recusa com status HTTP (o canal respondeu "não") e falha do nosso Storage
 * (`storage_sign_failed`, antes de tocar o canal) são falhas certas.
 */
export function falhaComResultadoIncerto(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === "TimeoutError" || name === "AbortError") return true;
  const msg = typeof message === "string" ? message : "";
  if (msg.startsWith("storage_sign_failed")) return false;
  return /^waha_timeout\b/.test(msg) || /aborted due to timeout|\btimed?[ _-]?out\b/i.test(msg);
}
