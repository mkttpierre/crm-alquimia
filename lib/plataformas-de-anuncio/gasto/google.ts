/**
 * Google Ads como fonte de gasto: AINDA NÃO CONECTADA.
 *
 * Existe para o painel já tratar a plataforma como uma fonte como qualquer outra: quando alguém construir a conexão
 * (credencial de leitura + chamada de gasto), é só trocar o corpo de `lerGasto` por uma leitura real e devolver
 * `{ estado: "conectada", ... }` — o painel, o cruzamento e os testes de contrato não mudam. Até lá devolve
 * `nao_conectada` sem tocar em rede nem em banco.
 */
import type { FonteDeGasto } from "./fonte";

export function criarFonteGoogleAds(): FonteDeGasto {
  return {
    plataforma: "google_ads",
    async lerGasto() {
      return { estado: "nao_conectada", plataforma: "google_ads" };
    },
  };
}
