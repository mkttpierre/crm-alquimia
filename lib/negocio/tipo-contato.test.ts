import { describe, expect, it } from "vitest";
import { tipoContato } from "./tipo-contato";

describe("tipo de contato", () => {
  it("identifica empresa pelas chaves reconhecidas com valor preenchido", () => {
    for (const chave of ["empresa", "company", "cnpj", "razao_social"]) {
      expect(tipoContato({ [chave]: " ACME " })).toBe("empresa");
    }
    expect(tipoContato({ empresa: "  ", company: null })).toBe("pessoa");
    expect(tipoContato(null)).toBe("pessoa");
  });
});
