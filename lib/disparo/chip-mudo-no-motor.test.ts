// @vitest-environment node
/**
 * E3 (confirmado em produção): chip mudo. A Evolution devolve 2xx com `key.id` mesmo quando o chip parou de
 * entregar; o motor gravava `enviado` e seguia mandando (medido: ~37 e ~18 envios seguidos sem nenhum ack).
 *
 * Regra: N envios seguidos do chip sem NENHUMA confirmação (nem o 1 tique do servidor), o mais antigo deles com pelo
 * menos 30 min, param o chip pelo freio de saúde que já existe (vermelho + `pausado_ate`) e abrem UM aviso na Central.
 * Com `ritmo.saude` desligado, nada muda sozinho: só o aviso. Cada caso que barra tem o irmão que passa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import { RITMO_PADRAO, type ConfigDisparo } from "./config";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo } from "./motor";
import { H, MIN } from "./ritmo";
import { avaliarSemConfirmacao, ENVIOS_SEM_CONFIRMACAO, MINUTOS_PARA_A_CONFIRMACAO } from "./sem-confirmacao";

const ORG = "00000000-0000-4000-8000-0000000000f3";
const AGORA = new Date("2026-10-23T12:00:00-03:00"); // sexta, janela aberta
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const LEAD: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

/** `n` envios reais que já saíram do chip, o mais novo há `maisNovoHaMin` min, de 5 em 5 min para trás. */
function historico(n: number, maisNovoHaMin: number, ack: (i: number) => number | null = () => null): LinhaEnvio[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`, leadId: `velho-${i}`, chipId: "chip-1", tipo: "abertura", origem: "motor" as const, texto: "oi", midia: null, midiaId: null,
    enviarApos: new Date(AGORA.getTime() - (maisNovoHaMin + 5 * i) * MIN), estado: "enviado" as const, tentativas: 0,
    criadoEm: new Date(AGORA.getTime() - (maisNovoHaMin + 5 * i + 1) * MIN), daParada: false,
    enviadoEm: new Date(AGORA.getTime() - (maisNovoHaMin + 5 * i) * MIN), externalId: `wamid-${i}`, ack: ack(i),
  }));
}

const toque = (): LinhaEnvio => ({
  id: "t2", leadId: "l1", chipId: "chip-1", tipo: "toque_2", origem: "motor", texto: "Oi Maria, passando de novo.", midia: null, midiaId: null,
  enviarApos: new Date(AGORA.getTime() - 5 * MIN), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - 2 * 24 * H), daParada: false,
});

// A pausa por chip mudo nasce desligada (só aviso); estes casos ligam o interruptor, menos o que prova o padrão.
beforeEach(() => vi.stubEnv("DISPARO_CHIP_MUDO_PAUSA", "on"));
afterEach(() => vi.unstubAllEnvs());

describe("padrão: pausa por chip mudo desligada", () => {
  it("sem DISPARO_CHIP_MUDO_PAUSA=on, o chip mudo só gera aviso: nada é pausado e o toque sai", async () => {
    vi.stubEnv("DISPARO_CHIP_MUDO_PAUSA", "");
    const m = montar([...historico(8, 5), toque()]);
    await m.rodar();
    expect(m.chip.saude).toBe("verde");
    expect(m.chip.pausadoAte ?? null).toBeNull();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    const abertos = m.avisosVivos.filter((a) => a.aberto);
    expect(abertos).toHaveLength(1);
    expect(abertos[0]!.titulo).toMatch(/não pausados/);
  });
});

function montar(fila: LinhaEnvio[], saudeLigada = true) {
  const config: ConfigDisparo = { ...configDoMotor(ORG, "real"), fonteStageId: null };
  config.ritmo = { ...RITMO_PADRAO, feriados: [], saude: { ...RITMO_PADRAO.saude, ligado: saudeLigada } };
  const m = motorEmMemoria(AGORA, config, [LEAD]);
  m.envios.push(...fila);
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid-novo" }));
  const rodar = (agora = AGORA) => rodarDisparo({ repo: m.repo, agora, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  return { ...m, enviarReal, rodar };
}

describe("a conta (pura)", () => {
  it("N e a janela são constantes com o porquê no código: 8 seguidos e 30 min desde o primeiro", () => {
    expect(ENVIOS_SEM_CONFIRMACAO).toBe(8);
    expect(MINUTOS_PARA_A_CONFIRMACAO).toBe(30);
  });

  it("conta os seguidos do mais novo para trás e para no primeiro confirmado", () => {
    const e = (haMin: number, ack: number | null) => ({ enviadoEm: new Date(AGORA.getTime() - haMin * MIN), ack, entregueEm: null, lidoEm: null });
    const r = avaliarSemConfirmacao([e(1, null), e(10, null), e(20, 1), e(30, null)], AGORA);
    expect(r.seguidas).toBe(2);
    expect(r.mudo).toBe(false);
  });
});

describe("saúde ligada: o chip mudo para pelo freio de saúde", () => {
  it("8 envios seguidos sem nenhum ack, o primeiro há 40 min: o toque NÃO sai, o chip fica vermelho e pausado, um aviso na Central", async () => {
    const m = montar([...historico(8, 5), toque()]);
    const r = await m.rodar();
    expect(m.enviarReal).not.toHaveBeenCalled();
    expect(m.chip.saude).toBe("vermelho");
    expect(m.chip.pausadoAte!.getTime() - AGORA.getTime()).toBe(RITMO_PADRAO.saude.vermelhoHoras * H);
    expect(m.chip.diaRampa).toBe(5); // a rampa não é mexida aqui
    expect(m.chip.saudeMotivo).toMatch(/8 mensagens seguidas sem confirmação/);
    expect(r.organizacoes[0]!.chips[0]!.resultado).toMatch(/sem confirmação/);
    expect(m.envios.find((e) => e.id === "t2")!.estado).toBe("pendente");
    const abertos = m.avisosVivos.filter((a) => a.aberto);
    expect(abertos).toHaveLength(1);
    expect(abertos[0]!.titulo).toMatch(/8 mensagens seguidas sem confirmação/);
    expect(abertos[0]!.titulo).toMatch(/pausad/);
  });

  it("a volta seguinte não empilha outro aviso", async () => {
    const m = montar([...historico(8, 5), toque()]);
    await m.rodar();
    await m.rodar(new Date(AGORA.getTime() + MIN));
    await m.rodar(new Date(AGORA.getTime() + 20 * MIN));
    expect(m.avisosVivos).toHaveLength(1);
    expect(m.enviarReal).not.toHaveBeenCalled();
  });

  it("irmão: 7 seguidos sem ack não param nada (o toque sai)", async () => {
    const m = montar([...historico(7, 5), toque()]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.chip.saude).toBe("verde");
    expect(m.avisosVivos).toHaveLength(0);
  });

  it("irmão: 8 seguidos, mas o primeiro há menos de 30 min (o ack ainda pode chegar): o toque sai", async () => {
    const m = montar([...historico(8, 1).map((e, i) => ({ ...e, enviadoEm: new Date(AGORA.getTime() - (1 + 3 * i) * MIN) })), toque()]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.chip.saude).toBe("verde");
  });

  it("irmão: um único 1 tique (ack de servidor) no meio quebra a sequência", async () => {
    const m = montar([...historico(10, 5, (i) => (i === 4 ? 1 : null)), toque()]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.chip.saude).toBe("verde");
  });

  it("irmão: envio simulado não conta (o ensaio não tem ack nenhum)", async () => {
    const m = montar([...historico(8, 5).map((e) => ({ ...e, estado: "simulado" as const })), toque()]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
  });

  it("o operador devolve o chip: os envios sem ack de ANTES do aviso não o derrubam de novo (e os novos sem ack, sim)", async () => {
    const m = montar([...historico(8, 5), toque()]);
    await m.rodar();
    expect(m.chip.saude).toBe("vermelho");
    Object.assign(m.chip, { saude: "verde", pausadoAte: null, saudeMotivo: null });

    const depois = new Date(AGORA.getTime() + 30 * MIN);
    await m.rodar(depois);
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.chip.saude).toBe("verde");
  });

  it("quando um envio feito depois do aviso é confirmado, o aviso fecha sozinho", async () => {
    const m = montar([...historico(8, 5), toque()]);
    await m.rodar();
    Object.assign(m.chip, { saude: "verde", pausadoAte: null, saudeMotivo: null });
    await m.rodar(new Date(AGORA.getTime() + 30 * MIN));
    const saiu = m.envios.find((e) => e.id === "t2")!;
    expect(saiu.estado).toBe("enviado");
    saiu.ack = 2;
    await m.rodar(new Date(AGORA.getTime() + 31 * MIN));
    expect(m.avisosVivos.filter((a) => a.aberto)).toHaveLength(0);
  });
});

describe("saúde desligada (`ritmo.saude.ligado = false`): nada muda sozinho, só o aviso", () => {
  it("8 seguidos sem ack: o chip NÃO é pausado, o toque sai, e a Central recebe um aviso dizendo que nada foi pausado", async () => {
    const m = montar([...historico(8, 5), toque()], false);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.chip.saude).toBe("verde");
    expect(m.chip.pausadoAte).toBeNull();
    const abertos = m.avisosVivos.filter((a) => a.aberto);
    expect(abertos).toHaveLength(1);
    expect(abertos[0]!.titulo).toMatch(/8 mensagens seguidas sem confirmação/);
    expect(abertos[0]!.titulo).toMatch(/não pausad/);
  });

  it("voltas seguintes atualizam o MESMO aviso (o número cresce), sem empilhar", async () => {
    const m = montar([...historico(8, 5), toque()], false);
    await m.rodar();
    await m.rodar(new Date(AGORA.getTime() + MIN));
    expect(m.avisosVivos).toHaveLength(1);
    expect(m.avisosVivos[0]!.titulo).toMatch(/9 mensagens seguidas/);
  });
});
