/**
 * Quarentena e frequência por lead (PLANO-DISPAROS 5.4): 45 dias de quarentena, 1 abordagem fria a cada 30 dias,
 * 3 mensagens sem resposta por mês — cada fronteira no dia exato.
 */
import { describe, expect, it } from "vitest";

import { RITMO_PADRAO } from "./config";
import { fimDaQuarentena, podeAbordar, podeTocar, type SituacaoDoLead } from "./quarentena";
import { MIN } from "./ritmo";

const CFG = RITMO_PADRAO.quarentena;
const AGORA = new Date("2026-10-16T12:00:00Z");
const DIA = 24 * 60 * MIN;
const livre: SituacaoDoLead = { quarentenaAte: null, ultimaAbordagemEm: null, semRespostaNoMes: 0 };

describe("quarentena de 45 dias", () => {
  it("o fim é daqui a 45 dias", () => {
    expect(fimDaQuarentena(AGORA, CFG).getTime() - AGORA.getTime()).toBe(45 * DIA);
  });
  it("lead sem histórico pode ser aberto", () => {
    expect(podeAbordar(livre, CFG, AGORA)).toEqual({ ok: true });
  });
  it("em quarentena não abre; no instante em que acaba, abre", () => {
    const ate = new Date(AGORA.getTime() + DIA);
    const r = podeAbordar({ ...livre, quarentenaAte: ate }, CFG, AGORA);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.motivo).toContain("quarentena até 2026-10-17");
    expect(podeAbordar({ ...livre, quarentenaAte: AGORA }, CFG, AGORA)).toEqual({ ok: true });
  });
});

describe("no máximo 1 abordagem fria por lead a cada 30 dias", () => {
  it("abordado há 29 dias: não; há 30: pode", () => {
    expect(podeAbordar({ ...livre, ultimaAbordagemEm: new Date(AGORA.getTime() - 29 * DIA) }, CFG, AGORA)).toMatchObject({ ok: false });
    expect(podeAbordar({ ...livre, ultimaAbordagemEm: new Date(AGORA.getTime() - 30 * DIA) }, CFG, AGORA)).toEqual({ ok: true });
  });
});

describe("3 mensagens sem resposta por mês", () => {
  it("abertura: com 2 sem resposta pode, com 3 não", () => {
    expect(podeAbordar({ ...livre, semRespostaNoMes: 2 }, CFG, AGORA)).toEqual({ ok: true });
    expect(podeAbordar({ ...livre, semRespostaNoMes: 3 }, CFG, AGORA)).toMatchObject({ ok: false });
  });
  it("toque: já saíram 2, o 3º toque pode; já saíram 3, o próximo não", () => {
    expect(podeTocar(2, CFG)).toEqual({ ok: true });
    expect(podeTocar(3, CFG)).toMatchObject({ ok: false });
  });
  it("é configurável (a cadência de 14 dias da organização B manda 4: precisa de 4)", () => {
    expect(podeTocar(3, { ...CFG, maxSemRespostaMes: 4 })).toEqual({ ok: true });
  });
});

describe("desligado, nada disso vale", () => {
  const desligado = { ...CFG, ligado: false };
  it("podeAbordar e podeTocar liberam", () => {
    const pior: SituacaoDoLead = { quarentenaAte: new Date(AGORA.getTime() + DIA), ultimaAbordagemEm: AGORA, semRespostaNoMes: 9 };
    expect(podeAbordar(pior, desligado, AGORA)).toEqual({ ok: true });
    expect(podeTocar(9, desligado)).toEqual({ ok: true });
  });
});
