import { expect, it } from "vitest";
import { RITMO_PADRAO } from "./config";
import { calcularSaude, resumirSinais } from "./saude";
import { avaliarSaudeDoChip } from "./saude-job";
import { configDoMotor, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";

const agora = new Date("2026-11-05T15:00:00Z");
const inicio = new Date("2026-11-05T03:00:00Z");
it("recusas de aberturas anteriores não contaminam a taxa das aberturas de hoje", () => {
  const abertura = (leadId: string, enviadoEm: Date) => ({ leadId, enviadoEm, estado: "enviado" as const, ack: null, entregueEm: null });
  const aberturas = [...Array.from({length: 15}, (_, i) => abertura(`hoje${i}`, new Date("2026-11-05T10:00:00Z"))), abertura("antigo1", new Date("2026-11-04T10:00:00Z")), abertura("antigo2", new Date("2026-11-04T10:00:00Z"))];
  const respostas = ["antigo1", "antigo2"].map(leadId => ({leadId, texto: "não tenho interesse", em: new Date("2026-11-05T11:00:00Z")}));
  const s = resumirSinais({aberturas, respostas, conexao: [], inicioDoDia: inicio, agora}, RITMO_PADRAO.saude);
  expect(calcularSaude(s, RITMO_PADRAO.saude).taxas.naoQuero).toBe(0);
});
it("freio desligado = nada muda sozinho: vermelho vencido e conectado NAO volta", async () => {
  const config = configDoMotor("org", "simulado");
  config.ritmo.saude = { ...config.ritmo.saude, ligado: false };
  const m = motorEmMemoria(agora, config, []);
  const pausadoAte = new Date(agora.getTime()-1000);
  Object.assign(m.chip, {saude: "vermelho", estado: "rampa", pausadoAte});
  const repo = {...m.repo, sessaoConectada: async () => true};
  await avaliarSaudeDoChip(repo, config, m.chip, agora);
  expect(m.chip.saude).toBe("vermelho");
  expect(m.chip.estado).toBe("rampa");
  expect(m.chip.pausadoAte).toEqual(pausadoAte);
});
it("freio ligado ainda recupera vermelho vencido conectado", async () => {
  const config = configDoMotor("org", "simulado");
  config.ritmo.saude = { ...config.ritmo.saude, ligado: true };
  const m = motorEmMemoria(agora, config, []);
  Object.assign(m.chip, {saude: "vermelho", estado: "rampa", pausadoAte: new Date(agora.getTime()-1000), saudeCalculadaEm: null});
  const repo = {...m.repo, sessaoConectada: async () => true, dadosDaSaude: async () => ({ aberturas: [], respostas: [], conexao: [] }), saudeDoDia: async () => null, gravarSaudeDoDia: async () => undefined};
  await avaliarSaudeDoChip(repo, config, m.chip, agora);
  expect(m.chip.saude).toBe("amarelo");
});
it("freio desligado preserva pausa manual de chip vermelho", async () => {
  const config = configDoMotor("org", "simulado");
  config.ritmo.saude = { ...config.ritmo.saude, ligado: false };
  const m = motorEmMemoria(agora, config, []);
  Object.assign(m.chip, {saude: "vermelho", estado: "pausado", pausadoAte: new Date(agora.getTime()-1000)});
  await avaliarSaudeDoChip({...m.repo, sessaoConectada: async () => true}, config, m.chip, agora);
  expect(m.chip.estado).toBe("pausado");
});


it("sequ?ncia bloqueada n?o impede envio vencido de outra lead", async () => {
  const { rodarDisparo } = await import("./motor");
  const config = { ...configDoMotor("org", "simulado"), fonteStageId: null };
  const lead = (id: string) => ({ id, nome: id, telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} });
  const m = motorEmMemoria(agora, config, [lead("a"), lead("b")]);
  const parte = (id: string, leadId: string, tipo: string, estado: "enviando" | "pendente", atraso: number) => ({id, leadId, chipId: "chip-1", tipo, origem: "operador" as const, texto: "mensagem", midia: null, midiaId: null, enviarApos: new Date(agora.getTime()-atraso), estado, tentativas: 0, criadoEm: new Date(agora.getTime()-100000), daParada: false});
  m.envios.push(parte("a1", "a", "funil_valores:1", "enviando", 90000), parte("a2", "a", "funil_valores:2", "pendente", 80000), parte("b1", "b", "funil_valores:1", "pendente", 70000));
  await rodarDisparo({repo: m.repo, agora, ambiente: {}, sortear: () => 0.5, enviarReal: async () => ({externalId: null}), enviarAviso: SEM_AVISO});
  expect(m.envios.find(e => e.id === "a2")?.estado).toBe("pendente");
  expect(m.envios.find(e => e.id === "b1")?.estado).toBe("simulado");
});

it("parte de abertura adiada nao bloqueia envio de outro lead", async () => {
  const { rodarDisparo } = await import("./motor");
  const config = { ...configDoMotor("org", "simulado"), fonteStageId: null };
  const lead = (id: string) => ({ id, nome: id, telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} });
  const m = motorEmMemoria(agora, config, [lead("a"), lead("b")]);
  const parte = (id: string, leadId: string, tipo: string, origem: "motor" | "operador", atraso: number) => ({id, leadId, chipId: "chip-1", tipo, origem, texto: "mensagem", midia: null, midiaId: null, enviarApos: new Date(agora.getTime()-atraso), estado: "pendente" as const, tentativas: 0, criadoEm: new Date(agora.getTime()-100000), daParada: false});
  m.envios.push(parte("a1", "a", "abertura", "motor", -60000), parte("a2", "a", "abertura_p2", "motor", 80000), parte("b1", "b", "funil_valores:1", "operador", 70000));
  await rodarDisparo({repo: m.repo, agora, ambiente: {}, sortear: () => 0.5, enviarReal: async () => ({externalId: null}), enviarAviso: SEM_AVISO});
  expect(m.envios.find(e => e.id === "a2")?.estado).toBe("pendente");
  expect(m.envios.find(e => e.id === "b1")?.estado).toBe("simulado");
});
