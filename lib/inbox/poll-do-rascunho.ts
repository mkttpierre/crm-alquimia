/**
 * Quando reler o `/draft-reply`?
 *
 * Antes: a cada 4s, para sempre, com ou sem rascunho. Agora só enquanto algo está
 * EM ANDAMENTO (gerando a sugestão ou aprovado esperando o envio) e com teto: passado
 * `TETO_MS` desde o início da espera, para — a pessoa recarrega ou gera de novo.
 * `pending`, `stale`, rejeitado, enviado, sem rascunho: nada a esperar, sem polling.
 */
export const INTERVALO_RASCUNHO_MS = 4000;
export const TETO_RASCUNHO_MS = 2 * 60_000;

const EM_ANDAMENTO = new Set(["generating", "approved"]);

export function proximoPollDoRascunho(
  status: string | undefined,
  inicioDaEsperaMs: number | null,
  agoraMs: number,
): number | false {
  if (!status || !EM_ANDAMENTO.has(status)) return false;
  if (inicioDaEsperaMs !== null && agoraMs - inicioDaEsperaMs > TETO_RASCUNHO_MS) return false;
  return INTERVALO_RASCUNHO_MS;
}
