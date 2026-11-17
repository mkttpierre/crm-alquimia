// @vitest-environment node
/**
 * O cookie de sessão tem UM nome, fixo nos três lugares que o leem ou gravam:
 * o cliente do navegador, o cliente do servidor e o `proxy.ts` (middleware).
 *
 * Se um dos três divergir, o login "funciona" e logo depois quebra: o servidor
 * grava a sessão num nome e o middleware procura noutro, e quem acabou de entrar
 * é mandado de volta ao `/login` sem erro nenhum. A comparação é pela fonte,
 * porque nenhum dos três exporta o nome para os outros importarem.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const NOME = "sb-crm-alquimia-auth";

/** Os nomes de cookie `sb-…-auth` citados como literal de string no arquivo. */
function nomesNoArquivo(rel: string): string[] {
  const fonte = readFileSync(path.join(RAIZ, rel), "utf8");
  return [...fonte.matchAll(/["'`](sb-[a-z0-9-]+-auth)["'`]/g)].map((m) => m[1]!);
}

describe("cookie de sessão: um nome só", () => {
  const LUGARES = ["lib/supabase/browser.ts", "lib/supabase/server.ts", "proxy.ts"];

  for (const rel of LUGARES) {
    it(`${rel} fixa ${NOME}, e só ele`, () => {
      const nomes = nomesNoArquivo(rel);
      expect(nomes.length, `${rel} deixou de fixar o nome do cookie`).toBeGreaterThan(0);
      expect(new Set(nomes)).toEqual(new Set([NOME]));
    });
  }

  it("os três lugares concordam entre si", () => {
    const todos = new Set(LUGARES.flatMap(nomesNoArquivo));
    expect([...todos]).toEqual([NOME]);
  });
});
