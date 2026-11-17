// @vitest-environment node
/**
 * Ritmo humano entre as partes de QUALQUER resposta do atendimento: 3 s depois de texto ou imagem,
 * 29 a 34 s depois de áudio (sorteado). Antes: texto 8-40 s, imagem 12-32 s, áudio = duração + 8 s.
 */
import { describe, expect, it } from "vitest";

import { montarPartes, pausaApos } from "./pecas";

const LEAD = { id: "l1", nome: "Maria", telefone: "+5511999990000" } as never;
const ctx = (sortear?: () => number) => ({ lead: LEAD, agora: new Date("2026-10-23T15:00:00Z"), fusoMinutos: -180, proibidos: [], sortear });

const audio = { texto: "", midia: { id: "a", nome: "AUDIO.opus", segundos: 64 } };
const imagem = { texto: "Tabela 👇", midia: { id: "i", nome: "tabela.jpg" } };
const texto = (t: string) => ({ texto: t, midia: null });

describe("pausaApos (segundos entre uma parte e a seguinte)", () => {
  it("texto e imagem: 3 s, qualquer que seja o tamanho do texto", () => {
    expect(pausaApos(texto("oi"), () => 0.5)).toBe(3);
    expect(pausaApos(texto("x".repeat(600)), () => 0.9)).toBe(3);
    expect(pausaApos(imagem, () => 0.1)).toBe(3);
  });

  it("áudio: de 29 a 34 s sorteado, qualquer que seja a duração dele", () => {
    expect(pausaApos(audio, () => 0)).toBe(29);
    expect(pausaApos(audio, () => 0.5)).toBe(31.5);
    expect(pausaApos(audio, () => 0.999)).toBeCloseTo(34, 0);
    expect(pausaApos({ texto: "", midia: { id: "a", nome: "curto.ogg", segundos: 5 } }, () => 0.5)).toBe(31.5);
  });
});

describe("montarPartes grava o ritmo humano em `aposSeg`", () => {
  it("o funil de valores (texto, áudio, texto, imagem, texto): 0, 3, 31,5, 3 e 3 s", () => {
    const m = montarPartes([texto("Vou te explicar"), audio, texto("Preços"), imagem, texto("Recomendo")], ctx(() => 0.5));
    expect(m.ok && m.partes.map((p) => p.aposSeg)).toEqual([0, 3, 31.5, 3, 3]);
  });

  it("áudio com texto vira duas partes e o texto sai 29-34 s depois do áudio", () => {
    const m = montarPartes([{ texto: "Ouviu?", midia: { id: "a", nome: "x.ogg", segundos: 20 } }], ctx(() => 0));
    expect(m.ok && m.partes.map((p) => [p.midia?.nome ?? null, p.texto, p.aposSeg])).toEqual([["x.ogg", "", 0], [null, "Ouviu?", 29]]);
  });

  it("sem `sortear` na chamada ainda sorteia dentro de 29-34 s", () => {
    const m = montarPartes([audio, texto("depois")], ctx());
    const apos = m.ok ? m.partes[1]!.aposSeg : -1;
    expect(apos).toBeGreaterThanOrEqual(29);
    expect(apos).toBeLessThanOrEqual(34);
  });
});
