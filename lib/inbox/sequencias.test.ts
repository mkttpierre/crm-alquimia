import { describe, expect, it } from "vitest";

import { atalhoDoComando, duracaoEmTexto } from "./sequencias";

describe("atalhoDoComando", () => {
  it("o texto inteiro `/funil-valores` é o comando do atalho funil-valores", () => {
    expect(atalhoDoComando("  /Funil-Valores ")).toBe("funil-valores");
  });

  it("frase com espaço não é comando", () => {
    expect(atalhoDoComando("/funil-valores agora")).toBeNull();
  });

  it("texto sem barra não é comando", () => {
    expect(atalhoDoComando("valores")).toBeNull();
  });
});

describe("duracaoEmTexto", () => {
  it("abaixo de 1 min em segundos; até 5 min com minutos e segundos", () => {
    expect(duracaoEmTexto(45)).toBe("45 s");
    expect(duracaoEmTexto(84)).toBe("~1 min 24 s");
  });
});
