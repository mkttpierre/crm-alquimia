import { describe, expect, it } from "vitest";
import { selecionarLeads } from "./selecionar-leads";

describe("seleção de leads", () => {
  it("filtra antes de paginar e ordena o total entre todos os contatos", () => {
    const linhas = [
      { id: "a", nome: "Ana", telefone: "", tags: ["vip"], tipo: "pessoa" as const, pipelines: ["p"], total: 100, compras: 1, ciclo: null, ultima: "2026-01-02" },
      { id: "b", nome: "Bia", telefone: "", tags: ["vip"], tipo: "pessoa" as const, pipelines: ["p"], total: 300, compras: 1, ciclo: null, ultima: "2026-02-02" },
      { id: "c", nome: "Caio", telefone: "", tags: [], tipo: "pessoa" as const, pipelines: [], total: 500, compras: 0, ciclo: null, ultima: null },
    ];
    const resultado = selecionarLeads(linhas, { tag: "vip", pipeline: "p", de: "2026-01-01", ate: "2026-12-31", ordem: "total", direcao: "desc", pagina: 1, limite: 1 });
    expect(resultado.total).toBe(2);
    expect(resultado.linhas.map((l) => l.id)).toEqual(["b"]);
  });
});
