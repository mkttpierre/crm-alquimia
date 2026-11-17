import { expect, it, vi } from "vitest";
import { configDoMotor, motorEmMemoria, type LinhaEnvio } from "./apoio-do-motor-teste";
import { rodarDisparo, type LeadDoDisparo } from "./motor";
import { H, MIN } from "./ritmo";

const agora = new Date("2026-10-07T13:00:00Z");
const org = "00000000-0000-4000-8000-0000000000e1";
const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

it("após três falhas de timeout, agenda uma única chance para 24 horas depois", async () => {
  const m = motorEmMemoria(agora, configDoMotor(org, "real"), [lead]);
  const envio: LinhaEnvio = { id: "e", leadId: lead.id, chipId: m.chip.id, tipo: "abertura", origem: "motor", texto: "Oi Maria, tudo bem?", midia: null, midiaId: null, enviarApos: new Date(agora.getTime() - MIN), estado: "pendente", tentativas: 2, criadoEm: agora, daParada: false };
  m.envios.push(envio);
  const rodar = (data: Date) => rodarDisparo({ repo: m.repo, agora: data, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal: vi.fn(async () => { throw new Error("timeout"); }), enviarAviso: vi.fn(async () => ({ externalId: null })) });
  await rodar(agora);
  expect(envio.estado).toBe("pendente");
  expect(envio.enviarApos).toEqual(new Date(agora.getTime() + 24 * H));
  expect(envio.tentativas).toBe(3);
  m.chip.proximoEnvioEm = new Date(agora.getTime() + 24 * H);
  await rodar(new Date(agora.getTime() + 24 * H));
  expect(envio.estado).toBe("falhou");
  expect(envio.tentativas).toBe(4);
});

it("evolution_400 não recebe chance extra", async () => {
  const m = motorEmMemoria(agora, configDoMotor(org, "real"), [lead]);
  const envio: LinhaEnvio = { id: "e", leadId: lead.id, chipId: m.chip.id, tipo: "abertura", origem: "motor", texto: "Oi Maria, tudo bem?", midia: null, midiaId: null, enviarApos: new Date(agora.getTime() - MIN), estado: "pendente", tentativas: 2, criadoEm: agora, daParada: false };
  m.envios.push(envio);
  await rodarDisparo({ repo: m.repo, agora, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal: vi.fn(async () => { throw new Error("evolution_400"); }), enviarAviso: vi.fn(async () => ({ externalId: null })) });
  expect(envio.estado).toBe("falhou");
});
