// @vitest-environment node
/**
 * Lembretes do kit (`kit_t1..t4`) também quando o OPERADOR manda o funil de valores pela caixa de conversa (retomada
 * de uma organização). Antes, só o atendimento automático planejava os toques: o funil mandado à mão deixava a lead
 * sem lembrete nenhum. Tudo atrás de `followupKit.aposFunilDoOperador.ligado` (padrão desligado). Em memória: o
 * agendamento da sequência inteiro e o repositório do atendimento, sem banco nem canal.
 */
import { describe, expect, it } from "vitest";

import { configDoMotor } from "../apoio-do-motor-teste";
import { emDiaDeEnvio } from "../cadencia";
import type { Chip } from "../fila";
import { carimboDaBase, TIPO_TOQUE_DO_KIT } from "../kit-followup";
import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atendimentoSchema, type ConfigAtendimento } from "./config";
import { conversaNova } from "./estado";
import {
  agendarSequencia,
  cancelarSequencia,
  planejarKitAposFunilDoOperador,
  type EnvioDaSequencia,
  type FunilParaAgendar,
  type RepositorioSequencia,
} from "./sequencia-operador";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const CONVERSA = "00000000-0000-4000-8000-0000000000v1";
const AGORA = new Date("2026-10-21T15:00:00Z"); // quarta, 12h em São Paulo
const SORTE = () => 0.5;
const DIAS = [1, 2, 4, 6];

const RESPOSTAS_KIT = {
  kit_t1: [[{ texto: "{nome_virgula}ficou alguma dúvida sobre os tratamentos?" }]],
  kit_t2: [[{ texto: "O tratamento leva um minuto por dia." }]],
  kit_t3: [[{ texto: "O que mais pesa para você agora?" }]],
  kit_t4: [[{ texto: "Todos os kits têm garantia." }]],
};

type Opcoes = { ligado?: boolean; funis?: string[]; liberaOperador?: boolean; respostas?: Record<string, unknown> };
function configAtendimento(o: Opcoes = {}): ConfigAtendimento {
  const base = CONFIG_VENDA_EXEMPLO as { respostas: object };
  return atendimentoSchema.parse({
    ...CONFIG_VENDA_EXEMPLO,
    respostas: { ...base.respostas, ...RESPOSTAS_KIT, ...(o.respostas ?? {}) },
    followupKit: {
      ligado: true,
      toques: DIAS.map((dia, i) => ({ dia, resposta: `kit_t${i + 1}` })),
      aposFunilDoOperador: { ligado: o.ligado ?? true, ...(o.funis ? { funis: o.funis } : {}), ...(o.liberaOperador === undefined ? {} : { liberaOperador: o.liberaOperador }) },
    },
  });
}

const chip: Chip = { id: "chip-1", nome: "chip-alfa", estado: "rampa", saude: "verde", diaRampa: 5, proximoEnvioEm: null, pausadoAte: null, enviosDesdePausa: 0, pausaACada: 15 };

const funil = (atalho: string): FunilParaAgendar => ({
  id: `funil-${atalho}`,
  titulo: atalho,
  atalho,
  passos: [
    { modelo: { atalho: "v1", titulo: "1", corpo: "Vou te explicar os valores.", midia: null }, atrasoMs: 0, presenca: "digitando", presencaMs: 2_000 },
    { modelo: { atalho: "v2", titulo: "2", corpo: "Qual tratamento deseja iniciar?", midia: null }, atrasoMs: 3_000, presenca: "digitando", presencaMs: 2_000 },
  ],
});

/** Um cenário: o repositório do atendimento (em memória) e a sequência montada em cima dele, como no Supabase. */
function cenario(o: Opcoes & { modo?: "real" | "simulado"; campos?: Record<string, unknown> } = {}) {
  const at = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, "real"), configAtendimento(o));
  at.novoLead("lead-1", { campos: o.campos ?? { classe: "frio", trilha: "morna" } });
  const gravados: EnvioDaSequencia[] = [];
  let falharCancelamento = false;
  const cancelarKit = async (_org: string, leadId: string, motivo: string) => {
    if (falharCancelamento) throw new Error("banco fora");
    let n = 0;
    for (const e of at.envios) {
      if (e.leadId === leadId && !e.cancelado && e.estado === "pendente" && /^(kit_t|metodo_oferta_)/.test(e.tipo)) {
        e.cancelado = motivo;
        n++;
      }
    }
    return n;
  };
  const config = { ...configDoMotor(ORG, o.modo ?? "real"), proibidos: [] };
  const repo: RepositorioSequencia = {
    config: async () => config,
    leadDaConversa: async () => "lead-1",
    lead: async () => ({ id: "lead-1", nome: "Maria Souza", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false }),
    garantirLead: async () => null,
    chipDaConversa: async () => chip,
    funil: async (_o, _u, ref) => funil(ref.atalho ?? "funil-valores"),
    modeloPorId: async () => null,
    emAberto: async () => 0,
    enfileirar: async (_o, envios) => void gravados.push(...envios),
    cancelar: async () => 0,
    planejarKitAposFunil: (org, p) => planejarKitAposFunilDoOperador({ repo: at, cancelarKit }, org, p),
    cancelarKitDoLead: cancelarKit,
  };
  const agendar = (agora = AGORA, atalho = "funil-valores", confirmar = false) =>
    agendarSequencia({ repo, agora, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: SORTE }, ORG, { conversationId: CONVERSA, usuarioId: "u1", atalho, confirmar });
  const toques = () => at.enviosDo("lead-1").filter((e) => TIPO_TOQUE_DO_KIT.test(e.tipo));
  return { at, repo, gravados, agendar, toques, falhar: () => (falharCancelamento = true), conversa: () => at.conversas.get("lead-1") };
}

describe("lembretes do kit depois do funil do operador", () => {
  it("grava os 4 toques uma vez, em D+1, D+2, D+4 e D+6 dias de envio depois da chegada da última parte", async () => {
    const c = cenario();
    const r = await c.agendar();
    const t = c.toques();
    expect(t).toHaveLength(4);
    expect(t.every((e) => e.origem === "motor" && e.estado === "pendente" && e.chipId === "chip-1")).toBe(true);
    const ritmo = configDisparoExemplo(ORG).ritmo;
    expect(t.map((e) => e.enviarApos.toISOString())).toEqual(DIAS.map((d) => emDiaDeEnvio(r.ultimaEm, d, ritmo, SORTE).toISOString()));
    expect(t.map((e) => e.tipo)).toEqual(DIAS.map((_d, i) => `kit_t${i + 1}_${carimboDaBase(r.ultimaEm)}`));
    expect(t[0]!.texto).toBe("Maria, ficou alguma dúvida sobre os tratamentos?");
    expect(r.kit).toMatch(/4 toque/);
  });

  it("marca a conversa como quem viu a tabela e libera a pendência do operador", async () => {
    const c = cenario();
    c.at.conversas.set("lead-1", { ...conversaNova(), precisaOperador: true, motivoOperador: "não consegui ler", ultimaAutoEm: null });
    await c.agendar();
    const conv = c.conversa()!;
    expect(conv.dados.tabelaEnviada).toBe(true);
    expect(conv.dados.degrau).toBe(0);
    expect(conv.dados.explicacaoEnviada).toBe(true);
    expect(conv.etapa).toBe("qualificando");
    expect(conv.precisaOperador).toBe(false);
    expect(conv.motivoOperador).toBeNull();
    expect(c.toques()).toHaveLength(4);
  });

  it("quem já estava num degrau da escada não volta para o degrau 0", async () => {
    const c = cenario();
    const base = conversaNova();
    c.at.conversas.set("lead-1", { ...base, etapa: "qualificando", dados: { ...base.dados, tabelaEnviada: true, degrau: 2 }, ultimaAutoEm: null });
    await c.agendar();
    expect(c.conversa()!.dados.degrau).toBe(2);
    expect(c.toques()).toHaveLength(4);
  });

  it("repetir o funil (com confirmação) não duplica: o conjunto antigo é cancelado", async () => {
    const c = cenario();
    await c.agendar();
    const antigos = c.toques().map((e) => e.tipo);
    await c.agendar(new Date(AGORA.getTime() + 2 * 3600_000), "funil-valores", true);
    const vivos = c.toques();
    expect(vivos).toHaveLength(4);
    expect(vivos.some((e) => antigos.includes(e.tipo))).toBe(false);
    for (const t of antigos) expect(c.at.envios.find((e) => e.tipo === t)!.cancelado).toBeTruthy();
  });

  it("lead do teste A/B na trilha de cliente ganha os toques", async () => {
    const c = cenario({ campos: { classe: "P4", trilha: "posvenda", produto_origem: "produto", ab_teste: "1211" } });
    await c.agendar();
    expect(c.toques()).toHaveLength(4);
  });

  it("preço fora da tabela num toque pula só aquele toque (trava D5)", async () => {
    const c = cenario({ respostas: { kit_t2: [[{ texto: "Hoje sai por R$ 123" }]] } });
    const r = await c.agendar();
    expect(c.toques().map((e) => e.tipo.slice(0, 6))).toEqual(["kit_t1", "kit_t3", "kit_t4"]);
    expect(r.kit).toMatch(/pulado/);
  });

  it("cancelar a sequência cancela também os toques", async () => {
    const c = cenario();
    await c.agendar();
    const r = await cancelarSequencia({ repo: c.repo }, ORG, { conversationId: CONVERSA });
    expect(r.toquesDoKit).toBe(4);
    expect(c.toques()).toHaveLength(0);
  });

  it("falha no planejamento não derruba o agendamento: vira trecho do resultado e aviso na Central", async () => {
    const c = cenario();
    c.falhar();
    const r = await c.agendar();
    expect(c.gravados).toHaveLength(2);
    expect(r.kit).toMatch(/não planejados/);
    expect(c.at.avisos.some((a) => /kit/i.test(a.titulo))).toBe(true);
  });
});

describe("lembretes do kit depois do funil do operador: quando NÃO planeja", () => {
  const nada = async (c: ReturnType<typeof cenario>) => {
    await c.agendar();
    expect(c.toques()).toHaveLength(0);
  };

  it("opção desligada (padrão)", async () => {
    const c = cenario({ ligado: false });
    await nada(c);
    expect(c.conversa()).toBeUndefined();
  });

  it("config sem a chave lê desligado", () => {
    const at = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, followupKit: { ligado: true, toques: [{ dia: 1, resposta: "kit_t1" }] } });
    expect(at.perfil === "venda" && at.followupKit?.aposFunilDoOperador).toEqual({ ligado: false, funis: ["funil_valores"], liberaOperador: true });
  });

  it("modo simulado", async () => {
    await nada(cenario({ modo: "simulado" }));
  });

  it("funil fora da lista", async () => {
    const c = cenario();
    await c.agendar(AGORA, "boas-vindas");
    expect(c.toques()).toHaveLength(0);
  });

  it("humano no comando", async () => {
    const c = cenario();
    c.at.forceHuman.add("lead-1");
    await nada(c);
  });

  it("lead em não contatar", async () => {
    await nada(cenario({ campos: { nao_contatar: true } }));
  });

  it("cliente sem ab_teste", async () => {
    await nada(cenario({ campos: { classe: "P4", trilha: "posvenda", produto_origem: "produto" } }));
  });

  it("conversa já pronta para fechar", async () => {
    const c = cenario();
    c.at.conversas.set("lead-1", { ...conversaNova(), etapa: "pronto_fechar", quente: true, ultimaAutoEm: null });
    await nada(c);
  });

  it("liberaOperador desligado e a conversa com o operador", async () => {
    const c = cenario({ liberaOperador: false });
    c.at.conversas.set("lead-1", { ...conversaNova(), precisaOperador: true, motivoOperador: "x", ultimaAutoEm: null });
    await nada(c);
    expect(c.conversa()!.precisaOperador).toBe(true);
  });
});
