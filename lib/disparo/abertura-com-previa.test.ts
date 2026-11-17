// @vitest-environment node
import { expect, it } from "vitest";
import { configDoMotor, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import { rodarDisparo, type LeadDoDisparo } from "./motor";

it("abre com texto, imagem do lead e fecho na mesma volta", async () => {
  const agora = new Date("2026-10-23T15:00:00Z");
  const org = "00000000-0000-4000-8000-0000000000c1";
  const config = configDoMotor(org, "real");
  const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: { abertura_midia_id: "00000000-0000-4000-8000-000000000001", abertura_fecho: "Quer ver ele completo?" } };
  const mem = motorEmMemoria(agora, config, [lead]);
  let t = agora.getTime();
  const saidas: Array<{ texto: string; midiaId: string | null; tempo: number }> = [];
  await rodarDisparo({ repo: mem.repo, agora, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarAviso: SEM_AVISO,
    enviarReal: async ({ texto, midiaId }) => { saidas.push({ texto, midiaId, tempo: t - agora.getTime() }); return { externalId: "ok" }; },
    sequencia: { relogio: () => new Date(t), dormir: async (ms) => { t += ms; }, orcamentoMs: 60000 },
  });
  expect(saidas.map((s) => [s.midiaId, s.tempo])).toEqual([[null, 0], ["00000000-0000-4000-8000-000000000001", 3000], [null, 6000]]);
  expect(saidas[2]?.texto).toBe("Quer ver ele completo?");
});

async function caso(campos: Record<string, unknown>, opcoes: { mediaValida?: boolean; bloqueado?: boolean; respondeu?: () => boolean } = {}) {
  const agora = new Date("2026-10-23T15:00:00Z");
  const config = configDoMotor("00000000-0000-4000-8000-0000000000c1", "real");
  const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: opcoes.bloqueado ?? false, anonimizado: false, grupo: null, campos };
  let instante = agora.getTime();
  const mem = motorEmMemoria(agora, config, [lead], { respostas: () => opcoes.respondeu?.() ? ["respondi"] : [] });
  mem.repo.midiaDaAberturaValida = async () => opcoes.mediaValida ?? true;
  const saidas: string[] = [];
  const rodar = () => rodarDisparo({ repo: mem.repo, agora: new Date(instante), ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarAviso: SEM_AVISO,
    enviarReal: async ({ texto, midiaId }) => { saidas.push(midiaId ?? texto); return { externalId: "ok" }; },
    sequencia: { relogio: () => new Date(instante), dormir: async (ms) => { instante += ms; }, orcamentoMs: 60000 },
  });
  await rodar();
  return { ...mem, saidas, rodar };
}
const idPrevia = "00000000-0000-4000-8000-000000000001";

it("sem mídia conserva a abertura simples", async () => {
  const v = await caso({});
  expect(v.saidas).toHaveLength(1);
  expect(v.envios.some((e) => e.tipo.startsWith("abertura_p"))).toBe(false);
});
it("mídia ausente na organização cancela a abertura antes de enviar texto", async () => {
  const v = await caso({ abertura_midia_id: idPrevia }, { mediaValida: false });
  expect(v.saidas).toEqual([]);
  expect(v.envios[0]).toMatchObject({ tipo: "abertura", estado: "cancelado", motivo: expect.stringMatching(/prévia indisponível/) });
});
it("lead bloqueado não recebe nenhuma parte", async () => {
  const v = await caso({ abertura_midia_id: idPrevia, abertura_fecho: "Quer ver?" }, { bloqueado: true });
  expect(v.saidas).toEqual([]);
  expect(v.envios.every((e) => e.estado === "cancelado")).toBe(true);
});
it("se o lead responde depois do texto, não manda a imagem nem o fecho", async () => {
  let chamadas = 0;
  const v = await caso({ abertura_midia_id: idPrevia, abertura_fecho: "Quer ver?" }, { respondeu: () => ++chamadas > 1 });
  expect(v.saidas).toHaveLength(1);
  expect(v.envios.filter((e) => e.tipo.startsWith("abertura_p")).every((e) => e.estado === "cancelado")).toBe(true);
});
it("fecho com link barra toda a abertura", async () => {
  const v = await caso({ abertura_midia_id: idPrevia, abertura_fecho: "Veja https://exemplo.com" });
  expect(v.saidas).toEqual([]);
  expect(v.envios[0]?.motivo).toMatch(/fecho inválido/);
});

it("partes seguintes não consomem teto de abertura e contam como envios", async () => {
  const agora = new Date("2026-10-23T15:00:00Z"), config = configDoMotor("00000000-0000-4000-8000-0000000000c1", "real");
  config.ritmo = { ...config.ritmo, maxAberturasHora: 1, maxEnviosHora: 2 };
  const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: { abertura_midia_id: idPrevia, abertura_fecho: "Quer ver?" } };
  let t = agora.getTime();
  const mem = motorEmMemoria(agora, config, [lead]);
  mem.repo.contagem = async () => {
    const saidos = mem.envios.filter((e) => e.estado === "enviado" || e.estado === "simulado");
    return { ultimoEnvioEm: null, ultimaNovaEm: null, enviosHoje: saidos.length, aberturasHoje: saidos.filter((e) => e.tipo === "abertura").length, enviosUltimaHora: saidos.length, aberturasUltimaHora: saidos.filter((e) => e.tipo === "abertura").length };
  };
  const saidas: string[] = [];
  await rodarDisparo({ repo: mem.repo, agora, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarAviso: SEM_AVISO,
    enviarReal: async ({ midiaId }) => { saidas.push(midiaId ?? "texto"); return { externalId: "ok" }; },
    sequencia: { relogio: () => new Date(t), dormir: async (ms) => { t += ms; }, orcamentoMs: 60000 },
  });
  expect(saidas).toEqual(["texto", idPrevia]);
  expect(mem.envios.find((e) => e.tipo === "abertura_p3")?.estado).toBe("pendente");
});

it("abertura barrada pela allowlist não permite partes em volta posterior", async () => {
  const agora = new Date("2026-10-23T15:00:00Z"), config = configDoMotor("00000000-0000-4000-8000-0000000000c1", "real");
  const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: { abertura_midia_id: idPrevia, abertura_fecho: "Quer ver?" } };
  const mem = motorEmMemoria(agora, config, [lead]);
  const saidas: string[] = [];
  const rodada = (instante: Date) => rodarDisparo({ repo: mem.repo, agora: instante, ambiente: { DISPARO_REAL_LIBERADO: "sim", DISPARO_SO_PARA: "5511888888888" }, sortear: () => 0.5, enviarAviso: SEM_AVISO, enviarReal: async ({ texto }) => { saidas.push(texto); return { externalId: "ok" }; } });
  await rodada(agora);
  await rodada(new Date(agora.getTime() + 10000));
  await rodada(new Date(agora.getTime() + 20000));
  expect(saidas).toEqual([]);
  expect(mem.envios.filter((e) => e.tipo.startsWith("abertura")).every((e) => e.estado === "cancelado")).toBe(true);
});

it("após falha e nova tentativa, nenhuma parte ultrapassa a abertura", async () => {
  const agora = new Date("2026-10-23T15:00:00Z"), config = configDoMotor("00000000-0000-4000-8000-0000000000c1", "real");
  const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: { abertura_midia_id: idPrevia, abertura_fecho: "Quer ver?" } };
  const mem = motorEmMemoria(agora, config, [lead]);
  let instante = agora.getTime(), primeira = true;
  const saidas: Array<{ valor: string; instante: number }> = [];
  const rodar = () => rodarDisparo({ repo: mem.repo, agora: new Date(instante), ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarAviso: SEM_AVISO,
    enviarReal: async ({ texto, midiaId }) => { if (primeira) { primeira = false; throw new Error("timeout"); } saidas.push({ valor: midiaId ?? texto, instante }); return { externalId: "ok" }; },
    sequencia: { relogio: () => new Date(instante), dormir: async (ms) => { instante += ms; }, orcamentoMs: 120000 },
  });
  await rodar();
  instante = agora.getTime() + 600000;
  await rodar();
  instante += 1000;
  await rodar();
  instante += 1000;
  await rodar();
  expect(saidas.map((s) => s.valor)).toEqual([expect.stringContaining("novidade"), idPrevia, "Quer ver?"]);
  expect(saidas[1]!.instante - saidas[0]!.instante).toBeGreaterThanOrEqual(3000);
  expect(saidas[2]!.instante - saidas[1]!.instante).toBeGreaterThanOrEqual(3000);
});
