import {
  COR_DO_IA,
  ESCRITA_IA,
  ESCRITA_TRACO,
  ESCRITA_VIEWBOX,
  SOL_DO_PRODUTO,
} from "@/lib/branding/arte-do-produto";

/**
 * As duas peças do padrão do produto — o sol e a escrita do produto —, UMA vez.
 *
 * Quem desenha a marca do produto são DOIS lugares: a barra lateral
 * (`MarcaDoProduto.tsx`, sempre sobre fundo escuro) e a fachada de acesso
 * (`app/(public)/layout.tsx`, que segue o tema da página). Cada um com o seu
 * `<img>` e o seu `<svg>` seriam duas cópias do desenho, e a que ficasse para
 * trás seria a que ninguém abre. Aqui moram as peças; quem compõe (lado a lado,
 * empilhado) é o chamador.
 *
 * Sem `"use client"` e sem hook de propósito: a fachada é Server Component, e a
 * barra importa isto de dentro de um componente cliente — as duas leituras valem.
 *
 * ── `seguirTema` ────────────────────────────────────────────────────────────
 *
 * O PNG embutido é o sol BRANCO (brandkit). Sobre a barra lateral, escura nos
 * dois temas, ele serve como está. Sobre a página, que é clara no tema claro,
 * `invert` o leva ao preto da marca — o desenho é o mesmo, o brandkit fala em
 * "o mesmo sol em preto" —, e `dark:invert-0` o devolve ao branco no tema
 * escuro. A escrita acompanha por `currentColor`; só o "(IA)" mantém o amarelo.
 */

/** O sol. `className` carrega o tamanho — a peça não decide proporção. */
export function SolDoProduto({
  className,
  seguirTema = false,
}: {
  className?: string;
  seguirTema?: boolean;
}) {
  const inverter = seguirTema ? "invert dark:invert-0" : "";
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={SOL_DO_PRODUTO}
      alt=""
      aria-hidden
      className={[className, inverter].filter(Boolean).join(" ")}
    />
  );
}

/**
 * A escrita. A cor do texto vem de quem chama (`text-lateral-texto`,
 * `text-foreground`), porque o traço principal é `currentColor`.
 */
export function EscritaDoProduto({ nome, className }: { nome: string; className?: string }) {
  return (
    <svg viewBox={ESCRITA_VIEWBOX} role="img" aria-label={nome} className={className}>
      <path fill="currentColor" fillRule="evenodd" d={ESCRITA_TRACO} />
      <path fill={COR_DO_IA} fillRule="evenodd" d={ESCRITA_IA} />
    </svg>
  );
}
