import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O layout de `/app` entrega a personalização da barra à casca (`activeOrg.barra`).
 * Três coisas dele não se veem em teste de componente e se perderiam em silêncio, então
 * se prendem no fonte, como `idioma-da-interface.test.ts` faz com a barra:
 *
 *  1. a leitura roda EM PARALELO com a do `orgRow` (uma consulta a mais, em série,
 *     custaria uma ida ao banco em toda navegação);
 *  2. em modo suporte NÃO se passa o id da pessoa (não há vínculo próprio), mas os
 *     nomes da organização continuam sendo lidos — por isso o resultado vale também
 *     em suporte;
 *  3. o resultado desce pelo `activeOrg.barra`, sem condição de suporte.
 */
const layout = readFileSync("app/app/layout.tsx", "utf8");

describe("app/app/layout.tsx e a barra personalizada", () => {
  it("lê a personalização junto com o orgRow, num Promise.all", () => {
    expect(layout).toMatch(
      /Promise\.all\(\[[\s\S]*?\.from\("organizations"\)[\s\S]*?carregarPersonalizacaoDaBarra\([\s\S]*?\]\)/,
    );
  });

  it("em suporte passa userId nulo, e não pula a leitura dos nomes", () => {
    expect(layout).toMatch(
      /carregarPersonalizacaoDaBarra\(\s*user\.support \? null : user\.id,\s*activeOrg\.orgId/,
    );
    expect(layout).not.toMatch(
      /if \(!user\.support\) \{[\s\S]{0,200}carregarPersonalizacaoDaBarra/,
    );
  });

  it("entrega o resultado em activeOrg.barra", () => {
    expect(layout).toMatch(/activeOrg = \{ \.\.\.activeOrg, barra/);
  });
});
