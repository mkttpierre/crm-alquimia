import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A BARRA LATERAL PASSAVA POR CIMA DA LISTA DE CONVERSAS.
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * Abrir o inbox e encontrar a barra expandida — com as etiquetas legíveis — e a
 * lista de conversas ATRÁS dela, com o começo de cada linha escondido. Um F5
 * "consertava", que é a assinatura clássica de servidor e navegador terem
 * pintado estados diferentes.
 *
 * ─── A causa, e por que ela é estrutural ────────────────────────────────────
 *
 * A barra era `fixed`: saía do fluxo e não ocupava lugar nenhum na linha. Quem
 * afastava o conteúdo era um `ml-16`/`ml-60` do lado de lá, em OUTRO componente.
 *
 * Duas medidas para a mesma coisa. Enquanto concordam, ninguém vê nada; no
 * instante em que discordam — largura de 60 com margem de 16 — a barra cobre a
 * lista. E as duas nascem do mesmo booleano em componentes de CLIENTE, então
 * basta um render fora de sincronia para elas divergirem.
 *
 * Consertar o valor não conserta a classe: enquanto houver duas medidas, existe
 * o dia em que discordam. `sticky` devolve a barra ao fluxo, e aí sobra para o
 * conteúdo exatamente o que ela não usou — não há segunda medida.
 *
 * ─── O que este teste NÃO prova ─────────────────────────────────────────────
 *
 * Ele lê CLASSES, não geometria. A prova de verdade é medir
 * `getBoundingClientRect` das duas caixas num browser e mostrar que não se
 * sobrepõem — o que a doutrina de QA Visual pede e um teste de unidade não
 * alcança. Esta é a rede possível: impede a volta do PADRÃO que causou o
 * defeito.
 */

const BARRA = readFileSync("components/app/BarraLateral.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
const CASCA = readFileSync("app/app/_components/AppShell.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

describe("a barra ocupa lugar, e a largura é medida num lugar só", () => {
  // 15/11/2026: a barra voltou a ser `fixed`, agora DENTRO de um lugar reservado
  // no fluxo, no MESMO componente e com a MESMA constante de largura. `sticky`
  // não aguentava a trava de rolagem dos seletores e diálogos (Radix): ao abrir
  // um <Select>, o body vira `overflow: hidden`, passa a ser o contêiner de
  // rolagem, e a barra sticky subia junto com a página (medido: top 0 → -471px
  // em /app/ai/providers rolada; com `fixed`, top 0 com o seletor aberto).
  it("a barra é `fixed`, presa na tela", () => {
    expect(BARRA).toMatch(/\bfixed\b/);
    expect(BARRA).toMatch(/h-screen/);
  });

  it("um lugar reservado no fluxo usa a mesma constante de largura da barra", () => {
    // A segunda medida que causou o defeito antigo morava em OUTRO componente.
    // Aqui as duas caixas leem a mesma constante: não há como discordarem.
    expect(BARRA).toMatch(/const LARGURA_DA_BARRA = "w-\[264px\]"/);
    expect((BARRA.match(/LARGURA_DA_BARRA/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // O valor escrito uma vez só: na constante.
    expect(BARRA.match(/w-\[264px\]/g) ?? []).toHaveLength(1);
  });

  it("o lugar reservado não encolhe", () => {
    expect(BARRA).toMatch(/shrink-0/);
  });

  it("a casca NÃO compensa com margem", () => {
    const margens = [...CASCA.matchAll(/bml-(?:16|60)b/g)].map((m) => m[0]);
    expect(margens, "voltou a segunda medida da mesma coisa").toEqual([]);
  });
});

const CSS = readFileSync("app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** O bloco `seletor { ... }` do globals.css, sem comentários ("" se não houver). */
function bloco(seletor: string): string {
  const inicio = CSS.search(new RegExp(String.raw`\n\s*${seletor}\s*\{`));
  if (inicio < 0) return "";
  return CSS.slice(inicio, CSS.indexOf("}", inicio));
}

describe("a barra fica presa na tela ao rolar a página (15/11/2026)", () => {
  it("o body corta o estouro com `clip`, não só `hidden`", () => {
    // `overflow-x: hidden` no html E no body transformava o body em contêiner de
    // rolagem; o `sticky` grudava nele, que nunca rola, e subia junto com a
    // página. Medido no Chromium: com `hidden` a barra ia a -1500px depois de
    // rolar 1500px; com `clip`, 0.
    expect(bloco("body")).toMatch(/overflow-x:\s*clip/);
  });

  it("o html não tem overflow próprio: o do body vai para a janela", () => {
    // Com o html em `visible`, o navegador passa o overflow do body para a
    // JANELA, e o body nunca vira contêiner de rolagem. Isso vale também quando
    // um seletor ou diálogo do Radix trava a rolagem (`overflow: hidden` no
    // body): a trava vai para a janela e nada sticky sai do lugar. Com
    // `overflow-x` no html, o topo e a barra subiam 471px com um <Select>
    // aberto numa página rolada (medido em /app/ai/providers, 15/11/2026).
    expect(bloco("html")).not.toMatch(/overflow/);
  });
});
