// @vitest-environment node
/**
 * O que é "parte seguinte da mesma sequência": o laço do motor só segue partes AGENDADAS JUNTAS para o MESMO lead
 * (sequência do operador, resposta/funil do atendimento, partes de um toque do kit). A abertura fria e os toques entre
 * dias NÃO são sequência: seguem o ritmo do chip.
 */
import { describe, expect, it } from "vitest";

import { ehParteSeguinte, JANELA_DA_DECISAO_MS, temPartesSeguintes, tipoBaseDaParte } from "./sequencia-partes";
import type { EnvioDaFila } from "./motor";

const T = new Date("2026-10-23T12:00:00-03:00");
const envio = (p: Partial<EnvioDaFila>): EnvioDaFila => ({
  id: "x", leadId: "l1", chipId: "chip-1", tipo: "tabela_valores:seq", origem: "auto", texto: "t", midia: null, midiaId: null,
  enviarApos: T, estado: "pendente", tentativas: 0, criadoEm: T, daParada: false, ...p,
});

describe("tipoBaseDaParte", () => {
  it("tira o sufixo _pN das partes seguintes de um toque", () => {
    expect(tipoBaseDaParte("kit_t1_261023120000_p2")).toBe("kit_t1_261023120000");
    expect(tipoBaseDaParte("kit_t1_261023120000")).toBe("kit_t1_261023120000");
    expect(tipoBaseDaParte("funil_valores:3")).toBe("funil_valores:3");
  });
});

describe("temPartesSeguintes: depois de qual envio vale tentar seguir?", () => {
  it.each([
    ["operador", "funil_valores:1", true],
    ["auto", "tabela_valores:seq", true],
    ["motor", "kit_t1_261023120000", true],
    ["motor", "kit_t1_261023120000_p2", true],
    ["motor", "metodo_oferta_261023120000", true],
    ["motor", "metodo_d7", true],
    ["motor", "metodo_d14_p3", true],
    ["motor", "abertura", true],
    ["motor", "toque_2", false],
    ["motor", "toque_3", false],
    ["lembrete", "d4", false],
  ] as const)("%s / %s -> %s", (origem, tipo, esperado) => {
    expect(temPartesSeguintes(envio({ origem, tipo }))).toBe(esperado);
  });
});

describe("ehParteSeguinte", () => {
  it("segue as partes da abertura do mesmo lead", () => {
    const abertura = envio({ id: "a", origem: "motor", tipo: "abertura" });
    const p2 = envio({ id: "b", origem: "motor", tipo: "abertura_p2" });
    const p3 = envio({ id: "c", origem: "motor", tipo: "abertura_p3" });
    expect(ehParteSeguinte(abertura, p2)).toBe(true);
    expect(ehParteSeguinte(p2, p3)).toBe(true);
    expect(ehParteSeguinte(abertura, { ...p2, leadId: "outro" })).toBe(false);
    expect(ehParteSeguinte(abertura, envio({ id: "d", origem: "motor", tipo: "toque_2" }))).toBe(false);
  });
  it("operador: qualquer outra parte pendente do mesmo lead", () => {
    const ref = envio({ id: "a", origem: "operador", tipo: "funil_valores:1" });
    expect(ehParteSeguinte(ref, envio({ id: "b", origem: "operador", tipo: "funil_valores:2" }))).toBe(true);
    expect(ehParteSeguinte(ref, envio({ id: "b", origem: "operador", tipo: "funil_valores:2", leadId: "l2" }))).toBe(false);
    expect(ehParteSeguinte(ref, envio({ id: "b", origem: "auto", tipo: "funil_valores:2" }))).toBe(false);
    expect(ehParteSeguinte(ref, ref)).toBe(false);
  });

  it("auto: só o que foi decidido junto (criado a menos de 10 s), não a decisão seguinte", () => {
    const ref = envio({ id: "a", criadoEm: T });
    expect(ehParteSeguinte(ref, envio({ id: "b", tipo: "tabela_valores:seq", criadoEm: new Date(T.getTime() + 50) }))).toBe(true);
    expect(ehParteSeguinte(ref, envio({ id: "b", tipo: "outra:seq", criadoEm: new Date(T.getTime() + JANELA_DA_DECISAO_MS - 1) }))).toBe(true);
    expect(ehParteSeguinte(ref, envio({ id: "b", criadoEm: new Date(T.getTime() + JANELA_DA_DECISAO_MS + 1) }))).toBe(false);
  });

  it("motor: só as partes _pN do MESMO toque; nunca outro toque, outro dia ou a abertura", () => {
    const ref = envio({ id: "a", origem: "motor", tipo: "kit_t1_261023120000" });
    expect(ehParteSeguinte(ref, envio({ id: "b", origem: "motor", tipo: "kit_t1_261023120000_p2" }))).toBe(true);
    expect(ehParteSeguinte(ref, envio({ id: "b", origem: "motor", tipo: "kit_t2_261023120000" }))).toBe(false);
    expect(ehParteSeguinte(ref, envio({ id: "b", origem: "motor", tipo: "kit_t2_261023120000_p2" }))).toBe(false);
    expect(ehParteSeguinte(ref, envio({ id: "b", origem: "motor", tipo: "metodo_oferta_261023120000" }))).toBe(false);
    expect(ehParteSeguinte(envio({ id: "p2", origem: "motor", tipo: "kit_t1_261023120000_p2" }), envio({ id: "p3", origem: "motor", tipo: "kit_t1_261023120000_p3" }))).toBe(true);
  });
});
