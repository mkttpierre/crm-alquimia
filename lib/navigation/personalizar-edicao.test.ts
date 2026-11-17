import { describe, expect, it } from "vitest";

import {
  alternarOculto,
  moverEntreVisiveis,
  moverParaOLugarDe,
  montarNomes,
  montarPreferencias,
  preservadosDaPersonalizacao,
} from "./personalizar-edicao";
import { CHAVE_TRAVADA, LIMITE_DE_CHAVES } from "./personalizar";

const l = (chave: string, oculto = false) => ({ chave, oculto, fixo: chave === CHAVE_TRAVADA });
const chaves = (itens: { chave: string }[]) => itens.map((i) => i.chave);

describe("alternarOculto", () => {
  it("liga e desliga o oculto de uma linha, em qualquer bloco", () => {
    const blocos = [
      { id: "a", itens: [l("/app/a"), l("/app/b")] },
      { id: "b", itens: [l("/app/c")] },
    ];
    const um = alternarOculto(blocos, "/app/c");
    expect(um[1]!.itens[0]!.oculto).toBe(true);
    expect(alternarOculto(um, "/app/c")[1]!.itens[0]!.oculto).toBe(false);
    // não muta a entrada
    expect(blocos[1]!.itens[0]!.oculto).toBe(false);
  });

  it("Configurações nunca é ocultada", () => {
    const blocos = [{ id: "g", itens: [l("/app/a"), l(CHAVE_TRAVADA)] }];
    expect(alternarOculto(blocos, CHAVE_TRAVADA)[0]!.itens[1]!.oculto).toBe(false);
  });
});

describe("moverEntreVisiveis", () => {
  it("pula a linha oculta: sobe para cima da visível anterior", () => {
    const itens = [l("/app/a"), l("/app/h", true), l("/app/b")];
    // b sobe uma posição entre as VISÍVEIS: passa a vir antes de a; h fica no slot dele
    expect(chaves(moverEntreVisiveis(itens, "/app/b", -1))).toEqual(["/app/b", "/app/h", "/app/a"]);
  });

  it("não passa de Configurações, que fica por último", () => {
    const itens = [l("/app/a"), l("/app/b"), l(CHAVE_TRAVADA)];
    expect(chaves(moverEntreVisiveis(itens, "/app/b", 1))).toEqual(chaves(itens));
    expect(chaves(moverEntreVisiveis(itens, CHAVE_TRAVADA, -1))).toEqual(chaves(itens));
  });

  it("nas pontas não faz nada", () => {
    const itens = [l("/app/a"), l("/app/b")];
    expect(chaves(moverEntreVisiveis(itens, "/app/a", -1))).toEqual(["/app/a", "/app/b"]);
  });
});

describe("moverParaOLugarDe (arrastar)", () => {
  const base = [l("/app/a"), l("/app/b"), l("/app/h", true), l("/app/c"), l(CHAVE_TRAVADA)];

  it("arrastar para baixo assume o lugar do alvo", () => {
    expect(chaves(moverParaOLugarDe(base, "/app/a", "/app/c"))).toEqual([
      "/app/b",
      "/app/c",
      "/app/h",
      "/app/a",
      CHAVE_TRAVADA,
    ]);
  });

  it("arrastar para cima assume o lugar do alvo", () => {
    expect(chaves(moverParaOLugarDe(base, "/app/c", "/app/a"))).toEqual([
      "/app/c",
      "/app/a",
      "/app/h",
      "/app/b",
      CHAVE_TRAVADA,
    ]);
  });

  it("soltar sobre Configurações põe a linha logo antes dela, nunca depois", () => {
    expect(chaves(moverParaOLugarDe(base, "/app/a", CHAVE_TRAVADA))).toEqual([
      "/app/b",
      "/app/c",
      "/app/h",
      "/app/a",
      CHAVE_TRAVADA,
    ]);
  });

  it("Configurações não é arrastada, soltar em si mesmo não muda nada, chave desconhecida é ignorada", () => {
    expect(chaves(moverParaOLugarDe(base, CHAVE_TRAVADA, "/app/a"))).toEqual(chaves(base));
    expect(chaves(moverParaOLugarDe(base, "/app/a", "/app/a"))).toEqual(chaves(base));
    expect(chaves(moverParaOLugarDe(base, "/app/zzz", "/app/a"))).toEqual(chaves(base));
    expect(chaves(moverParaOLugarDe(base, "/app/a", "/app/h"))).toEqual(chaves(base));
  });
});

describe("montarPreferencias", () => {
  it("junta ocultos e ordem da tela com o que estava gravado e não aparece agora", () => {
    const p = montarPreferencias(
      [
        { id: "a", itens: [l("/app/a"), l("/app/b", true)] },
        { id: "b", itens: [l("/app/c"), l(CHAVE_TRAVADA)] },
      ],
      { ocultos: ["/app/x"], ordem: ["/app/x"] },
    );
    expect(p.ocultos).toEqual(["/app/b", "/app/x"]);
    expect(p.ordem).toEqual(["/app/a", "/app/b", "/app/c", CHAVE_TRAVADA, "/app/x"]);
  });

  it("respeita o limite de chaves do banco", () => {
    const muitos = Array.from({ length: LIMITE_DE_CHAVES + 20 }, (_, i) => l(`/app/k${i}`));
    const p = montarPreferencias([{ id: "a", itens: muitos }], { ocultos: [], ordem: [] });
    expect(p.ordem).toHaveLength(LIMITE_DE_CHAVES);
  });
});

describe("montarNomes", () => {
  it("só grava nome não vazio e mantém os nomes preservados", () => {
    expect(
      montarNomes(
        [
          { chave: "/app/a", nome: "  Conversas " },
          { chave: "/app/b", nome: "" },
        ],
        { "/app/x": "Velho" },
      ),
    ).toEqual({ "/app/x": "Velho", "/app/a": "Conversas" });
  });
});

describe("preservadosDaPersonalizacao", () => {
  it("guarda o gravado que a tela não lista, e descarta chave que saiu do catálogo", () => {
    const r = preservadosDaPersonalizacao(
      {
        preferencias: {
          // /app/products existe no catálogo mas não está na lista (interface restrita);
          // /app/morto não existe mais; /app/leads está listado
          ocultos: ["/app/products", "/app/morto", "/app/leads"],
          ordem: ["/app/products", "/app/morto", "/app/leads"],
        },
        nomes: { "/app/products": "Loja", "/app/leads": "Pessoas" },
      },
      new Set(["/app/leads"]),
    );
    expect(r.preferencias).toEqual({ ocultos: ["/app/products"], ordem: ["/app/products"] });
    expect(r.nomes).toEqual({ "/app/products": "Loja" });
  });

  it("sem nada gravado, nada a preservar", () => {
    expect(preservadosDaPersonalizacao(undefined, new Set())).toEqual({
      preferencias: { ocultos: [], ordem: [] },
      nomes: {},
    });
  });
});
