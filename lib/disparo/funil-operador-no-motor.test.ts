// @vitest-environment node
/**
 * Funil do operador no motor: a presença do passo ("digitando/gravando") vai ao canal junto com o envio, e
 * a janela de resposta NÃO cancela o que o operador mandou à mão (regra: envio manual só exige chip
 * saudável). A resposta automática (origem `auto`) segue respeitando a janela.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo } from "./motor";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const DIA = new Date("2026-10-23T12:00:00-03:00");
const NOITE = new Date("2026-10-23T23:30:00-03:00");
const s = (n: number) => n * 1000;

const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

const parte = (agora: Date, p: Partial<LinhaEnvio> = {}): LinhaEnvio => ({
  id: "p1", leadId: "l1", chipId: "chip-1", tipo: "funil_valores:1", origem: "operador", texto: "Oi", midia: null, midiaId: null,
  enviarApos: new Date(agora.getTime() - s(5)), estado: "pendente", tentativas: 0, criadoEm: new Date(agora.getTime() - s(10)), daParada: false, ...p,
});

async function volta(agora: Date, fila: LinhaEnvio[]) {
  const mem = motorEmMemoria(agora, { ...configDoMotor(ORG, "real"), fonteStageId: null }, [lead]);
  mem.envios.push(...fila);
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid-1" }));
  await rodarDisparo({ repo: mem.repo, agora, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  return { ...mem, enviarReal };
}

describe("funil do operador no motor", () => {
  it("limita a uma presença por chip na volta e deixa as demais pendentes", async () => {
    let tempo = DIA.getTime();
    const mem = motorEmMemoria(DIA, { ...configDoMotor(ORG, "real"), fonteStageId: null }, [lead]);
    mem.envios.push(...[1, 2, 3].map((n) => parte(DIA, { id: `p${n}`, tipo: `funil_valores:${n}`, presenca: "gravando", presencaMs: 25000 })));
    const enviarReal = vi.fn<EnvioReal>(async () => { tempo += 25000; return { externalId: "ok" }; });
    await rodarDisparo({ repo: mem.repo, agora: DIA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO, sequencia: { relogio: () => new Date(tempo), dormir: async (ms) => { tempo += ms; }, orcamentoMs: 135000 } });
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(mem.envios.map((e) => e.estado)).toEqual(["enviado", "pendente", "pendente"]);
  });

  it("não envia parte vencida quando o prazo da volta já acabou", async () => {
    let tempo = DIA.getTime();
    const mem = motorEmMemoria(DIA, { ...configDoMotor(ORG, "real"), fonteStageId: null }, [lead]);
    mem.envios.push(...[1, 2, 3].map((n) => parte(DIA, { id: `p${n}`, tipo: `funil_valores:${n}` })));
    const enviarReal = vi.fn<EnvioReal>(async () => { tempo += 2000; return { externalId: "ok" }; });
    await rodarDisparo({ repo: mem.repo, agora: DIA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO, sequencia: { relogio: () => new Date(tempo), dormir: async (ms) => { tempo += ms; }, orcamentoMs: 1000 } });
    expect(enviarReal).toHaveBeenCalledTimes(2);
    expect(mem.envios[2]!.estado).toBe("pendente");
  });

  it("não chama o canal se as consultas da parte consumirem o prazo", async () => {
    let tempo = DIA.getTime();
    let leituras = 0;
    const mem = motorEmMemoria(DIA, { ...configDoMotor(ORG, "real"), fonteStageId: null }, [lead]);
    mem.envios.push(...[1, 2].map((n) => parte(DIA, { id: `p${n}`, tipo: `funil_valores:${n}` })));
    const original = mem.repo.respostasDesde;
    mem.repo.respostasDesde = async (...args) => { if (++leituras === 2) tempo += 2000; return original(...args); };
    const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "ok" }));
    await rodarDisparo({ repo: mem.repo, agora: DIA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO, sequencia: { relogio: () => new Date(tempo), dormir: async (ms) => { tempo += ms; }, orcamentoMs: 1000 } });
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(mem.envios[1]!.estado).toBe("pendente");
  });

  it("não começa parte cuja presença estouraria o orçamento da volta", async () => {
    let tempo = DIA.getTime();
    const mem = motorEmMemoria(DIA, { ...configDoMotor(ORG, "real"), fonteStageId: null }, [lead]);
    mem.envios.push(parte(DIA, { id: "p1", tipo: "funil_valores:1" }), parte(DIA, { id: "p2", tipo: "funil_valores:2", presenca: "gravando", presencaMs: 25000 }));
    const enviarReal = vi.fn<EnvioReal>(async () => { tempo += 1000; return { externalId: "ok" }; });
    await rodarDisparo({ repo: mem.repo, agora: DIA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO, sequencia: { relogio: () => new Date(tempo), dormir: async (ms) => { tempo += ms; }, orcamentoMs: 20000 } });
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(mem.envios[1]!.estado).toBe("pendente");
  });

  it("a presença do passo vai ao envio real", async () => {
    const v = await volta(DIA, [parte(DIA, { presenca: "gravando", presencaMs: 20000 })]);
    expect(v.enviarReal).toHaveBeenCalledTimes(1);
    expect(v.enviarReal.mock.calls[0]![0].presenca).toEqual({ tipo: "gravando", ms: 20000 });
  });

  it("passo sem presença não pede presença", async () => {
    const v = await volta(DIA, [parte(DIA)]);
    expect(v.enviarReal.mock.calls[0]![0].presenca ?? null).toBeNull();
  });

  it("às 23h30 o funil do operador sai (a janela não barra envio manual)", async () => {
    const v = await volta(NOITE, [parte(NOITE)]);
    expect(v.enviarReal).toHaveBeenCalledTimes(1);
    expect(v.envios[0]!.estado).toBe("enviado");
  });

  it("irmão: às 23h30 a resposta automática continua sem sair (vai para a próxima janela)", async () => {
    const v = await volta(NOITE, [parte(NOITE, { id: "a1", origem: "auto", tipo: "tabela_valores:seq" })]);
    expect(v.enviarReal).not.toHaveBeenCalled();
    expect(v.envios[0]!.estado).toBe("pendente");
  });

  // Retomada de uma organização: os lembretes do kit planejados depois do funil do operador (`aposFunilDoOperador`)
  // são toques do motor como os do atendimento, e a lead ter escrito depois de planejados os cancela na hora de enviar.
  it("toque do kit planejado depois do funil do operador é cancelado se a lead escreveu depois", async () => {
    const toque = parte(DIA, { id: "k1", origem: "motor", tipo: "kit_t1_261023150000", texto: "Maria, ficou alguma dúvida?" });
    const mem = motorEmMemoria(DIA, { ...configDoMotor(ORG, "real"), fonteStageId: null }, [lead], { respostas: () => ["oi, vi os valores"] });
    mem.repo.situacaoDoKit = async () => ({ cliente: false, metodoPago: false, precisaOperador: false, quarentenaAte: null });
    mem.envios.push(toque);
    const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid-1" }));
    await rodarDisparo({ repo: mem.repo, agora: DIA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(mem.envios[0]!.estado).toBe("cancelado");
    expect(mem.envios[0]!.motivo).toMatch(/escreveu/);
  });

  it("irmão: o mesmo toque sai quando a lead não escreveu", async () => {
    const toque = parte(DIA, { id: "k1", origem: "motor", tipo: "kit_t1_261023150000", texto: "Maria, ficou alguma dúvida?" });
    const mem = motorEmMemoria(DIA, { ...configDoMotor(ORG, "real"), fonteStageId: null }, [lead]);
    mem.repo.situacaoDoKit = async () => ({ cliente: false, metodoPago: false, precisaOperador: false, quarentenaAte: null });
    mem.envios.push(toque);
    const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid-1" }));
    await rodarDisparo({ repo: mem.repo, agora: DIA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
    expect(mem.envios[0]!.estado).toBe("enviado");
  });
});
