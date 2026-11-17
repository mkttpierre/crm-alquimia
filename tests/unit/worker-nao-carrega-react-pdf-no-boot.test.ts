import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * O WORKER NÃO PODE CARREGAR O @react-pdf NO ARRANQUE.
 *
 * `register-handlers` importa `workers/lgpd-export-worker`, que importava
 * `@/lib/lgpd/pdf-renderer` (e por ele `@react-pdf/renderer`) de forma estática.
 * Rodando sob `tsx` (o worker local), o arquivo é CJS: o `require` cai em
 * `@react-pdf/textkit`, que faz `require('@react-pdf/hyphenate/en-us')`, e o
 * hyphenate só exporta a condição `import`. Resultado, medido em 26/10/2026:
 * "Package subpath './en-us' is not defined by exports" e `event-log drain OFF`.
 * O PDF só é usado ao exportar dados de LGPD, então entra por `import()` dinâmico
 * (que usa a condição `import`) no momento do uso.
 */
describe("worker de exportação LGPD", () => {
  const fonte = readFileSync("workers/lgpd-export-worker.ts", "utf8");

  it("não importa o renderizador de PDF de forma estática", () => {
    expect(fonte).not.toMatch(/^import[^;]*pdf-renderer/m);
  });

  it("carrega o renderizador por import() dinâmico, no uso", () => {
    expect(fonte).toMatch(/await import\(["']@\/lib\/lgpd\/pdf-renderer["']\)/);
  });
});
