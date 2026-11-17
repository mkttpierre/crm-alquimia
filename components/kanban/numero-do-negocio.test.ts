import { describe, it, expect } from "vitest";
import { numeroDoNegocio } from "./numero-do-negocio";

describe("número do negócio", () => {
  it("mostra os seis primeiros caracteres do id em maiúsculas", () => {
    expect(numeroDoNegocio("ab12cd34-5678")).toBe("#AB12CD");
  });
});
