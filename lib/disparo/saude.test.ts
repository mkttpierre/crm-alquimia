/**
 * Saúde calculada do chip: a tabela 5.3 do PLANO-DISPAROS ponto a ponto — o limite exato de cada faixa,
 * as duas pontas (verde que não vira amarelo, amarelo que não vira vermelho) e o que NÃO pode virar cor
 * (dado que não chegou, amostra pequena, vermelho já gravado).
 */
import { describe, expect, it } from "vitest";

import { RITMO_PADRAO, ritmoSchema } from "./config";
import { acaoNoChip, calcularSaude, contarConexao, deveRecalcular, pior, resumirSinais, SINAIS_ZERADOS, type AberturaSaida, type SinaisDoDia } from "./saude";
import { H, MIN } from "./ritmo";

const CFG = RITMO_PADRAO.saude;
const AGORA = new Date("2026-10-16T20:00:00Z");
const INICIO = new Date("2026-10-16T03:00:00Z");

const sinais = (p: Partial<SinaisDoDia> = {}): SinaisDoDia => ({ ...SINAIS_ZERADOS, ...p });

describe("defaults = valores do plano", () => {
  it("limiares de 5.3 e tempos de PROGRESSAO", () => {
    expect(CFG.bloqueio).toEqual({ amarelo: 0.02, vermelho: 0.04 });
    expect(CFG.naoQuero).toEqual({ amarelo: 0.03, vermelho: 0.05 });
    expect(CFG.irritacao).toEqual({ amarelo: 1, vermelho: 2 });
    expect(CFG.resposta).toMatchObject({ minAberturas: 30, ok: 0.05, vermelho: 0.03 });
    expect(CFG.horasSemEntrega).toBe(6);
    expect(CFG.vermelhoHoras).toBe(48);
    expect(CFG.reconexoesAmarelo).toBe(1);
    expect(CFG.reconexaoMinSegundos).toBe(30);
    expect(RITMO_PADRAO.quarentena).toMatchObject({ dias: 45, diasEntreAbordagens: 30, maxSemRespostaMes: 3 });
  });
});

describe("bloqueio provável (1 tique depois de 6 h): verde até 2%, amarelo 2-4%, vermelho acima de 4%", () => {
  // 100 aberturas maduras, todas com ack: a taxa é o próprio número de bloqueios.
  const com = (bloqueios: number) => calcularSaude(sinais({ aberturas: 100, maduras: 100, comAck: 100, bloqueioProvavel: bloqueios }), CFG);
  it.each([
    [0, "verde"],
    [2, "verde"], // 2% exato: ainda verde ("até 2%")
    [3, "amarelo"],
    [4, "amarelo"], // 4% exato: ainda amarelo
    [5, "vermelho"],
  ] as const)("%i de 100 -> %s", (n, cor) => {
    expect(com(n).saude).toBe(cor);
  });
  it("o motivo diz o número, a base e o limite", () => {
    const r = com(5);
    expect(r.motivos[0]).toMatchObject({ indicador: "bloqueio", cor: "vermelho" });
    expect(r.motivos[0]!.texto).toContain("5,0%");
    expect(r.motivos[0]!.texto).toContain("5 de 100");
    expect(r.motivos[0]!.texto).toContain("4%");
  });
  it("sem amostra (menos de 5 maduras) não vira cor: 1 de 3 é 33% e não significa nada", () => {
    const r = calcularSaude(sinais({ aberturas: 3, maduras: 3, comAck: 3, bloqueioProvavel: 1 }), CFG);
    expect(r.saude).toBe("verde");
    expect(r.semDado[0]).toContain("bloqueio provável");
  });
  it("a Evolution não informou entrega (cobertura abaixo de 50%): sem dado, NUNCA vermelho", () => {
    const r = calcularSaude(sinais({ aberturas: 20, maduras: 20, comAck: 4, bloqueioProvavel: 4 }), CFG);
    expect(r.saude).toBe("verde");
    expect(r.taxas.bloqueio).toBeNull();
    expect(r.semDado[0]).toContain("informou entrega");
  });
});

describe('"não quero" + "pare": até 3% verde, 3-5% amarelo, acima de 5% vermelho', () => {
  const com = (n: number) => calcularSaude(sinais({ aberturas: 100, naoQuero: n }), CFG);
  it.each([
    [3, "verde"],
    [4, "amarelo"],
    [5, "amarelo"],
    [6, "vermelho"],
  ] as const)("%i de 100 aberturas -> %s", (n, cor) => {
    expect(com(n).saude).toBe(cor);
  });
  it("com menos de 5 aberturas no dia a % não é avaliada (e fica dito)", () => {
    const r = calcularSaude(sinais({ aberturas: 4, naoQuero: 2 }), CFG);
    expect(r.saude).toBe("verde");
    expect(r.semDado.some((m) => m.includes("não quero"))).toBe(true);
  });
});

describe("irritação, spam, denúncia, Procon: 1 = amarelo, 2 ou mais = vermelho", () => {
  it.each([
    [0, "verde"],
    [1, "amarelo"],
    [2, "vermelho"],
    [7, "vermelho"],
  ] as const)("%i no dia -> %s", (n, cor) => {
    expect(calcularSaude(sinais({ irritacao: n }), CFG).saude).toBe(cor);
  });
  it("vale mesmo no primeiro dia da rampa, sem amostra: uma denúncia basta", () => {
    expect(calcularSaude(sinais({ aberturas: 1, irritacao: 2 }), CFG).saude).toBe("vermelho");
  });
});

describe("taxa de resposta depois de 30 aberturas: 5% ou mais ok, abaixo de 3% vermelho, entre = amarelo", () => {
  const com = (resp: number, aberturas = 100) => calcularSaude(sinais({ aberturasJanela: aberturas, respostasJanela: resp }), CFG);
  it.each([
    [5, "verde"], // 5% exato: ok
    [4, "amarelo"],
    [3, "amarelo"], // 3% exato: ainda amarelo ("abaixo de 3%" é vermelho)
    [2, "vermelho"],
    [0, "vermelho"],
  ] as const)("%i respostas em 100 -> %s", (r, cor) => {
    expect(com(r).saude).toBe(cor);
  });
  it("antes de 30 aberturas não avalia (29 sem resposta nenhuma continua verde)", () => {
    const r = com(0, 29);
    expect(r.saude).toBe("verde");
    expect(r.semDado[0]).toContain("29 de 30");
  });
  it("com exatamente 30 já avalia", () => {
    expect(com(0, 30).saude).toBe("vermelho");
  });
});

describe("conexão: close, 428 ou logout = vermelho; 1 reconexão no dia = amarelo", () => {
  it("queda é vermelho", () => {
    expect(calcularSaude(sinais({ quedas: 1 }), CFG).saude).toBe("vermelho");
  });
  it("reconexão sem queda é amarelo", () => {
    expect(calcularSaude(sinais({ reconexoes: 1 }), CFG).saude).toBe("amarelo");
  });
  it("queda vence reconexão", () => {
    expect(calcularSaude(sinais({ quedas: 1, reconexoes: 3 }), CFG).saude).toBe("vermelho");
  });
  const ev = (estado: string, min: number, codigo: number | null = null) => ({ estado, codigo, em: new Date(AGORA.getTime() + min * MIN) });
  const seg = (estado: string, segundos: number) => ({ estado, codigo: 200, em: new Date(INICIO.getTime() + segundos * 1000) });
  const resumir = (conexao: ReturnType<typeof seg>[], segundos = 30) => resumirSinais(
    { aberturas: [], respostas: [], conexao, inicioDoDia: INICIO, agora: AGORA },
    { ...CFG, reconexaoMinSegundos: segundos },
  );
  it("refresh de um segundo não conta como reconexão", () => {
    expect(resumir([seg("connecting", 0), seg("open", 1)]).reconexoes).toBe(0);
  });
  it("connecting por 45 segundos conta como reconexão", () => {
    expect(resumir([seg("connecting", 0), seg("open", 45)]).reconexoes).toBe(1);
  });
  it("mede a tentativa desde o primeiro connecting", () => {
    expect(resumir([seg("connecting", 0), seg("connecting", 40), seg("open", 45)]).reconexoes).toBe(1);
  });
  it("o limite é exclusivo e configurável", () => {
    const eventos = [seg("connecting", 0), seg("open", 30)];
    expect(resumir(eventos).reconexoes).toBe(0);
    expect(resumir(eventos, 29).reconexoes).toBe(1);
  });
  it("queda seguida de open conta apenas a queda", () => {
    expect(resumir([seg("connecting", 0), seg("close", 1), seg("open", 45)])).toMatchObject({ quedas: 1, reconexoes: 0 });
  });
  it("aceita apenas segundos inteiros não negativos", () => {
    expect(ritmoSchema.safeParse({ saude: { reconexaoMinSegundos: 0 } }).success).toBe(true);
    expect(ritmoSchema.safeParse({ saude: { reconexaoMinSegundos: -1 } }).success).toBe(false);
    expect(ritmoSchema.safeParse({ saude: { reconexaoMinSegundos: 0.5 } }).success).toBe(false);
  });
  it("contarConexao: close, 428 e logout são queda", () => {
    expect(contarConexao([ev("close", 0)]).quedas).toBe(1);
    expect(contarConexao([ev("connecting", 0, 428)]).quedas).toBe(1);
    expect(contarConexao([ev("logout", 0)]).quedas).toBe(1);
    expect(contarConexao([ev("open", 0)])).toEqual({ quedas: 0, reconexoes: 0 });
  });
  it("contarConexao: vários connecting seguidos de um open são UMA reconexão; connecting + close + open é queda, não reconexão", () => {
    expect(contarConexao([ev("connecting", 0), ev("connecting", 1), ev("open", 2)])).toEqual({ quedas: 0, reconexoes: 1 });
    expect(contarConexao([ev("connecting", 0), ev("close", 1), ev("open", 2)])).toEqual({ quedas: 1, reconexoes: 0 });
  });
});

describe("a cor final é a pior de todas, e o motivo lista todos", () => {
  it("amarelo de um indicador + vermelho de outro = vermelho com os dois motivos", () => {
    const r = calcularSaude(sinais({ aberturas: 100, naoQuero: 4, irritacao: 2 }), CFG);
    expect(r.saude).toBe("vermelho");
    expect(r.motivos.map((m) => m.indicador).sort()).toEqual(["irritacao", "nao_quero"]);
  });
  it("tudo bom = verde sem motivo", () => {
    expect(calcularSaude(sinais({ aberturas: 30, naoQuero: 0, maduras: 30, comAck: 30 }), CFG)).toMatchObject({ saude: "verde", motivos: [] });
  });
  it("pior()", () => {
    expect(pior("verde", "amarelo")).toBe("amarelo");
    expect(pior("vermelho", "amarelo")).toBe("vermelho");
    expect(pior("verde", "verde")).toBe("verde");
  });
  it("limiares configuráveis por organização", () => {
    const frouxo = { ...CFG, bloqueio: { amarelo: 0.1, vermelho: 0.2 } };
    expect(calcularSaude(sinais({ aberturas: 100, maduras: 100, comAck: 100, bloqueioProvavel: 5 }), frouxo).saude).toBe("verde");
  });
});

describe("acaoNoChip: amarelo segura, vermelho para 48 h e volta ao dia 1, vermelho não se desfaz sozinho", () => {
  const vermelho = calcularSaude(sinais({ quedas: 1 }), CFG);
  const amarelo = calcularSaude(sinais({ irritacao: 1 }), CFG);
  const verde = calcularSaude(sinais(), CFG);

  it("vermelho: pausa por 48 h, dia 1 da rampa, motivo gravado", () => {
    const a = acaoNoChip({ saude: "verde" }, vermelho, CFG, AGORA)!;
    expect(a.saude).toBe("vermelho");
    expect(a.diaRampa).toBe(1);
    expect(a.pausadoAte!.getTime() - AGORA.getTime()).toBe(48 * H);
    expect(a.saudeMotivo).toContain("Conexão caiu");
  });
  it("amarelo: só muda a cor (a rampa não sobe porque abrirDia exige verde) e não pausa nem rebaixa o dia", () => {
    const a = acaoNoChip({ saude: "verde" }, amarelo, CFG, AGORA)!;
    expect(a).toMatchObject({ saude: "amarelo" });
    expect(a.pausadoAte).toBeUndefined();
    expect(a.diaRampa).toBeUndefined();
  });
  it("verde: volta o chip amarelo para verde, sem motivo", () => {
    expect(acaoNoChip({ saude: "amarelo" }, verde, CFG, AGORA)).toEqual({ saude: "verde", saudeMotivo: null });
  });
  it("chip já vermelho: nada muda (só o operador o devolve)", () => {
    expect(acaoNoChip({ saude: "vermelho" }, verde, CFG, AGORA)).toBeNull();
  });
  it("48 h é configurável", () => {
    const a = acaoNoChip({ saude: "verde" }, vermelho, { ...CFG, vermelhoHoras: 72 }, AGORA)!;
    expect(a.pausadoAte!.getTime() - AGORA.getTime()).toBe(72 * H);
  });
});

describe("deveRecalcular: no máximo a cada 15 min, e desligável", () => {
  it("nunca calculou: calcula", () => expect(deveRecalcular(null, AGORA, CFG)).toBe(true));
  it("calculou há 14 min: espera", () => expect(deveRecalcular(new Date(AGORA.getTime() - 14 * MIN), AGORA, CFG)).toBe(false));
  it("calculou há 15 min: calcula", () => expect(deveRecalcular(new Date(AGORA.getTime() - 15 * MIN), AGORA, CFG)).toBe(true));
  it("desligado: nunca", () => expect(deveRecalcular(null, AGORA, { ...CFG, ligado: false })).toBe(false));
});

describe("resumirSinais: das linhas cruas aos números do dia", () => {
  const ab = (lead: string, horasAtras: number, p: Partial<AberturaSaida> = {}): AberturaSaida => ({
    leadId: lead, estado: "enviado", enviadoEm: new Date(AGORA.getTime() - horasAtras * H), ack: 2, entregueEm: new Date(AGORA.getTime() - (horasAtras - 0.1) * H), ...p,
  });
  const resp = (lead: string, texto: string, horasAtras: number) => ({ leadId: lead, texto, em: new Date(AGORA.getTime() - horasAtras * H) });
  const base = { respostas: [], conexao: [], inicioDoDia: INICIO, agora: AGORA };

  it("maduras = reais com 6 h ou mais; a de 5 h não conta; simulada não conta", () => {
    const s = resumirSinais({ ...base, aberturas: [ab("a", 8), ab("b", 6), ab("c", 5), ab("d", 8, { estado: "simulado" })] }, CFG);
    expect(s).toMatchObject({ aberturas: 4, maduras: 2 });
  });
  it("1 tique sem entrega depois de 6 h é bloqueio provável; entrega confirmada não é; sem ack não é nem dado", () => {
    const s = resumirSinais(
      { ...base, aberturas: [ab("a", 8, { ack: 1, entregueEm: null }), ab("b", 8), ab("c", 8, { ack: null, entregueEm: null })] },
      CFG,
    );
    expect(s).toMatchObject({ maduras: 3, comAck: 2, bloqueioProvavel: 1 });
  });
  it('"não quero" e "pare" contam por lead e sem a irritação; número errado não conta', () => {
    const s = resumirSinais(
      {
        ...base,
        aberturas: [ab("a", 8), ab("b", 8), ab("c", 8), ab("d", 8)],
        respostas: [resp("a", "não tenho interesse", 2), resp("a", "obrigado, não", 1), resp("b", "pare", 2), resp("c", "número errado", 2), resp("d", "quanto custa?", 2)],
      },
      CFG,
    );
    expect(s.naoQuero).toBe(2);
    expect(s.irritacao).toBe(0);
  });
  it("irritação: spam, denúncia e Procon contam como irritação, não como não quero", () => {
    const s = resumirSinais(
      { ...base, aberturas: [ab("a", 8), ab("b", 8)], respostas: [resp("a", "isso é spam, vou denunciar", 2), resp("b", "vou no procon", 1)] },
      CFG,
    );
    expect(s.irritacao).toBe(2);
    expect(s.naoQuero).toBe(0);
  });
  it("resposta anterior à abertura não é resposta a ela", () => {
    const s = resumirSinais({ ...base, aberturas: [ab("a", 3)], respostas: [resp("a", "oi, tudo bem?", 10)] }, CFG);
    expect(s.respostasJanela).toBe(0);
    expect(s.respostas).toBe(0);
  });
  it("taxa de resposta usa a janela longa (aberturas de ontem entram), o resto usa só o dia", () => {
    const s = resumirSinais(
      { ...base, aberturas: [ab("a", 30), ab("b", 30), ab("c", 4)], respostas: [resp("a", "quanto custa?", 20)] },
      CFG,
    );
    expect(s).toMatchObject({ aberturas: 1, aberturasJanela: 3, respostasJanela: 1, respostas: 0 });
  });
  it("conexão só conta o que aconteceu hoje", () => {
    const hoje = new Date(AGORA.getTime() - 2 * H);
    const ontem = new Date(AGORA.getTime() - 40 * H);
    const s = resumirSinais({ ...base, aberturas: [], conexao: [{ estado: "close", codigo: null, em: ontem }, { estado: "connecting", codigo: null, em: hoje }, { estado: "open", codigo: null, em: new Date(hoje.getTime() + 45 * 1000) }] }, CFG);
    expect(s).toMatchObject({ quedas: 0, reconexoes: 1 });
  });
});
