import { ImageResponse } from "next/og";
import type { ReactElement } from "react";

import { COR_DO_IA, ESCRITA_IA, ESCRITA_TRACO, SOL_DO_PRODUTO } from "./arte-do-produto";
import { PRETO_DO_PRODUTO, SOL_PRETO_DO_PRODUTO } from "./arte-do-servidor";
import { letraDoIcone } from "./icone";
import { marcaDeSaidaFoiConfigurada } from "./resolve";
import type { MarcaDeSaida } from "./saida";

/**
 * O desenho dos ícones e da imagem de cabeçalho dos e-mails — um lugar só.
 *
 * Quem pede imagem à marca são quatro rotas: o ícone da aba (`app/icon.tsx`), o
 * ícone do app / apple-touch (`app/apple-icon.tsx`) e as variantes de
 * `app/icone-da-marca/[variante]/route.tsx` (aba no tema escuro, 192 e 512 do
 * manifest, cabeçalho de e-mail). Cada uma com o próprio JSX seria a mesma
 * decisão ("marca configurada ou padrão?") tomada em quatro cantos.
 *
 * ── A regra, igual à da barra lateral e à da fachada de acesso ──────────────
 *
 * - Nada configurado (`marcaDeSaidaFoiConfigurada` = falso) → o SOL do produto,
 *   do brandkit. Aba: sol sobre transparente — PRETO na aba clara, BRANCO na
 *   escura (o `<link media>` do layout escolhe). App: sol branco sobre `#111111`.
 * - Algo configurado → o ladrilho da cor da marca com a inicial dela, como antes
 *   desta onda. O sol NUNCA aparece na aba ou no app de um revendedor: seria a
 *   nossa marca no ícone de quem não a escolheu. `logo_url` continua fora daqui
 *   (SSRF com gatilho em cada page load — ver `app/icon.tsx`).
 *
 * O sol vem EMBUTIDO (`lib/branding/arte-do-produto.ts` e `arte-do-servidor.ts`), nunca de um arquivo em
 * `public/` nem de uma requisição: a imagem Docker é uma só para todas as marcas
 * e este módulo não toca a rede.
 */

export type VarianteDoIcone = "aba-claro" | "aba-escuro" | "app";

/** Quanto do lado o sol ocupa no ícone do app: o resto é respiro sobre o preto. */
const FRACAO_DO_SOL_NO_APP = 0.68;

/**
 * `cache-control` das imagens da marca. 60s é o par do TTL da marca
 * (`lib/branding/instalacao.ts`): quem troca a cor em `/admin/marca` vê a aba
 * acompanhar dentro de um minuto. `immutable` de um ano tornaria a tela de marca
 * uma promessa que o ícone não cumpre; `no-store` rodaria o satori a cada
 * navegação.
 */
export const CACHE_DA_IMAGEM_DA_MARCA = "public, max-age=60, stale-while-revalidate=600";

function ladrilhoDaMarca(marca: MarcaDeSaida, lado: number): ReactElement {
  const letra = letraDoIcone(marca.nome);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: marca.accent,
        color: marca.accentFg,
        // 62% da altura: a caixa maiúscula do Geist ocupa ~72% do em, então a
        // letra fica com respiro sem virar um selo minúsculo no meio.
        fontSize: Math.round(lado * 0.62),
        // O ladrilho é quadrado e cheio: o navegador já arredonda o favicon no
        // chrome dele, e arredondar aqui também produz canto duplo.
        borderRadius: 0,
      }}
    >
      {letra ?? ""}
    </div>
  );
}

function sol(src: string, lado: number): ReactElement {
  // `<img>` do satori exige width e height numéricos; sem eles ele não desenha.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={lado} height={lado} alt="" />;
}

/**
 * O que o ícone desenha. Pura (devolve o elemento, não a imagem) para o teste
 * medir a decisão sem subir o renderizador.
 */
export function desenhoDoIcone(
  marca: MarcaDeSaida,
  variante: VarianteDoIcone,
  lado: number,
): ReactElement {
  if (marcaDeSaidaFoiConfigurada(marca)) return ladrilhoDaMarca(marca, lado);

  if (variante === "app") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: PRETO_DO_PRODUTO,
        }}
      >
        {sol(SOL_DO_PRODUTO, Math.round(lado * FRACAO_DO_SOL_NO_APP))}
      </div>
    );
  }

  // Aba: o sol ocupa o quadrado inteiro, sobre transparente.
  return (
    <div style={{ width: "100%", height: "100%", display: "flex" }}>
      {sol(variante === "aba-escuro" ? SOL_DO_PRODUTO : SOL_PRETO_DO_PRODUTO, lado)}
    </div>
  );
}

/** A imagem (PNG) do ícone. `lado` em pixels reais. */
export function iconeDaMarca(
  marca: MarcaDeSaida,
  variante: VarianteDoIcone,
  lado: number,
): ImageResponse {
  return new ImageResponse(desenhoDoIcone(marca, variante, lado), {
    width: lado,
    height: lado,
    headers: { "cache-control": CACHE_DA_IMAGEM_DA_MARCA },
  });
}

/**
 * O topo dos e-mails de acesso, decidido NA HORA DA LEITURA.
 *
 * O e-mail é renderizado pelo GoTrue, um processo que não é o nosso, e só pode
 * buscar imagem por URL absoluta (`{{ .SiteURL }}/icone-da-marca/email`). Quem
 * decide o que aparece é esta imagem, quando o leitor abre o e-mail — nenhum script
 * de instalação precisa escolher por marca, e trocar a marca pela tela vale no
 * e-mail seguinte (dentro do TTL de 60 s).
 *
 * - Nada configurado: o sol e a escrita do produto, em preto e amarelo, sobre
 *   transparente, a 2x (o e-mail a mostra em 150 x 40 px). E-mail não tem tema
 *   (ver `lib/branding/saida.ts`): o corpo é claro, então a arte é a escura.
 * - Marca configurada (nome ou logo): o NOME em texto preto, sobre transparente. O
 *   sol do produto nunca vai no e-mail de um revendedor. Mesmo com logo configurado
 *   o cabeçalho é o nome: buscar o `logo_url` aqui seria uma requisição de saída
 *   disparada por uma rota PÚBLICA a cada leitura (SSRF com gatilho em quem abre o
 *   e-mail — a mesma razão de `app/icon.tsx`), e o formato do logo (SVG, por
 *   exemplo) nem sempre é imagem para cliente de e-mail.
 */
export const LARGURA_DO_CABECALHO_DE_EMAIL = 300;
export const ALTURA_DO_CABECALHO_DE_EMAIL = 80;

/**
 * O nome como o satori sabe desenhar. Fora do latim (emoji, CJK, árabe...) o satori
 * não tem fonte embutida e tenta BUSCAR uma na rede — falha numa VPS sem saída e
 * vira erro 500 na rota. Então só ficam letras latinas, dígitos, marcas, pontuação,
 * símbolos de moeda e espaço; o resto é descartado, como `letraDoIcone` faz com o
 * emoji do ícone.
 */
export function nomeDesenhavel(nome: string): string {
  return nome
    .replace(/[^\p{Script=Latin}\p{N}\p{M}\p{P}\p{Sc}\p{Zs}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function desenhoDoCabecalhoDeEmail(marca: MarcaDeSaida): ReactElement {
  if (marcaDeSaidaFoiConfigurada(marca)) {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center" }}>
        <div
          style={{
            width: "100%",
            display: "block",
            color: PRETO_DO_PRODUTO,
            fontSize: 28,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {nomeDesenhavel(marca.nome)}
        </div>
      </div>
    );
  }

  const alturaDaEscrita = 60;
  const larguraDaEscrita = Math.round((alturaDaEscrita * 800) / 245);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
      }}
    >
      {sol(SOL_PRETO_DO_PRODUTO, ALTURA_DO_CABECALHO_DE_EMAIL)}
      <svg
        width={larguraDaEscrita}
        height={alturaDaEscrita}
        viewBox="0 0 800 245"
        style={{ marginLeft: 16 }}
      >
        <path fill={PRETO_DO_PRODUTO} fillRule="evenodd" d={ESCRITA_TRACO} />
        <path fill={COR_DO_IA} fillRule="evenodd" d={ESCRITA_IA} />
      </svg>
    </div>
  );
}

export function cabecalhoDeEmail(marca: MarcaDeSaida): ImageResponse {
  return new ImageResponse(desenhoDoCabecalhoDeEmail(marca), {
    width: LARGURA_DO_CABECALHO_DE_EMAIL,
    height: ALTURA_DO_CABECALHO_DE_EMAIL,
    headers: { "cache-control": CACHE_DA_IMAGEM_DA_MARCA },
  });
}
