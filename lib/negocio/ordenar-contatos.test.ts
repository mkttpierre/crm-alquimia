import { describe, expect, it } from "vitest";
import { ordenarContatos } from "./ordenar-contatos";

describe("ordenacao da tabela", () => {
  it("ordena numeros como numeros e mantem valores ausentes ao final em ambos os sentidos", () => {
    const rows = [{ nome: "C", ciclo: null }, { nome: "B", ciclo: 10 }, { nome: "A", ciclo: 2 }];
    expect(ordenarContatos(rows, "ciclo", "asc").map((r) => r.nome)).toEqual(["A", "B", "C"]);
    expect(ordenarContatos(rows, "ciclo", "desc").map((r) => r.nome)).toEqual(["B", "A", "C"]);
    expect(rows.map((r) => r.nome)).toEqual(["C", "B", "A"]);
  });
  it("ordena nomes considerando acentos e caixa", () => {
    expect(ordenarContatos([{ nome: "Z\u00e9lia" }, { nome: "\u00e1Lvaro" }], "nome", "asc").map((r) => r.nome)).toEqual(["\u00e1Lvaro", "Z\u00e9lia"]);
  });
});
