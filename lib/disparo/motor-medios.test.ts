// @vitest-environment node
/**
 * Achados médios da auditoria 3 do motor (M1 e M5).
 *
 *  - M1: três falhas numa parte de sequência cancelavam a fila INTEIRA do lead, de qualquer origem. Agora cancelam só
 *    a origem daquela parte (e poupam o pacote da parada, já decidido), com o motivo na linha e um aviso na Central.
 *  - M5: `enviado_em` da parte que saiu registrava o começo da volta, não o instante da chamada ao canal.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo } from "./motor";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const AGORA = new Date("2026-10-23T12:00:00-03:00");
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const s = (n: number) => n * 1000;

const lead = (): LeadDoDisparo => ({
  id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {},
});

/** Linha da fila de `l1`; `venceEmSeg` negativo = já venceu. */
function linha(id: string, origem: LinhaEnvio["origem"], venceEmSeg: number, p: Partial<LinhaEnvio> = {}): LinhaEnvio {
  return {
    id, leadId: "l1", chipId: "chip-1", tipo: `tipo_${id}`, origem, texto: `texto ${id}`, midia: null, midiaId: null,
    enviarApos: new Date(AGORA.getTime() + s(venceEmSeg)), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - s(60)), daParada: false, ...p,
  };
}

const falhaDoCanal: EnvioReal = async () => {
  throw new Error("timeout do canal");
};

async function umaVolta(fila: LinhaEnvio[], enviar: EnvioReal, extra: { latenciaMs?: number } = {}) {
  const config = { ...configDoMotor(ORG, "real"), fonteStageId: null };
  const mem = motorEmMemoria(AGORA, config, [lead()]);
  mem.envios.push(...fila);
  let t = AGORA.getTime();
  const relogio = () => new Date(t);
  const dormir = async (ms: number) => void (t += ms);
  if (extra.latenciaMs) {
    const original = mem.repo.mandouDesde;
    mem.repo.mandouDesde = async (...a) => (await dormir(extra.latenciaMs!), original(...a));
  }
  const enviarReal = vi.fn<EnvioReal>(enviar);
  await rodarDisparo({
    repo: mem.repo, agora: AGORA, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO,
    sequencia: { relogio, dormir, orcamentoMs: s(600) },
  });
  /** Avisos da falha de envio (a parada silenciosa também escreve na Central, e não é o assunto aqui). */
  const avisosDeFalha = () => mem.central.filter((c) => /falhou/i.test(c.titulo));
  return { ...mem, enviarReal, avisosDeFalha, estados: () => Object.fromEntries(mem.envios.map((e) => [e.id, e.estado])) };
}

describe("M1: três falhas numa parte cancelam só a origem daquela parte", () => {
  it("sequência do operador: o resto dela é cancelado, o toque da cadência e o pacote da parada seguem pendentes", async () => {
    const m = await umaVolta(
      [
        linha("op1", "operador", -20, { tentativas: 2 }),
        linha("op2", "operador", -10),
        linha("toque", "motor", 3600, { tipo: "toque_2" }),
        linha("parada", "auto", 3600, { daParada: true }),
      ],
      falhaDoCanal,
    );
    expect(m.estados()).toEqual({ op1: "falhou", op2: "cancelado", toque: "pendente", parada: "pendente" });
    expect(m.envios.find((e) => e.id === "op2")!.motivo).toMatch(/falhou 3x/);
  });

  it("resposta automática: o resto dela é cancelado, a sequência do operador, o toque e o pacote da parada seguem pendentes", async () => {
    const m = await umaVolta(
      [
        linha("au1", "auto", -20, { tentativas: 2 }),
        linha("au2", "auto", -10),
        linha("op", "operador", 3600),
        linha("toque", "motor", 3600, { tipo: "toque_2" }),
        linha("parada", "auto", 3600, { daParada: true }),
      ],
      falhaDoCanal,
    );
    expect(m.estados()).toEqual({ au1: "falhou", au2: "cancelado", op: "pendente", toque: "pendente", parada: "pendente" });
  });

  it("registra o motivo na parte cancelada e abre aviso na Central, com a lead", async () => {
    const m = await umaVolta([linha("op1", "operador", -20, { tentativas: 2 }), linha("op2", "operador", -10)], falhaDoCanal);
    expect(m.envios.find((e) => e.id === "op1")!.motivo).toMatch(/falhou 3x: timeout do canal/);
    expect(m.avisosDeFalha()).toHaveLength(1);
    expect(m.avisosDeFalha()[0]).toMatchObject({ nivel: "warn", leadId: "l1" });
    expect(m.avisosDeFalha()[0]!.corpo).toContain("timeout do canal");
  });

  it("irmão: na 1ª falha nada é cancelado e a Central não é avisada", async () => {
    const m = await umaVolta([linha("op1", "operador", -20), linha("op2", "operador", -10), linha("toque", "motor", 3600, { tipo: "toque_2" })], falhaDoCanal);
    expect(m.estados()).toEqual({ op1: "pendente", op2: "pendente", toque: "pendente" });
    expect(m.avisosDeFalha()).toHaveLength(0);
  });

  it("falha de um toque da cadência (sem sequência) não cancela nem avisa a Central", async () => {
    const m = await umaVolta(
      [linha("toque", "motor", -20, { tipo: "toque_2", tentativas: 2 }), linha("op", "operador", 3600)],
      falhaDoCanal,
    );
    expect(m.estados()).toEqual({ toque: "falhou", op: "pendente" });
    expect(m.avisosDeFalha()).toHaveLength(0);
  });
});

describe("M5: enviado_em é o instante da chamada ao canal", () => {
  it("a passada gastou 7 s no banco antes de chamar o canal: enviado_em é o início da volta + 7 s, não o início da volta", async () => {
    const m = await umaVolta([linha("op1", "operador", -20)], async () => ({ externalId: "wamid-1" }), { latenciaMs: 7000 });
    const enviado = m.envios.find((e) => e.id === "op1")!;
    expect(enviado.estado).toBe("enviado");
    expect(enviado.enviadoEm!.getTime()).toBe(AGORA.getTime() + s(7));
  });
});

describe("número sem WhatsApp", () => {
  it("falha na primeira tentativa, marca o lead e cancela todos os pendentes", async () => {
    const pessoa = lead();
    const config = { ...configDoMotor(ORG, "real"), fonteStageId: null };
    const mem = motorEmMemoria(AGORA, config, [pessoa]);
    Object.assign(mem.repo, { marcarSemWhatsapp: async (_org: string, id: string) => {
      if (id === pessoa.id) Object.assign(pessoa.campos, { nao_contatar: true, nao_contatar_motivo: "sem_whatsapp" });
    } });
    mem.envios.push(linha("abertura", "motor", -20, { tipo: "abertura" }), linha("toque", "motor", 3600, { tipo: "toque_2" }), linha("parada", "auto", 3600, { daParada: true }));
    await rodarDisparo({ repo: mem.repo, agora: AGORA, ambiente: AMBIENTE, sortear: () => 0.5, enviarAviso: SEM_AVISO,
      enviarReal: async () => { throw new Error('evolution_400: {"response":{"message":[{"exists":false}]}}'); } });
    expect(mem.envios[0]).toMatchObject({ estado: "falhou", tentativas: 1, motivo: expect.stringMatching(/^sem_whatsapp:/) });
    expect(pessoa.campos).toMatchObject({ nao_contatar: true, nao_contatar_motivo: "sem_whatsapp" });
    expect(mem.envios.slice(1).map(e => [e.estado, e.motivo])).toEqual([["cancelado", "sem_whatsapp"], ["cancelado", "sem_whatsapp"]]);
  });
});
