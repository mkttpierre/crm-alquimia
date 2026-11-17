import { describe, expect, it } from "vitest";

import { cssDaFonteDaOrganizacao, familiaDaOrganizacaoDeSettings } from "@/lib/branding/fonte";

describe("fonte da organização (settings.tipografia)", () => {
  it("reconhece a família da lista fechada, sem se importar com caixa/espaço", () => {
    expect(familiaDaOrganizacaoDeSettings({ tipografia: { familia: "inter" } })).toBe("inter");
    expect(familiaDaOrganizacaoDeSettings({ tipografia: { familia: "  Inter " } })).toBe("inter");
  });

  it("nunca lança e cai em null diante de qualquer forma estranha", () => {
    for (const s of [null, undefined, 3, "x", [], {}, { tipografia: null }, { tipografia: [] }, { tipografia: { familia: 7 } }]) {
      expect(familiaDaOrganizacaoDeSettings(s)).toBeNull();
    }
  });

  it("recusa família fora da lista (valor do banco nunca vira CSS)", () => {
    expect(familiaDaOrganizacaoDeSettings({ tipografia: { familia: "Comic Sans" } })).toBeNull();
    expect(familiaDaOrganizacaoDeSettings({ tipografia: { familia: "__proto__" } })).toBeNull();
    expect(familiaDaOrganizacaoDeSettings({ tipografia: { familia: "inter}</style>" } })).toBeNull();
  });

  it("não é afetada por branding (a tela de marca substitui branding inteiro)", () => {
    expect(familiaDaOrganizacaoDeSettings({ branding: { accent_hex: "#b83b66" } })).toBeNull();
  });

  it("emite CSS só dentro do marcador da organização, ou nada", () => {
    expect(cssDaFonteDaOrganizacao(null)).toBeNull();
    const css = cssDaFonteDaOrganizacao("inter");
    expect(css).toContain("body:has([data-marca-org])");
    expect(css).toContain("--font-sans: var(--font-inter)");
    expect(css).toContain("font-family: var(--font-inter)");
  });
});
