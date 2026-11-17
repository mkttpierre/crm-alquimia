/**
 * Tag de origem automática: só com origem comprovada, nunca genérica, nunca
 * remove. Sem regra da organização, não sai tag.
 */
import { describe, expect, it } from "vitest";

import { lerRegrasDeOrigem, tagsDeOrigem, type RegrasDeOrigem } from "@/lib/leads/tag-de-origem";

const regras: RegrasDeOrigem = {
  produtos: ["alfa", "beta", "gama", "delta"],
  por_fonte: { import_planilha: "ORIGEM FRIA" },
};
const VAZIAS: RegrasDeOrigem = { produtos: [], por_fonte: {} };

const casos: Array<[string, Parameters<typeof tagsDeOrigem>[0], RegrasDeOrigem, string[]]> = [
  ["comprou=true com produto", { custom_fields: { produto_origem: "Alfa", comprou: true } }, regras, ["COMPROU ALFA"]],
  ["comprou='sim'", { custom_fields: { produto_origem: "beta", comprou: "sim" } }, regras, ["COMPROU BETA"]],
  ["comprou='true'", { custom_fields: { produto_origem: "gama", comprou: "true" } }, regras, ["COMPROU GAMA"]],
  ["comprou=false vira LEAD", { custom_fields: { produto_origem: "delta", comprou: false } }, regras, ["LEAD DELTA"]],
  ["comprou='não' vira LEAD", { custom_fields: { produto_origem: "delta", comprou: "não" } }, regras, ["LEAD DELTA"]],
  ["produto fora da lista: nada", { custom_fields: { produto_origem: "OUTRO", comprou: true } }, regras, []],
  ["lixo de planilha: nada", { custom_fields: { produto_origem: "Pago", comprou: true } }, regras, []],
  ["comprou sem valor claro: nada", { custom_fields: { produto_origem: "alfa", comprou: "talvez" } }, regras, []],
  ["sem comprou: nada", { custom_fields: { produto_origem: "alfa" } }, regras, []],
  ["sem produto: nada", { custom_fields: { comprou: true } }, regras, []],
  ["tag Pago sem charge back", { tags: ["Pago"] }, regras, ["COMPROU"]],
  ["tag Pago com charge back: nada", { tags: ["pago", "CHARGE BACK"] }, regras, []],
  ["tag PAGO BETA", { tags: ["PAGO BETA"] }, regras, ["COMPROU BETA"]],
  ["tag pago de produto desconhecido: nada", { tags: ["pago xyz"] }, regras, []],
  ["fonte mapeada", { source: "import_planilha" }, regras, ["ORIGEM FRIA"]],
  ["fonte não mapeada: nada", { source: "whatsapp" }, regras, []],
  ["sem repetir tag existente", { source: "import_planilha", tags: ["origem fria"] }, regras, []],
  ["regras vazias: nada", { source: "import_planilha", custom_fields: { produto_origem: "alfa", comprou: true }, tags: ["Pago"] }, VAZIAS, []],
  ["custom_fields malformado: nada", { custom_fields: "x" as unknown as Record<string, unknown> }, regras, []],
];

describe("tagsDeOrigem", () => {
  it.each(casos)("%s", (_nome, lead, r, esperado) => {
    expect(tagsDeOrigem(lead, r)).toEqual(esperado);
  });

  it("combina fonte e compra sem duplicar", () => {
    expect(
      tagsDeOrigem(
        { source: "import_planilha", custom_fields: { produto_origem: "alfa", comprou: true }, tags: ["Pago"] },
        regras,
      ),
    ).toEqual(["ORIGEM FRIA", "COMPROU ALFA"]);
  });
});

describe("lerRegrasDeOrigem", () => {
  it.each([[undefined], [null], ["x"], [{}], [{ origem: 3 }], [{ origem: { produtos: "a", por_fonte: [] } }]])(
    "setting malformado vira regras vazias (%j)",
    (s) => {
      expect(lerRegrasDeOrigem(s)).toEqual({ produtos: [], por_fonte: {} });
    },
  );

  it("lê regras válidas", () => {
    expect(lerRegrasDeOrigem({ origem: { produtos: ["a"], por_fonte: { x: "Y" } } })).toEqual({
      produtos: ["a"],
      por_fonte: { x: "Y" },
    });
  });
});

import { produtosComprados } from "@/lib/leads/tag-de-origem";

describe("produtosComprados", () => {
  it("deriva das tags COMPROU <P>, ignora a COMPROU solta e as outras", () => {
    expect(produtosComprados(["quente", "COMPROU ALFA", "comprou beta", "COMPROU", "LEAD GAMA"])).toEqual(["ALFA", "BETA"]);
  });
  it("sem tag de compra, vazio", () => {
    expect(produtosComprados(undefined)).toEqual([]);
  });
});
