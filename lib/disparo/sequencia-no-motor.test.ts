// @vitest-environment node
/**
 * O que o motor faz com as linhas `origem = 'operador'` (a sequência `/funil-valores` agendada pela tela de
 * conversas), SEM o relógio da sequência nos deps (o motor entrega uma parte por volta): sai UMA por volta e na ordem; a
 * cadência rápida dentro da volta (3 s / 29-34 s) está em `sequencia-cadencia-rapida.test.ts`. Para quando a lead escreve, pede para parar ou é bloqueada; não é
 * calada pelo veto de "humano no comando" (o humano é quem pediu); empurra as partes seguintes quando uma sai
 * atrasada ou falha; e uma sequência parada por mais de 30 min (chip pausado, teto da hora) é descartada em vez
 * de sair na hora errada. Cada caso que barra tem o irmão que passa, na mesma montagem.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import type { SituacaoHumana } from "./atendimento/humano";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo, VALIDADE_DA_SEQUENCIA_MS } from "./motor";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const AGORA = new Date("2026-10-23T12:00:00-03:00");
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const s = (n: number) => n * 1000;

const lead = (p: Partial<LeadDoDisparo> = {}): LeadDoDisparo => ({
  id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {}, ...p,
});

/** Parte `n` (1..7) da sequência, vencendo `seg` segundos antes de AGORA. */
function parte(n: number, venceHaSeg: number, p: Partial<LinhaEnvio> = {}): LinhaEnvio {
  return {
    id: `p${n}`, leadId: "l1", chipId: "chip-1", tipo: `funil_valores:${n}`, origem: "operador", texto: `parte ${n}`, midia: null, midiaId: null,
    enviarApos: new Date(AGORA.getTime() - s(venceHaSeg)), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - s(venceHaSeg + 5)), daParada: false, ...p,
  };
}

type Montagem = {
  fila: LinhaEnvio[];
  leads?: LeadDoDisparo[];
  humano?: Map<string, SituacaoHumana>;
  respostas?: string[];
  modo?: "simulado" | "real";
  enviar?: EnvioReal;
  agora?: Date;
};

/** `rodadas` voltas do motor; entre uma e outra o relógio anda `passoSeg` (0 = todas no mesmo instante). */
async function volta(m: Montagem, rodadas = 1, passoSeg = 0) {
  const config = { ...configDoMotor(ORG, m.modo ?? "real"), fonteStageId: null };
  const mem = motorEmMemoria(AGORA, config, m.leads ?? [lead()], { humano: m.humano, respostas: m.respostas ? () => m.respostas! : undefined });
  mem.envios.push(...m.fila);
  const enviarReal = vi.fn<EnvioReal>(m.enviar ?? (async () => ({ externalId: "wamid-1" })));
  for (let i = 0; i < rodadas; i++) {
    const agora = new Date((m.agora ?? AGORA).getTime() + i * s(passoSeg));
    await rodarDisparo({ repo: mem.repo, agora, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  }
  const estados = () => Object.fromEntries(mem.envios.map((e) => [e.id, e.estado]));
  return { ...mem, enviarReal, estados };
}

describe("sequência do operador no motor: ordem e ritmo", () => {
  it("sai UMA parte por volta, a mais antiga primeiro", async () => {
    const { enviarReal, estados } = await volta({ fila: [parte(2, 60), parte(1, 120), parte(3, 10)] });
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(enviarReal.mock.calls[0]![0].texto).toBe("parte 1");
    expect(estados()).toEqual({ p1: "enviado", p2: "pendente", p3: "pendente" });
  });

  it("nas voltas seguintes (o relógio andando) saem a 2 e a 3, na ordem", async () => {
    const { enviarReal, estados } = await volta({ fila: [parte(1, 120), parte(2, 60), parte(3, 10)] }, 3, 180);
    expect(enviarReal.mock.calls.map((c) => c[0].texto)).toEqual(["parte 1", "parte 2", "parte 3"]);
    expect(estados()).toEqual({ p1: "enviado", p2: "enviado", p3: "enviado" });
  });

  it("parte ainda não vencida não sai", async () => {
    const { enviarReal } = await volta({ fila: [parte(1, -30)] });
    expect(enviarReal).not.toHaveBeenCalled();
  });

  it("a parte 2 espera enquanto a 1 está em andamento (`enviando` preso): a ordem não se inverte", async () => {
    const { enviarReal, estados } = await volta({ fila: [parte(1, 120, { estado: "enviando" }), parte(2, 60)] });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(estados().p2).toBe("pendente");
  });

  it("a ordem de uma sequência não depende de outra lead (a fila de outro lead não segura esta)", async () => {
    const outro = lead({ id: "l2" });
    const { enviarReal } = await volta({
      leads: [lead(), outro],
      fila: [parte(1, 120, { leadId: "l2", id: "x1", estado: "enviando" }), parte(1, 60)],
    });
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(enviarReal.mock.calls[0]![0].lead.id).toBe("l1");
  });
});

describe("sequência do operador no motor: quem a para", () => {
  it("irmão: sem ninguém escrevendo, a parte sai", async () => {
    const { enviarReal } = await volta({ fila: [parte(1, 20), parte(2, 10)] });
    expect(enviarReal).toHaveBeenCalledTimes(1);
  });

  it("a lead escreveu depois do agendamento: a parte e o resto da sequência são canceladas, nada sai", async () => {
    const { enviarReal, estados, envios } = await volta({ fila: [parte(1, 20), parte(2, 10), parte(3, 5)], respostas: ["quanto custa?"] });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(estados()).toEqual({ p1: "cancelado", p2: "cancelado", p3: "cancelado" });
    expect(envios[0]!.motivo).toMatch(/escreveu/);
  });

  it("a lead pediu para parar: cancela tudo, com o motivo", async () => {
    const { enviarReal, estados, envios } = await volta({ fila: [parte(1, 20), parte(2, 10)], respostas: ["pare de me mandar mensagem"] });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(estados()).toEqual({ p1: "cancelado", p2: "cancelado" });
    expect(envios[0]!.motivo).toMatch(/parar/);
  });

  it("contato bloqueado (opt-out, LGPD): cancela tudo", async () => {
    const { enviarReal, estados } = await volta({ leads: [lead({ bloqueado: true })], fila: [parte(1, 20), parte(2, 10)] });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(estados()).toEqual({ p1: "cancelado", p2: "cancelado" });
  });

  it("contato anonimizado: cancela tudo", async () => {
    const { enviarReal, estados } = await volta({ leads: [lead({ anonimizado: true })], fila: [parte(1, 20), parte(2, 10)] });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(estados()).toEqual({ p1: "cancelado", p2: "cancelado" });
  });

  it("o humano no comando NÃO a cala: foi o próprio operador que a pediu (o toque de cadência do mesmo lead é calado)", async () => {
    const humano = new Map<string, SituacaoHumana>([["l1", { forceHuman: true, conversas: [] }]]);
    const sequencia = await volta({ humano, fila: [parte(1, 20)] });
    expect(sequencia.enviarReal).toHaveBeenCalledTimes(1);

    const toque = await volta({
      humano,
      fila: [{ ...parte(1, 20), id: "t2", tipo: "toque_2", origem: "motor" }],
    });
    expect(toque.enviarReal).not.toHaveBeenCalled();
  });
});

describe("sequência do operador no motor: a trava", () => {
  it("trava fechada (modo simulado): a linha vira `simulado`, nenhum canal é chamado", async () => {
    const { enviarReal, estados } = await volta({ modo: "simulado", fila: [parte(1, 20)] });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(estados().p1).toBe("simulado");
  });

  it("chip em saúde vermelha: nada sai e a sequência fica parada (o chip não é burlado)", async () => {
    const config = { ...configDoMotor(ORG, "real"), fonteStageId: null };
    const mem = motorEmMemoria(AGORA, config, [lead()]);
    mem.chip.saude = "vermelho";
    mem.envios.push(parte(1, 20), parte(2, 10));
    const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "x" }));
    await rodarDisparo({ repo: mem.repo, agora: AGORA, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(mem.envios.map((e) => e.estado)).toEqual(["pendente", "pendente"]);
  });
});

describe("sequência do operador no motor: atraso e falha empurram o resto junto", () => {
  it("parte que sai com 3 min de atraso: as seguintes andam os mesmos 3 min (a pausa planejada se mantém)", async () => {
    const m = await volta({ fila: [parte(1, 180), parte(2, 170), parte(3, 120)] });
    const [p1, p2, p3] = m.envios;
    expect(p1!.estado).toBe("enviado");
    expect(p2!.enviarApos.getTime()).toBe(AGORA.getTime() - s(170) + s(180));
    expect(p3!.enviarApos.getTime()).toBe(AGORA.getTime() - s(120) + s(180));
  });

  it("falha no envio: a parte volta para daqui a 10 min e as seguintes esperam junto, sem passar na frente", async () => {
    const m = await volta({
      fila: [parte(1, 20), parte(2, 10), parte(3, 5)],
      enviar: async () => {
        throw new Error("timeout do canal");
      },
    });
    const [p1, p2, p3] = m.envios;
    expect(p1).toMatchObject({ estado: "pendente", tentativas: 1 });
    expect(p1!.enviarApos.getTime()).toBe(AGORA.getTime() + s(600));
    expect(p2!.enviarApos.getTime()).toBeGreaterThan(p1!.enviarApos.getTime() - 1);
    expect(p3!.enviarApos.getTime()).toBeGreaterThan(p2!.enviarApos.getTime());
    expect(p2!.estado).toBe("pendente");
  });

  it("três falhas seguidas: a parte falha e a sequência inteira é cancelada (a tabela sem a explicação não faz sentido)", async () => {
    const m = await volta({
      fila: [parte(1, 20, { tentativas: 2 }), parte(2, 10), parte(3, 5)],
      enviar: async () => {
        throw new Error("timeout do canal");
      },
    });
    expect(m.estados()).toEqual({ p1: "falhou", p2: "cancelado", p3: "cancelado" });
  });
});

describe("sequência do operador no motor: validade", () => {
  it("a validade é de 30 min", () => {
    expect(VALIDADE_DA_SEQUENCIA_MS).toBe(30 * 60 * 1000);
  });

  it("irmão: parte atrasada MENOS de 30 min ainda sai", async () => {
    const { enviarReal } = await volta({ fila: [parte(1, 29 * 60)] });
    expect(enviarReal).toHaveBeenCalledTimes(1);
  });

  it("parte parada há mais de 30 min (chip estava pausado) é descartada, e o resto junto: não sai fora de hora", async () => {
    const { enviarReal, estados, envios } = await volta({ fila: [parte(1, 31 * 60), parte(2, 30 * 60 + 40), parte(3, 29 * 60)] });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(estados()).toEqual({ p1: "cancelado", p2: "cancelado", p3: "cancelado" });
    expect(envios[0]!.motivo).toMatch(/vencid/i);
  });
});
