/**
 * Fechamento da etapa 1 do motor de disparo: o que entrou depois da 0234.
 *
 *  - lembrete (D4/D10 da organização B) vira tarefa na tela Tarefas, sem chip e sem canal;
 *  - filtro de relevância e teto diário dos lembretes, por organização;
 *  - cadeia de modelos: falta o nome, cai para o texto "sem nome";
 *  - passo sem texto possível é pulado e a cadência segue;
 *  - a busca de lead para abertura pagina (a primeira página cheia de leads já
 *    abertos não "seca" a etapa de origem).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { ritmoSchema, type ConfigDisparo } from "./config";
import type { Chip, Contagem } from "./fila";
import { rodarDisparo, type EnvioDaFila, type EnvioReal, type LeadDoDisparo, type NovoEnvio, type RepositorioDisparo, type TarefaDoLembrete } from "./motor";
import { SEM_AVISO, SEM_HUMANO_NEM_AVISOS } from "./apoio-do-motor-teste";
import { repositorioSupabase } from "./repositorio-supabase";
import { listasDoPasso, montar, slotsDoLead } from "./textos";

const ORG = "00000000-0000-4000-8000-000000000002";
const AGORA = new Date("2026-10-07T10:00:00-03:00"); // quarta

function configProspeccao(extra: Partial<ConfigDisparo> = {}): ConfigDisparo {
  return {
    organizationId: ORG,
    ligado: true,
    modo: "simulado",
    tetoDiario: null,
    cadencia: "prospeccao_14_dias",
    fonteStageId: "stage-1",
    ritmo: ritmoSchema.parse({
      feriados: [],
      janela: { semana: [{ inicio: 480, fim: 720 }, { inicio: 780, fim: 960 }], sabado: [], domingo: [] },
      lembretes: { tetoDia: { d4: 1, d10: 20 }, relevancia: [{ campo: "porta", igual: "acessivel" }] },
    }),
    modelos: {
      d1_sinal: ["Oi, {nome_completo}! Aqui é o {operador}. Vi {sinal_1} {no_bairro}."],
      d1_sem_nome: ["Oi! Aqui é o {operador}. Vi {sinal_1} {no_bairro}."],
      d2_sinal: ["{abre}reparei também: {sinal_2}."],
      d2_pergunta: ["{abre}conseguiu ver a mensagem?"],
      d7: ["{abre}o que eu faria primeiro: {diagnostico}"],
      d14: ["{abre}vou parar por aqui."],
    },
    proibidos: [],
    slots: { fixos: { operador: "Carlos" }, semNomeQuando: [{ campo: "porta", igual: "blindada" }] },
    escolha: [
      { tipo: "abertura", quando: [], lista: "d1_sinal" },
      { tipo: "abertura", quando: [], lista: "d1_sem_nome" },
      { tipo: "d2", quando: [], lista: "d2_sinal" },
      { tipo: "d2", quando: [], lista: "d2_pergunta" },
      { tipo: "d7", quando: [], lista: "d7" },
      { tipo: "d14", quando: [], lista: "d14" },
    ],
    ...extra,
  };
}

function lead(id: string, nome: string | null, campos: Record<string, unknown>): LeadDoDisparo {
  return { id, nome, telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos };
}

function repoEmMemoria(config: ConfigDisparo, leads: LeadDoDisparo[]) {
  const envios: (EnvioDaFila & { motivo?: string | null; externalId?: string | null })[] = [];
  const tarefas: TarefaDoLembrete[] = [];
  const chip: Chip = {
    id: "chip-1", estado: "ativo", saude: "verde", diaRampa: 5,
    proximoEnvioEm: new Date(AGORA.getTime() - 60_000), pausadoAte: null, enviosDesdePausa: 0, pausaACada: 15,
  };
  let n = 0;
  const vazia: Contagem = { ultimoEnvioEm: null, ultimaNovaEm: null, enviosHoje: 0, aberturasHoje: 0, enviosUltimaHora: 0, aberturasUltimaHora: 0 };
  const repo: RepositorioDisparo = {
    ...SEM_HUMANO_NEM_AVISOS,
    configsLigadas: async () => [config],
    chipsDaVolta: async () => [chip],
    contagem: async () => vazia,
    mandouDesde: async () => true,
    atualizarChip: async (_o, _c, patch) => (Object.assign(chip, patch), true),
    proximoLeadParaAbertura: async () => leads.find((l) => !envios.some((e) => e.leadId === l.id && e.tipo === "abertura")) ?? null,
    enfileirar: async (_o, e: NovoEnvio) => {
      if (envios.some((x) => x.leadId === e.leadId && x.tipo === e.tipo)) return null;
      const novo = {
        id: `envio-${++n}`, leadId: e.leadId, chipId: e.chipId, tipo: e.tipo, origem: e.origem, texto: e.texto, midia: null, midiaId: null,
        enviarApos: e.enviarApos, estado: e.estado ?? "pendente", tentativas: 0, criadoEm: AGORA, daParada: false, motivo: e.motivo ?? null,
      } as const;
      envios.push({ ...novo });
      return { ...novo };
    },
    vencidos: async () => [],
    lembretesVencidos: async (_o, agora) => envios.filter((e) => e.origem === "lembrete" && e.estado === "pendente" && e.enviarApos <= agora),
    reservar: async (_o, id) => {
      const e = envios.find((x) => x.id === id);
      if (!e || e.estado !== "pendente") return false;
      e.estado = "enviando";
      return true;
    },
    finalizar: async (_o, id, fim) => {
      const e = envios.find((x) => x.id === id)!;
      e.estado = fim.estado;
      if (fim.motivo !== undefined) e.motivo = fim.motivo;
      if (fim.externalId !== undefined) e.externalId = fim.externalId;
    },
    lead: async (_o, id) => leads.find((l) => l.id === id) ?? null,
    respostasDesde: async () => [],
    origensRecentes: async () => [],
    cancelarPendentesDoLead: async () => 0,
    autoEmAbertoAntes: async () => false,
    adiarAutoDoLead: async () => 0,
    criadosDesde: async () => 0,
    saiuEm: async () => AGORA,
    lembretesNoDia: async (_o, tipo, inicio, fim) =>
      envios.filter((e) => e.origem === "lembrete" && e.tipo === tipo && e.estado !== "cancelado" && e.enviarApos >= inicio && e.enviarApos < fim).length,
    criarTarefa: async (_o, t) => (tarefas.push(t), `tarefa-${tarefas.length}`),
  };
  return { repo, envios, tarefas, chip };
}

const rodar = (repo: RepositorioDisparo, agora = AGORA) =>
  rodarDisparo({ repo, agora, ambiente: {}, sortear: () => 0.5, enviarReal: vi.fn<EnvioReal>(), enviarAviso: SEM_AVISO });

describe("textos completos por organização", () => {
  it("slots do lead: campos, fixos da org, nome real e preposição do bairro", () => {
    const s = slotsDoLead(lead("l", "Dra. Ana Souza", { sinal_1: "a ficha sem horário", bairro: "Mooca" }), configProspeccao().slots, AGORA, -180);
    expect(montar("Oi, {nome_completo}! {operador} {sinal_1} {no_bairro} {nome_curto}", s).texto).toBe(
      "Oi, Dra. Ana Souza! Carlos a ficha sem horário na Mooca Dra. Ana",
    );
  });

  it("recepção (porta blindada) não é chamada pelo nome, e slot vazio obrigatório conta como faltando", () => {
    const s = slotsDoLead(lead("l", "Ana", { porta: "blindada" }), configProspeccao().slots, AGORA, -180);
    expect(s["abre"]).toBe("");
    expect(montar("{abre}tudo bem?", s)).toEqual({ texto: "Tudo bem?", faltando: [] });
    expect(montar("Oi, {nome_completo}!", s).faltando).toEqual(["nome_completo"]);
  });

  it("escolha em ordem filtra por condição; sem regra vale tipo:grupo e tipo", () => {
    const escolha = [
      { tipo: "abertura", quando: [{ campo: "classe", igual: "C" }], lista: "a_c" },
      { tipo: "abertura", quando: [], lista: "a" },
    ];
    const modelos = { a_c: ["c"], a: ["a"], "toque_2:frio": ["f"], toque_2: ["t"] };
    expect(listasDoPasso(modelos, escolha, "abertura", { grupo: null, campos: { classe: "C" } }).map((l) => l.lista)).toEqual(["a_c", "a"]);
    expect(listasDoPasso(modelos, escolha, "abertura", { grupo: null, campos: { classe: "A" } }).map((l) => l.lista)).toEqual(["a"]);
    expect(listasDoPasso(modelos, escolha, "toque_2", { grupo: "frio", campos: {} }).map((l) => l.lista)).toEqual(["toque_2:frio", "toque_2"]);
  });
});

describe("motor: cadeia de modelos, passo pulado e lembretes", () => {
  it("sem nome, a abertura cai para o modelo sem nome; d2 sem sinal_2 cai para a pergunta; d7 sem diagnóstico é pulado e a cadência segue", async () => {
    const config = configProspeccao();
    const { repo, envios } = repoEmMemoria(config, [lead("l1", null, { porta: "acessivel", sinal_1: "a ficha sem horário", bairro: "Tatuapé" })]);
    await rodar(repo);
    const abertura = envios.find((e) => e.tipo === "abertura")!;
    expect(abertura.estado).toBe("simulado");
    expect(abertura.texto).toBe("Oi! Aqui é o Carlos. Vi a ficha sem horário no Tatuapé.");
    expect(envios.find((e) => e.tipo === "d2")!.texto).toBe("Conseguiu ver a mensagem?");
  });

  it("depois do d2, o d4 (lembrete) vai sem chip; o d7 sem diagnóstico é pulado e o d14 é planejado", async () => {
    const config = configProspeccao();
    const l = lead("l1", "Ana", { porta: "acessivel", sinal_1: "x", bairro: "Penha" });
    const { repo, envios } = repoEmMemoria(config, [l]);
    await rodar(repo);
    // Simula o d2 saindo: o motor planeja a partir dele.
    const d2 = envios.find((e) => e.tipo === "d2")!;
    d2.enviarApos = AGORA;
    (repo as { vencidos: RepositorioDisparo["vencidos"] }).vencidos = async () => (d2.estado === "pendente" ? [d2] : []);
    const depois = new Date(AGORA.getTime() + 25 * 60_000);
    await rodar(repo, depois);
    expect(d2.estado).toBe("simulado");
    const d4 = envios.find((e) => e.tipo === "d4")!;
    expect(d4.origem).toBe("lembrete");
    expect(d4.chipId).toBeNull();
    expect(d4.estado).toBe("pendente");
    expect(envios.find((e) => e.tipo === "d7")).toMatchObject({ estado: "cancelado", motivo: expect.stringContaining("diagnostico") });
    expect(envios.find((e) => e.tipo === "d14")!.estado).toBe("pendente");
  });

  it("lembrete vencido vira tarefa (crm_tasks) e nunca vai ao canal", async () => {
    const config = configProspeccao();
    const l = lead("l1", "Ana", { porta: "acessivel" });
    const { repo, envios, tarefas } = repoEmMemoria(config, [l]);
    await repo.enfileirar(ORG, { leadId: "l1", chipId: null, tipo: "d4", origem: "lembrete", texto: "Lembrete D4: gravar...", enviarApos: AGORA });
    const enviarReal = vi.fn<EnvioReal>();
    const r = await rodarDisparo({ repo, agora: AGORA, ambiente: {}, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(tarefas).toHaveLength(1);
    expect(tarefas[0]).toMatchObject({ leadId: "l1", descricao: "Lembrete D4: gravar...", titulo: "D4: gravar áudio para Ana (ensaio)" });
    expect(envios[0]).toMatchObject({ estado: "simulado", externalId: "crm_task:tarefa-1" });
    expect(r.organizacoes[0]!.lembretes).toBe(1);
  });

  it("lembrete de lead fora do filtro de relevância é pulado (registrado), e o teto do dia segura o excedente", async () => {
    const config = configProspeccao();
    const { repo, envios } = repoEmMemoria(config, [
      lead("rel1", "Ana", { porta: "acessivel", sinal_1: "x" }),
      lead("rel2", "Bia", { porta: "acessivel", sinal_1: "x" }),
      lead("fora", "Cris", { porta: "rede", sinal_1: "x" }),
    ]);
    // Três d2 saindo juntos: cada um planeja o seu d4 no mesmo dia (teto d4 = 1).
    for (const id of ["rel1", "rel2", "fora"]) {
      await repo.enfileirar(ORG, { leadId: id, chipId: "chip-1", tipo: "abertura", origem: "motor", texto: "x", enviarApos: AGORA, estado: "simulado" });
      await repo.enfileirar(ORG, { leadId: id, chipId: "chip-1", tipo: "d2", origem: "motor", texto: "Conseguiu ver?", enviarApos: AGORA });
    }
    const fila = envios.filter((e) => e.tipo === "d2");
    (repo as { vencidos: RepositorioDisparo["vencidos"] }).vencidos = async () => fila.filter((e) => e.estado === "pendente").slice(0, 1);
    for (let i = 0; i < 3; i++) {
      const chip = (await repo.chipsDaVolta(ORG))[0]!;
      chip.proximoEnvioEm = new Date(AGORA.getTime() - 60_000);
      await rodar(repo);
    }
    const d4 = (id: string) => envios.find((e) => e.tipo === "d4" && e.leadId === id)!;
    expect(d4("fora")).toMatchObject({ estado: "cancelado", motivo: "fora do filtro de relevância" });
    const vivos = ["rel1", "rel2"].map(d4).filter((e) => e.estado === "pendente");
    const barrados = ["rel1", "rel2"].map(d4).filter((e) => e.estado === "cancelado");
    expect(vivos).toHaveLength(1);
    expect(barrados[0]!.motivo).toBe("teto de 1 lembretes d4 no dia");
  });
});

/** Cliente Supabase falso, só com o encadeamento que `proximoLeadParaAbertura` usa. */
function dbFalso(leads: { id: string }[], abertos: Set<string>) {
  const consultas: { tabela: string; de?: number; ate?: number }[] = [];
  const builder = (tabela: string) => {
    const q: { tabela: string; de?: number; ate?: number; ids?: string[] } = { tabela };
    const b: Record<string, unknown> = {};
    const eu = () => b;
    for (const m of ["select", "eq", "order"]) b[m] = eu;
    b["in"] = (_c: string, ids: string[]) => ((q.ids = ids), b);
    b["range"] = (de: number, ate: number) => ((q.de = de), (q.ate = ate), b);
    b["then"] = (ok: (r: unknown) => void) => {
      consultas.push({ tabela: q.tabela, de: q.de, ate: q.ate });
      if (q.tabela === "crm_leads") {
        const pagina = leads.slice(q.de!, q.ate! + 1).map((l) => ({ id: l.id, status: "open", custom_fields: {}, contact: null }));
        return ok({ data: pagina, error: null });
      }
      return ok({ data: (q.ids ?? []).filter((id) => abertos.has(id)).map((lead_id) => ({ lead_id })), error: null });
    };
    return b;
  };
  return { db: { from: builder } as unknown as SupabaseClient, consultas };
}

describe("abertura: paginação da etapa de origem", () => {
  it("acha o lead livre depois de uma página inteira já aberta", async () => {
    const leads = Array.from({ length: 450 }, (_, i) => ({ id: `lead-${i}` }));
    const abertos = new Set(leads.slice(0, 430).map((l) => l.id));
    const { db, consultas } = dbFalso(leads, abertos);
    const achado = await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "stage-1");
    expect(achado?.id).toBe("lead-430");
    expect(consultas.filter((c) => c.tabela === "crm_leads").map((c) => c.de)).toEqual([0, 200, 400]);
  });

  it("todos abertos: null, sem laço infinito", async () => {
    const leads = Array.from({ length: 400 }, (_, i) => ({ id: `lead-${i}` }));
    const { db } = dbFalso(leads, new Set(leads.map((l) => l.id)));
    expect(await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "stage-1")).toBeNull();
  });
});

describe("motor: lead sem texto para ele não trava o chip", () => {
  it("cancela só esse lead e abre o próximo na mesma volta seguinte", async () => {
    const config = configProspeccao({
      escolha: [
        { tipo: "abertura", quando: [{ campo: "segmento", igual: "estetica" }], lista: "d1_sinal" },
      ],
    });
    const semSegmento = lead("l1", "Ana", { sinal_1: "a ficha sem horário" });
    const comSegmento = lead("l2", "Bia", { sinal_1: "a ficha sem horário", bairro: "Mooca", segmento: "estetica" });
    const { repo, envios } = repoEmMemoria(config, [semSegmento, comSegmento]);
    await rodar(repo);
    expect(envios.find((e) => e.leadId === "l1")).toMatchObject({ estado: "cancelado", motivo: expect.stringContaining("sem modelo") });
    await rodar(repo);
    expect(envios.find((e) => e.leadId === "l2")?.estado).not.toBe("cancelado");
    expect(envios.find((e) => e.leadId === "l2")).toBeTruthy();
  });
});
