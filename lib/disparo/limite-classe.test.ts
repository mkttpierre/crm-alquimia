import { expect, it, vi } from "vitest";
import { configDoMotor, motorEmMemoria } from "./apoio-do-motor-teste";
import { lerRitmo } from "./config";
import { rodarDisparo, type LeadDoDisparo } from "./motor";

it("não envia abertura fria quando os chips juntos atingiram o teto do dia", async () => {
  const agora = new Date("2026-10-07T13:00:00Z");
  const config = configDoMotor("org", "simulado");
  config.ritmo = lerRitmo({ feriados: [], limitePorClasseDia: { frio: 35 } });
  const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: { classe: "frio" } };
  const m = motorEmMemoria(agora, config, [lead]);
  Object.assign(m.repo, { aberturasDaClasseNoDia: async () => 35, tomarTravaDaClasse: async () => true, soltarTravaDaClasse: async () => undefined });
  await rodarDisparo({ repo: m.repo, agora, ambiente: {}, sortear: () => 0.5, enviarReal: vi.fn(async () => ({ externalId: null })), enviarAviso: vi.fn(async () => ({ externalId: null })) });
  expect(m.envios.filter((e) => e.estado === "simulado")).toHaveLength(0);
});

it("duas voltas disputando a última vaga não enviam juntas", async () => {
  const agora = new Date("2026-10-07T13:00:00Z");
  const config = configDoMotor("org", "simulado");
  config.ritmo = lerRitmo({ feriados: [], limitePorClasseDia: { frio: 35 } });
  const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: { classe: "frio" } };
  const a = motorEmMemoria(agora, config, [lead]);
  const b = motorEmMemoria(agora, config, [{ ...lead, id: "l2" }]);
  b.chip.id = "chip-2";
  let ocupada = false;
  let liberar!: () => void;
  let entrou!: () => void;
  const espera = new Promise<void>((resolve) => { liberar = resolve; });
  const iniciada = new Promise<void>((resolve) => { entrou = resolve; });
  const regras = {
    tomarTravaDaClasse: async () => { if (ocupada) return false; ocupada = true; return true; },
    soltarTravaDaClasse: async () => { ocupada = false; },
    aberturasDaClasseNoDia: async () => { entrou(); await espera; return 34; },
  };
  Object.assign(a.repo, regras); Object.assign(b.repo, regras);
  const rodar = (repo: typeof a.repo) => rodarDisparo({ repo, agora, ambiente: {}, sortear: () => 0.5, enviarReal: vi.fn(async () => ({ externalId: null })), enviarAviso: vi.fn(async () => ({ externalId: null })) });
  const primeira = rodar(a.repo);
  await iniciada;
  await rodar(b.repo);
  liberar();
  await primeira;
  expect([...a.envios, ...b.envios].filter((e) => e.estado === "simulado")).toHaveLength(1);
});
