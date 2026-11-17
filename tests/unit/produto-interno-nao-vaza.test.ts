import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PRODUTO INTERNO NÃO VAZA (migration 0251).
 *
 * O preço de um plano `so_interno` é a COMISSÃO do operador. Ele nunca pode chegar à IA, ao MCP, a uma fonte de
 * conhecimento, à loja nem ao lead. Esta varredura é a cerca contra o leitor NOVO: qualquer arquivo de código que leia
 * `catalog_products` e não esteja na lista de telas/rotas do operador precisa, no mínimo, citar `so_interno` (o filtro).
 * Leitor novo sem o filtro reprova aqui, antes de o preço chegar a um cliente.
 *
 * Também vigia o outro caminho: as linhas de produto de um negócio (`crm_lead_items`, que guardam o mesmo preço de
 * comissão como snapshot) não podem ser lidas por código do agente de IA, do MCP ou dos workers.
 */

const RAIZ = process.cwd();
const PASTAS = ["lib", "app", "workers", "hooks", "components"];
const IGNORAR = new Set(["node_modules", ".next", ".next-anterior", ".alethe", ".git"]);

function arquivos(dir: string, saida: string[] = []): string[] {
  let nomes: string[];
  try {
    nomes = readdirSync(dir);
  } catch {
    return saida;
  }
  for (const nome of nomes) {
    if (IGNORAR.has(nome)) continue;
    const caminho = join(dir, nome);
    const st = statSync(caminho);
    if (st.isDirectory()) arquivos(caminho, saida);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.(ts|tsx)$/.test(nome) && nome !== "database.types.ts") saida.push(caminho);
  }
  return saida;
}

const todos = PASTAS.flatMap((p) => arquivos(join(RAIZ, p))).map((f) => ({
  caminho: relative(RAIZ, f).split(sep).join("/"),
  texto: readFileSync(f, "utf8"),
}));

/** Telas e rotas do OPERADOR (sessão humana com papel). Entregam o catálogo inteiro de propósito: é onde se cadastra. */
const LEITORES_DO_OPERADOR = new Set([
  "app/api/v1/products/route.ts",
  "app/api/v1/products/[id]/route.ts",
  "app/api/v1/products/import/route.ts",
  "app/app/products/page.tsx",
  "lib/negocio/repositorio-itens.ts",
  // Tag de compra depois de "Registrar venda" (16/11/2026): lê só `nome` (nunca
  // preço) dos produtos da venda que o operador acabou de registrar, e a tag
  // gravada leva só a chave de `settings.origem.produtos` (ex.: GAMA) ou
  // "COMPROU" — o nome do produto interno não sai do banco.
  "lib/negocio/tag-de-compra.ts",
]);

const LE_CATALOGO = /from\(\s*["']catalog_products["']\s*\)|\b(?:from|join)\s+(?:public\.)?catalog_products\b/i;

describe("produto interno não vaza", () => {
  it("a varredura enxerga arquivos (controle positivo: não passa por estar cega)", () => {
    expect(todos.length).toBeGreaterThan(200);
    expect(todos.some((a) => a.caminho === "lib/mcp/tools/comercio.ts")).toBe(true);
  });

  it("todo leitor de catalog_products fora das telas do operador filtra so_interno", () => {
    const leitores = todos.filter((a) => LE_CATALOGO.test(a.texto));
    expect(leitores.map((a) => a.caminho)).toContain("lib/mcp/tools/comercio.ts");
    const semFiltro = leitores.filter((a) => !LEITORES_DO_OPERADOR.has(a.caminho) && !a.texto.includes("so_interno")).map((a) => a.caminho);
    expect(semFiltro).toEqual([]);
  });

  it("a ferramenta do MCP filtra so_interno = false na consulta", () => {
    const comercio = todos.find((a) => a.caminho === "lib/mcp/tools/comercio.ts")!;
    expect(comercio.texto).toMatch(/\.eq\(\s*["']so_interno["']\s*,\s*false\s*\)/);
  });

  it("a lista do operador não esconde um leitor que sumiu ou mudou de lugar", () => {
    const existentes = new Set(todos.map((a) => a.caminho));
    for (const caminho of LEITORES_DO_OPERADOR) expect(existentes.has(caminho), caminho).toBe(true);
  });

  it("nenhum código de IA, MCP ou worker lê as linhas de produto do negócio nem registra venda", () => {
    const proibidos = todos.filter(
      (a) => /^(lib\/mcp|lib\/agent-engine|lib\/ai|workers)\//.test(a.caminho) && /crm_lead_items|fn_registrar_venda|fn_escolher_negocio_da_venda/.test(a.texto),
    );
    expect(proibidos.map((a) => a.caminho)).toEqual([]);
  });
});
