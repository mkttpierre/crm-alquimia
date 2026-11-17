import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { razaoDeContraste } from "@/lib/branding/contraste";

/**
 * O TEXTO PEQUENO DA CASCA PASSA EM 4,5:1.
 *
 * Os títulos dos blocos da barra ("PROSPECÇÃO", "GESTÃO", "EQUIPE AGORA") e o
 * "há X min" da Atividade recente são texto de 11–12px: a régua é a do texto
 * normal (WCAG AA, 4,5:1), não a de componente (3:1). O protótipo usava
 * `#6f6f6f`, que sobre o preto da barra dá ~4,0 — legível no monitor de quem
 * desenhou, abaixo do piso para quem lê. Os valores saem do `globals.css`, e o
 * teste reprova quem os escurecer de novo.
 */
const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

function bloco(seletor: string): Record<string, string> {
  const inicio = CSS.indexOf(`\n${seletor} {\n`);
  if (inicio < 0) throw new Error(`bloco ${seletor} não achado`);
  const fim = CSS.indexOf("\n}\n", inicio);
  const tokens: Record<string, string> = {};
  for (const m of CSS.slice(inicio, fim).matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[m[1]!] = m[2]!.toLowerCase();
  }
  return tokens;
}

const RAIZ = bloco(":root");
const CLARO = bloco('[data-theme="light"]');
const ESCURO = { ...RAIZ, ...bloco('[data-theme="dark"]') };
const PISO_DE_TEXTO = 4.5;

describe("texto pequeno da casca", () => {
  it("título dos blocos da barra sobre o preto da barra", () => {
    expect(
      razaoDeContraste(RAIZ["--color-lateral-apagado"]!, RAIZ["--color-lateral"]!),
    ).toBeGreaterThanOrEqual(PISO_DE_TEXTO);
  });

  it("o texto apagado (`text-subtle`, o 'há X min') sobre fundo e cartões, nos dois temas", () => {
    for (const [nome, tema] of [
      ["claro (:root)", RAIZ],
      ["claro (espelho)", CLARO],
      ["escuro", ESCURO],
    ] as const) {
      for (const fundo of ["--color-bg", "--color-surface", "--color-surface-elevated"]) {
        expect(
          razaoDeContraste(tema["--color-text-subtle"]!, tema[fundo]!),
          `${nome}: text-subtle sobre ${fundo}`,
        ).toBeGreaterThanOrEqual(PISO_DE_TEXTO);
      }
    }
  });
});
