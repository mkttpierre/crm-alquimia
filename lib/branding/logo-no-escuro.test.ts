import { describe, expect, it } from "vitest";

import { clarearEscritaEscura, ehEscritaEscura } from "./logo-no-escuro";

function pixels(...lista: [number, number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(lista.flat());
}

describe("logo próprio sobre a barra preta", () => {
  it("escrita preta e grafite viram branco, mantendo a transparência da borda", () => {
    const rgba = pixels([0, 0, 0, 255], [17, 17, 17, 128], [60, 58, 62, 255]);
    expect(clarearEscritaEscura(rgba)).toBe(3);
    expect([...rgba]).toEqual([255, 255, 255, 255, 255, 255, 255, 128, 255, 255, 255, 255]);
  });

  it("as cores da marca ficam como vieram (rosa e dourado de dois logos reais)", () => {
    // #b83b66 e #e8b84a: um rosa e um dourado de logos reais.
    expect(ehEscritaEscura(0xb8, 0x3b, 0x66)).toBe(false);
    expect(ehEscritaEscura(0xe8, 0xb8, 0x4a)).toBe(false);
    // Vinho escuro também é cor: diferença entre canais grande demais para "neutro".
    expect(ehEscritaEscura(110, 20, 40)).toBe(false);
  });

  it("branco, cinza claro e pixel transparente não mudam", () => {
    const rgba = pixels([255, 255, 255, 255], [200, 200, 200, 255], [0, 0, 0, 0]);
    expect(clarearEscritaEscura(rgba)).toBe(0);
    expect([...rgba]).toEqual([255, 255, 255, 255, 200, 200, 200, 255, 0, 0, 0, 0]);
  });
});

describe("logo com fundo claro chapado (15/11/2026)", () => {
  it("não troca nada: a escrita branca sumiria no fundo branco do próprio arquivo", () => {
    // JPG ou PNG sem transparência: 8 pixels de fundo branco opaco, 2 de escrita preta.
    const rgba = pixels(
      ...Array.from({ length: 8 }, () => [255, 255, 255, 255] as [number, number, number, number]),
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    );
    expect(clarearEscritaEscura(rgba)).toBe(0);
    expect(rgba[32]).toBe(0);
  });
});
