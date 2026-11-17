/**
 * Diagrama Mermaid que não desenha: parêntese dentro de rótulo sem aspas.
 *
 * Num `flowchart`/`graph`, `No[texto (com parêntese)]` quebra o parser (o `(` abre outra forma de nó), e o
 * GitHub mostra o erro no lugar do diagrama. O nome do produto tem parênteses, então toda troca de nome em
 * massa pode deixar um diagrama assim. Rótulo com parêntese vai entre aspas: `No["texto (com parêntese)"]`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const BLOCO = /```mermaid\r?\n([\s\S]*?)```/g;
/** Nó com rótulo em colchetes, sem aspas, que tem um parêntese dentro. */
const ROTULO_SEM_ASPAS_COM_PARENTESE = /\b[A-Za-z_][\w-]*\[(?!["[(/\\])[^\]"]*\([^\]"]*\]/;

function blocosDeFluxo(texto: string): Array<{ linha: number; corpo: string }> {
  const saida: Array<{ linha: number; corpo: string }> = [];
  for (const m of texto.matchAll(BLOCO)) {
    const corpo = m[1] ?? "";
    if (!/^\s*(flowchart|graph)\b/.test(corpo)) continue;
    saida.push({ linha: texto.slice(0, m.index).split("\n").length + 1, corpo });
  }
  return saida;
}

function achados(texto: string, arquivo: string): string[] {
  const out: string[] = [];
  for (const b of blocosDeFluxo(texto)) {
    b.corpo.split("\n").forEach((l, i) => {
      if (ROTULO_SEM_ASPAS_COM_PARENTESE.test(l)) out.push(`${arquivo}:${b.linha + i}: ${l.trim()}`);
    });
  }
  return out;
}

describe("Mermaid: rótulo com parêntese vai entre aspas", () => {
  it("a regra pega o caso quebrado e deixa passar o certo", () => {
    expect(achados("```mermaid\nflowchart LR\n  P[CRM ALQUIM(IA)<br/>x]\n```\n", "a.md")).toHaveLength(1);
    expect(achados('```mermaid\nflowchart LR\n  P["CRM ALQUIM(IA)<br/>x"]\n```\n', "a.md")).toEqual([]);
    expect(achados("```mermaid\ngraph TD\n  A(redondo) --> B[sem parêntese]\n```\n", "a.md")).toEqual([]);
    // fora de flowchart (erDiagram, sequenceDiagram) a sintaxe é outra e não entra
    expect(achados("```mermaid\nerDiagram\n  T {\n    text[] tags \"x (y)\"\n  }\n```\n", "a.md")).toEqual([]);
  });

  it("nenhum diagrama de fluxo dos .md do repositório tem rótulo assim", () => {
    const arquivos = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const tudo = arquivos.flatMap((a) => achados(readFileSync(a, "utf8"), a));
    expect(tudo).toEqual([]);
  });
});
