import { marcaDeSaidaFoiConfigurada } from "./resolve";
import type { MarcaDeSaida } from "./saida";

/**
 * Cache em memória do PNG já desenhado, por (variante, marca), por 60 s.
 *
 * As imagens da marca (`app/icone-da-marca/[variante]/route.tsx`) são rota PÚBLICA,
 * pedida por quem nunca entrou — navegadores, o iOS e todo cliente de e-mail que
 * abre uma mensagem. Sem isto cada pedido rodaria o satori e o `sharp`, e quem quiser
 * custo de CPU só precisa repetir a URL. 60 s é o par do TTL da marca
 * (`lib/branding/instalacao.ts`) e do `cache-control` das imagens: quem troca a cor
 * em `/admin/marca` vê a imagem acompanhar dentro de um minuto.
 *
 * É por PROCESSO e não compartilhado entre instâncias, e isso basta: o que se evita
 * é o custo de desenhar, e cada instância desenha uma vez por minuto por variante.
 * A chave cobre tudo que o desenho lê da marca — e nada que ele não leia (o
 * endereço do logo, por exemplo, nunca é buscado).
 */

export const TTL_DA_IMAGEM_MS = 60_000;
/** O espaço de chaves é pequeno (4 variantes x as marcas que existiram no minuto); o teto é só cinto. */
const MAXIMO_DE_ENTRADAS = 32;

const guardadas = new Map<string, { readonly ate: number; readonly corpo: ArrayBuffer }>();

export function chaveDaImagem(variante: string, marca: MarcaDeSaida): string {
  return JSON.stringify([
    variante,
    marcaDeSaidaFoiConfigurada(marca),
    marca.nome,
    marca.accent,
    marca.accentFg,
  ]);
}

/**
 * Devolve o PNG guardado para `chave` ou o gera. `gerar` que lança NÃO deixa rastro:
 * a próxima requisição tenta de novo, em vez de servir um erro por 60 s.
 */
export async function imagemEmCache(
  chave: string,
  gerar: () => Promise<ArrayBuffer>,
  agora: () => number = Date.now,
): Promise<ArrayBuffer> {
  const t = agora();
  const achada = guardadas.get(chave);
  if (achada && achada.ate > t) return achada.corpo;

  const corpo = await gerar();

  if (guardadas.size >= MAXIMO_DE_ENTRADAS) {
    for (const [k, v] of guardadas) if (v.ate <= t) guardadas.delete(k);
    // Ainda cheio: a mais antiga sai (o `Map` guarda a ordem de inserção).
    const primeira = guardadas.keys().next();
    if (guardadas.size >= MAXIMO_DE_ENTRADAS && !primeira.done) guardadas.delete(primeira.value);
  }
  guardadas.set(chave, { ate: t + TTL_DA_IMAGEM_MS, corpo });
  return corpo;
}

/** Só para teste: o cache é estado de módulo. */
export function __esvaziarCacheDaImagem(): void {
  guardadas.clear();
}
