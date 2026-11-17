/**
 * Logo próprio sobre a barra lateral PRETA (15/11/2026, pedido do dono do produto).
 *
 * O logo que a organização sobe é pensado para fundo claro: escrita preta ou
 * cinza-escura, às vezes com uma parte colorida (uma palavra rosa, um trecho
 * dourado). Sobre a barra preta, a parte escura some. O mesmo arquivo segue
 * valendo nas telas claras (login, e-mail), então o logo guardado não muda: só
 * a barra o desenha com a escrita escura trocada por branco.
 *
 * A regra é por pixel: pixel ESCURO e NEUTRO (sem cor) vira branco, mantendo a
 * transparência — o contorno suavizado da letra continua suave. Pixel colorido
 * fica como veio, então a cor da marca não muda. Branco e cinza claro também
 * ficam.
 */

/** Abaixo deste brilho (0–255, o maior dos três canais) o pixel conta como escuro. */
export const BRILHO_MAXIMO_ESCURO = 140;
/** Diferença máxima entre o maior e o menor canal para o pixel contar como neutro. */
export const DIFERENCA_MAXIMA_NEUTRO = 48;

/** Acima desta fração de pixels opacos e claros, o logo tem fundo claro chapado. */
export const FRACAO_MAXIMA_FUNDO_CLARO = 0.3;

/**
 * Logo sem transparência (JPG, PNG com fundo branco): a escrita trocada por
 * branco sumiria no fundo branco do próprio arquivo, e o resultado ficaria pior
 * que o original. Nesse caso nada é trocado.
 */
function temFundoClaroChapado(rgba: Uint8ClampedArray): boolean {
  const total = Math.floor(rgba.length / 4);
  if (total === 0) return false;
  let claros = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) >= 250 && Math.min(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0) >= 200) claros++;
  }
  return claros / total > FRACAO_MAXIMA_FUNDO_CLARO;
}

/** O pixel é escrita escura sem cor (preto, grafite, cinza-escuro)? */
export function ehEscritaEscura(r: number, g: number, b: number): boolean {
  const maior = Math.max(r, g, b);
  const menor = Math.min(r, g, b);
  return maior < BRILHO_MAXIMO_ESCURO && maior - menor < DIFERENCA_MAXIMA_NEUTRO;
}

/**
 * Troca por branco, no lugar, os pixels de escrita escura de um RGBA
 * (`ImageData.data`). Pixel totalmente transparente não conta. Devolve quantos
 * pixels mudaram — zero quer dizer que o logo já serve no escuro.
 */
export function clarearEscritaEscura(rgba: Uint8ClampedArray): number {
  if (temFundoClaroChapado(rgba)) return 0;
  let mudados = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    if (ehEscritaEscura(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0)) {
      rgba[i] = 255;
      rgba[i + 1] = 255;
      rgba[i + 2] = 255;
      mudados++;
    }
  }
  return mudados;
}
