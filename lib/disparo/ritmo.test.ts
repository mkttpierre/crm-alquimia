// Portado de `um CRM anterior/testes/ritmo.test.ts` (node:test → vitest), com o
// ritmo vindo da config da organização em vez de constante. Uma organização que envia
// num feriado tira a data da lista de feriados no ritmo dela.
import { describe, expect, it } from "vitest";

import { FERIADOS_NACIONAIS, ritmoSchema } from "./config";
import { horaDoPasso, CADENCIAS } from "./cadencia";
import {
  dentroDaJanela,
  horaDeResponder,
  intervaloNova,
  minutosRestantes,
  pausaACada,
  pausaLonga,
  relogio,
  tetoAberturas,
  tetoTotal,
} from "./ritmo";

const REGIME_A = ritmoSchema.parse({ feriados: FERIADOS_NACIONAIS.filter((d) => d !== "2026-10-12") });
const sp = (iso: string) => new Date(`${iso}-03:00`);
const dia = (d: Date) => relogio(d, -180).data;
const sorte = Math.random;

describe("janela de prospecção (padrão do regime A)", () => {
  it("8h-19h sem pausa de almoço, sábado igual, domingo 8h ao meio-dia, sem feriado", () => {
    expect(dentroDaJanela(sp("2026-10-07T10:00:00"), REGIME_A)).toBe(true); // quarta
    expect(dentroDaJanela(sp("2026-10-07T07:59:00"), REGIME_A)).toBe(false);
    expect(dentroDaJanela(sp("2026-10-07T08:00:00"), REGIME_A)).toBe(true);
    expect(dentroDaJanela(sp("2026-10-07T12:30:00"), REGIME_A)).toBe(true); // almoço prospecta
    expect(dentroDaJanela(sp("2026-10-07T18:59:00"), REGIME_A)).toBe(true);
    expect(dentroDaJanela(sp("2026-10-07T19:00:00"), REGIME_A)).toBe(false);
    expect(dentroDaJanela(sp("2026-10-10T15:00:00"), REGIME_A)).toBe(true); // sábado à tarde
    expect(dentroDaJanela(sp("2026-10-11T09:00:00"), REGIME_A)).toBe(true); // domingo de manhã
    expect(dentroDaJanela(sp("2026-10-11T12:00:00"), REGIME_A)).toBe(false); // domingo depois do meio-dia
    expect(dentroDaJanela(sp("2026-10-12T10:00:00"), REGIME_A)).toBe(true); // 12/10 envia (o regime da organização tirou o feriado)
    expect(dentroDaJanela(sp("2026-11-02T10:00:00"), REGIME_A)).toBe(false); // feriado
  });

  it("o padrão do produto (lista nacional completa) não envia em 12/10", () => {
    expect(dentroDaJanela(sp("2026-10-12T10:00:00"), ritmoSchema.parse({}))).toBe(false);
  });

  it("janela com almoço (regime da organização B): bloco interrompido e só dia útil", () => {
    const alq = ritmoSchema.parse({
      janela: { semana: [{ inicio: 480, fim: 720 }, { inicio: 780, fim: 960 }], sabado: [], domingo: [] },
    });
    expect(dentroDaJanela(sp("2026-10-07T12:30:00"), alq)).toBe(false);
    expect(dentroDaJanela(sp("2026-10-07T13:00:00"), alq)).toBe(true);
    expect(dentroDaJanela(sp("2026-10-10T10:00:00"), alq)).toBe(false); // sábado
    expect(minutosRestantes(sp("2026-10-07T11:00:00"), alq)).toBe(60);
  });
});

describe("intervalos e pausa", () => {
  it("intervalo entre mensagens novas nunca abaixo de 10 min, em qualquer dia da rampa", () => {
    for (let i = 0; i < 3000; i++)
      for (const d of [1, 2, 5, 12, 30]) expect(intervaloNova(d, sp("2026-10-07T10:00:00"), REGIME_A, sorte) / 60000).toBeGreaterThanOrEqual(10);
  });

  it("dia 1: 20 a 40 min; dia 2: 15 a 30; domingo: 10 a 13", () => {
    const domingo = sp("2026-10-11T10:00:00");
    const quarta = sp("2026-10-07T10:00:00");
    for (let i = 0; i < 2000; i++) {
      const d1 = intervaloNova(1, quarta, REGIME_A, sorte) / 60000;
      const d2 = intervaloNova(2, quarta, REGIME_A, sorte) / 60000;
      const dom = intervaloNova(5, domingo, REGIME_A, sorte) / 60000;
      expect(d1 >= 20 && d1 <= 40).toBe(true);
      expect(d2 >= 15 && d2 <= 30).toBe(true);
      expect(dom >= 10 && dom <= 13).toBe(true);
    }
  });

  it("limites com a sorte nas pontas (0 e quase 1), não pela média", () => {
    const quarta = sp("2026-10-07T10:00:00");
    const sequencia = (...v: number[]) => () => v.shift() ?? 0.5;
    // Base no mínimo e sem o extra: exatamente o piso.
    expect(intervaloNova(5, quarta, REGIME_A, sequencia(0, 0.9)) / 60000).toBe(10);
    // Base no máximo e sem extra: 18. Com o extra no máximo: 18 + 15.
    expect(intervaloNova(5, quarta, REGIME_A, sequencia(0.999999, 0.9)) / 60000).toBeLessThanOrEqual(18);
    expect(intervaloNova(5, quarta, REGIME_A, sequencia(0.999999, 0, 0.999999)) / 60000).toBeLessThanOrEqual(33);
    // Pausa longa de uma organização (src/lib/ritmo.ts do CRM vivo): 20-40 min a cada 5-9 novas.
    expect(pausaLonga(REGIME_A, () => 0, 5, quarta) / 60000).toBe(20);
    expect(pausaLonga(REGIME_A, () => 0.999999, 5, quarta) / 60000).toBeLessThanOrEqual(40);
    expect(pausaACada(REGIME_A, () => 0, 5, quarta)).toBe(5);
    expect(pausaACada(REGIME_A, () => 0.999999, 5, quarta)).toBe(9);
  });

  it("pausa longa por fase: maduro 15-30 a cada 7-12, domingo 12-20 a cada 10-14", () => {
    const quarta = sp("2026-10-07T10:00:00");
    const domingo = sp("2026-10-11T10:00:00");
    expect(pausaLonga(REGIME_A, () => 0, 12, quarta) / 60000).toBe(15);
    expect(pausaLonga(REGIME_A, () => 0.999999, 12, quarta) / 60000).toBeLessThanOrEqual(30);
    expect(pausaACada(REGIME_A, () => 0, 12, quarta)).toBe(7);
    expect(pausaACada(REGIME_A, () => 0.999999, 12, quarta)).toBe(12);
    // Domingo vence a fase do chip.
    expect(pausaLonga(REGIME_A, () => 0, 12, domingo) / 60000).toBe(12);
    expect(pausaACada(REGIME_A, () => 0, 3, domingo)).toBe(10);
    expect(pausaACada(REGIME_A, () => 0.999999, 3, domingo)).toBe(14);
    // Organização que não diferencia (a organização B): só a faixa comum, em qualquer fase.
    const semFase = ritmoSchema.parse({
      pausa: { min: 15, max: 30 }, pausaACada: { min: 10, max: 15 },
      pausaMaduro: null, pausaACadaMaduro: null, pausaDomingo: null, pausaACadaDomingo: null,
    });
    expect(pausaLonga(semFase, () => 0, 20, domingo) / 60000).toBe(15);
    expect(pausaACada(semFase, () => 0.999999, 20, domingo)).toBe(15);
  });
});

describe("rampa", () => {
  it("10 a 36 aberturas por dia, teto da organização limita de fora", () => {
    expect(tetoAberturas(1, REGIME_A, null)).toBe(10);
    expect(tetoAberturas(5, REGIME_A, null)).toBe(20);
    expect(tetoAberturas(99, REGIME_A, null)).toBe(36);
    expect(tetoAberturas(5, REGIME_A, 10)).toBe(10);
    expect(tetoTotal(5, REGIME_A, 10)).toBe(32);
  });
});

describe("toques de uma organização (dias de envio)", () => {
  const cad = CADENCIAS["reativacao_3_toques"]!;
  const [, t2, t3] = cad.passos;

  it("toque 2 cai em 2 dias de envio e toque 3 em 5, sempre na janela", () => {
    for (let i = 0; i < 30; i++) {
      const a = horaDoPasso(cad, t2!, sp("2026-10-07T11:00:00"), REGIME_A, sorte);
      const b = horaDoPasso(cad, t3!, sp("2026-10-07T11:00:00"), REGIME_A, sorte);
      expect(dia(a)).toBe("2026-10-09");
      expect(dia(b)).toBe("2026-10-12");
      expect(dentroDaJanela(a, REGIME_A)).toBe(true);
      expect(dentroDaJanela(b, REGIME_A)).toBe(true);
    }
    expect(dia(horaDoPasso(cad, t2!, sp("2026-10-08T11:00:00"), REGIME_A, sorte))).toBe("2026-10-10");
    expect(dia(horaDoPasso(cad, t3!, sp("2026-10-08T11:00:00"), REGIME_A, sorte))).toBe("2026-10-13");
    // Sábado: domingo conta (tem janela), D+2 = segunda.
    expect(dia(horaDoPasso(cad, t2!, sp("2026-10-10T11:00:00"), REGIME_A, sorte))).toBe("2026-10-12");
  });

  it("nunca cai em feriado", () => {
    for (const d of ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"])
      for (const p of [t2!, t3!]) {
        const f = horaDoPasso(cad, p, sp(`${d}T15:00:00`), REGIME_A, sorte);
        expect(dia(f)).not.toBe("2026-11-02");
        expect(dentroDaJanela(f, REGIME_A)).toBe(true);
      }
  });

  it("toque 3 nunca antes de 3 dias de envio do toque 2 que atrasou", () => {
    const abertura = sp("2026-10-07T11:00:00");
    const toque2Atrasado = sp("2026-10-11T10:00:00"); // saiu domingo
    const t = horaDoPasso(cad, t3!, abertura, REGIME_A, sorte, toque2Atrasado);
    expect(dia(t) >= "2026-10-14").toBe(true);
  });
});

describe("resposta a quem escreveu", () => {
  it("sai 2 a 6 min depois mesmo fora da janela de prospecção", () => {
    const agora = sp("2026-10-10T21:00:00");
    const t = horaDeResponder(agora, REGIME_A, sorte);
    const min = (t.getTime() - agora.getTime()) / 60000;
    expect(min >= 2 && min <= 6).toBe(true);
  });

  it("com respeitarJanela vai para o próximo bloco", () => {
    expect(dentroDaJanela(horaDeResponder(sp("2026-10-10T18:59:00"), REGIME_A, sorte, true), REGIME_A)).toBe(true);
    expect(dentroDaJanela(horaDeResponder(sp("2026-10-11T05:00:00"), REGIME_A, sorte, true), REGIME_A)).toBe(true);
  });
});
