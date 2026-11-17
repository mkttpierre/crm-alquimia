import { describe, expect, it } from "vitest";

import {
  PAINEL_PADRAO_DO_INICIO,
  PAINEIS_DO_INICIO,
  ehPainelDoInicio,
  nomeDoCookieDoPainel,
  painelEscolhido,
  podeDefinirMeta,
  podeVerPainelDeVendas,
} from "./painel";

const quem = (role: string | null, extra: Partial<{ isPlatformAdmin: boolean; emSuporte: boolean }> = {}) => ({
  role,
  isPlatformAdmin: false,
  emSuporte: false,
  ...extra,
});

const quemEscreve = (role: string | null, extra: Partial<{ isPlatformAdmin: boolean; escritaBloqueadaPeloSuporte: boolean }> = {}) => ({
  role,
  isPlatformAdmin: false,
  escritaBloqueadaPeloSuporte: false,
  ...extra,
});

describe("quem vê o seletor e o painel de vendas", () => {
  it("⭐ manager e admin veem; viewer, agent e ai_operator não", () => {
    expect(podeVerPainelDeVendas(quem("manager"))).toBe(true);
    expect(podeVerPainelDeVendas(quem("admin"))).toBe(true);
    for (const r of ["viewer", "agent", "ai_operator", "", null, undefined, "papel-inventado"]) {
      expect(podeVerPainelDeVendas(quem(r as string | null))).toBe(false);
    }
  });

  it("platform admin vê, exceto no modo suporte (a mesma régua da tela Faturamento)", () => {
    expect(podeVerPainelDeVendas(quem("viewer", { isPlatformAdmin: true }))).toBe(true);
    expect(podeVerPainelDeVendas(quem("viewer", { isPlatformAdmin: true, emSuporte: true }))).toBe(false);
  });

  it("⭐ só o admin define a meta", () => {
    expect(podeDefinirMeta(quemEscreve("admin"))).toBe(true);
    for (const r of ["manager", "agent", "viewer"]) expect(podeDefinirMeta(quemEscreve(r))).toBe(false);
    expect(podeDefinirMeta(quemEscreve("manager", { isPlatformAdmin: true }))).toBe(true);
  });

  it("⭐ escrita bloqueada pelo suporte (somente leitura, acompanhamento vencido): ninguém define, nem com papel admin", () => {
    expect(podeDefinirMeta(quemEscreve("admin", { escritaBloqueadaPeloSuporte: true }))).toBe(false);
    expect(podeDefinirMeta(quemEscreve("admin", { isPlatformAdmin: true, escritaBloqueadaPeloSuporte: true }))).toBe(false);
    expect(podeDefinirMeta(quemEscreve("manager", { isPlatformAdmin: true, escritaBloqueadaPeloSuporte: true }))).toBe(false);
    expect(podeDefinirMeta(quemEscreve("admin", { escritaBloqueadaPeloSuporte: false }))).toBe(true);
  });
});

describe("qual painel desenhar", () => {
  it("⭐ sem permissão é SEMPRE o de atendimento, mesmo com cookie de vendas (cargo rebaixado ou cookie forjado)", () => {
    expect(painelEscolhido("vendas", false)).toBe("atendimento");
    expect(painelEscolhido("atendimento", false)).toBe("atendimento");
    expect(painelEscolhido(undefined, false)).toBe("atendimento");
  });

  it("com permissão, volta para o último escolhido", () => {
    expect(painelEscolhido("vendas", true)).toBe("vendas");
    expect(painelEscolhido("atendimento", true)).toBe("atendimento");
  });

  it("sem escolha ainda, ou com lixo no cookie, o padrão é o de atendimento", () => {
    for (const lixo of [undefined, null, "", "financeiro", "VENDAS", "__proto__"]) {
      expect(painelEscolhido(lixo, true)).toBe(PAINEL_PADRAO_DO_INICIO);
    }
    expect(PAINEL_PADRAO_DO_INICIO).toBe("atendimento");
  });

  it("os dois painéis conhecidos", () => {
    expect([...PAINEIS_DO_INICIO]).toEqual(["atendimento", "vendas"]);
    expect(ehPainelDoInicio("vendas")).toBe(true);
    expect(ehPainelDoInicio("outro")).toBe(false);
    expect(ehPainelDoInicio(1)).toBe(false);
  });
});

describe("o cookie é da pessoa", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("o nome leva o id: quem divide o navegador não herda a escolha do outro", () => {
    expect(nomeDoCookieDoPainel(A)).toBe(`inicio_painel_${A}`);
    expect(nomeDoCookieDoPainel(A)).not.toBe(nomeDoCookieDoPainel(B));
  });

  it("id que não é uuid não vira nome de cookie", () => {
    for (const ruim of ["", "abc", "x; Path=/", `${A}\n`, "../../etc"]) {
      expect(nomeDoCookieDoPainel(ruim)).toBeNull();
    }
  });
});
