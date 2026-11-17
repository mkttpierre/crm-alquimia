/**
 * Os números da tela Início, medidos contra um dublê de banco que APLICA os
 * filtros (`eq`, `in`, `gte`, `lt`, `neq`, `is`, `not … is null`), o `order`,
 * o `limit`, o `range` e o `count`/`head` de verdade — e que CORTA toda resposta
 * em 1.000 linhas, calado, como o `max_rows` do PostgREST (supabase/config.toml). Um stub de linha fixa deixaria o
 * `.eq("organization_id", …)` sumir da consulta sem nenhum teste reprovar — e
 * a primeira coisa que este arquivo prova é que o dado de OUTRA organização
 * não entra em número nenhum.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { carregarResumoDoInicio, type ResumoDoInicio } from "./resumo";

type Linha = Record<string, unknown>;

/** O `max_rows` do PostgREST: resposta maior que isto chega cortada, sem erro. */
const MAX_ROWS = 1000;

function bancoFalso(tabelas: Record<string, Linha[]>) {
  const consultas: string[] = [];

  function consulta(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const ordens: Array<{ col: string; asc: boolean }> = [];
    let limite: number | null = null;
    let faixa: [number, number] | null = null;
    let soContagem = false;
    let contar = false;
    let um = false;

    const q = {
      select: (_cols?: string, opcoes?: { count?: string; head?: boolean }) => {
        contar = opcoes?.count === "exact";
        soContagem = opcoes?.head === true;
        return q;
      },
      eq: (col: string, v: unknown) => (filtros.push((l) => l[col] === v), q),
      neq: (col: string, v: unknown) => (filtros.push((l) => l[col] !== v), q),
      is: (col: string, v: unknown) => (filtros.push((l) => (l[col] ?? null) === v), q),
      not: (col: string, op: string, v: unknown) => {
        if (op !== "is" || v !== null) throw new Error(`dublê: not(${op}) não suportado`);
        filtros.push((l) => (l[col] ?? null) !== null);
        return q;
      },
      in: (col: string, vs: unknown[]) => {
        const conjunto = new Set(vs);
        filtros.push((l) => conjunto.has(l[col]));
        return q;
      },
      gte: (col: string, v: string) => (
        filtros.push((l) => l[col] != null && String(l[col]) >= v),
        q
      ),
      lt: (col: string, v: string) => (
        filtros.push((l) => l[col] != null && String(l[col]) < v),
        q
      ),
      order: (col: string, o?: { ascending?: boolean }) => (
        ordens.push({ col, asc: o?.ascending !== false }),
        q
      ),
      limit: (n: number) => ((limite = n), q),
      range: (de: number, ate: number) => ((faixa = [de, ate]), q),
      maybeSingle: () => ((um = true), q),
      then: (resolve: (r: { data: unknown; error: null; count?: number | null }) => unknown) => {
        consultas.push(tabela);
        let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordens.length > 0) {
          linhas = [...linhas].sort((a, b) => {
            for (const { col, asc } of ordens) {
              const c = String(a[col]).localeCompare(String(b[col]));
              if (c !== 0) return asc ? c : -c;
            }
            return 0;
          });
        }
        const total = linhas.length;
        if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
        if (limite !== null) linhas = linhas.slice(0, limite);
        linhas = linhas.slice(0, MAX_ROWS);
        if (um) return resolve({ data: linhas[0] ?? null, error: null });
        return resolve({
          data: soContagem ? null : linhas,
          error: null,
          count: contar ? total : null,
        });
      },
    };
    return q;
  }

  const db = { from: (tabela: string) => consulta(tabela) } as unknown as SupabaseClient;
  return { db, consultas };
}

const ORG = "org-a";
const OUTRA = "org-b";
// 13/11/2026 15:00 em São Paulo (UTC-3) — "hoje" começa às 03:00Z.
const AGORA = new Date("2026-11-13T18:00:00.000Z");
const iso = (s: string) => new Date(s).toISOString();

async function resumir(
  tabelas: Record<string, Linha[]>,
  nomes: Record<string, string> = {},
  incluirMotor = true,
): Promise<ResumoDoInicio> {
  const { db } = bancoFalso(tabelas);
  return carregarResumoDoInicio(db, ORG, {
    agora: AGORA,
    incluirMotor,
    nomesDeUsuarios: async (ids) => new Map(ids.map((id) => [id, nomes[id] ?? null])),
  });
}

describe("conversas abertas", () => {
  it("conta as abertas da organização e quantas esperam resposta", async () => {
    const r = await resumir({
      conversations: [
        // espera: a última mensagem do cliente é depois da nossa
        {
          id: "c1",
          organization_id: ORG,
          status: "open",
          is_group: false,
          last_inbound_at: iso("2026-11-13T10:00:00Z"),
          last_outbound_at: iso("2026-11-13T09:00:00Z"),
          created_at: iso("2026-11-13T08:00:00Z"),
        },
        // espera: só o cliente falou
        {
          id: "c2",
          organization_id: ORG,
          status: "ai_handling",
          is_group: false,
          last_inbound_at: iso("2026-11-13T10:00:00Z"),
          last_outbound_at: null,
          created_at: iso("2026-11-13T08:00:00Z"),
        },
        // não espera: nós respondemos por último
        {
          id: "c3",
          organization_id: ORG,
          status: "claimed",
          is_group: false,
          last_inbound_at: iso("2026-11-13T10:00:00Z"),
          last_outbound_at: iso("2026-11-13T11:00:00Z"),
          created_at: iso("2026-11-13T08:00:00Z"),
        },
        // fechada: não entra
        {
          id: "c4",
          organization_id: ORG,
          status: "closed",
          is_group: false,
          last_inbound_at: iso("2026-11-13T10:00:00Z"),
          last_outbound_at: null,
          created_at: iso("2026-11-13T08:00:00Z"),
        },
        // de outra organização: não entra
        {
          id: "c5",
          organization_id: OUTRA,
          status: "open",
          is_group: false,
          last_inbound_at: iso("2026-11-13T10:00:00Z"),
          last_outbound_at: null,
          created_at: iso("2026-11-13T08:00:00Z"),
        },
      ],
    });
    expect(r.conversas).toEqual({ abertas: 3, esperandoResposta: 2 });
  });
});

describe("leads criados hoje", () => {
  it("conta os de hoje e os de ontem no fuso da organização, sem os de outra", async () => {
    const r = await resumir({
      crm_leads: [
        { id: "l1", organization_id: ORG, created_at: iso("2026-11-13T03:30:00Z") }, // hoje 00:30 local
        { id: "l2", organization_id: ORG, created_at: iso("2026-11-13T17:00:00Z") },
        { id: "l3", organization_id: ORG, created_at: iso("2026-11-13T02:30:00Z") }, // ontem 23:30 local
        { id: "l4", organization_id: OUTRA, created_at: iso("2026-11-13T12:00:00Z") },
        { id: "l5", organization_id: OUTRA, created_at: iso("2026-11-12T12:00:00Z") },
      ],
    });
    expect(r.leads).toEqual({ hoje: 2, ontem: 1 });
  });
});

describe("o motor", () => {
  it("organização sem motor: 0 enviados, 0 chips e taxa nula (a tela mostra —)", async () => {
    const r = await resumir({});
    expect(r.motor?.enviadosHoje).toBe(0);
    expect(r.motor?.chipsHoje).toBe(0);
    expect(r.motor?.taxaDeResposta).toBeNull();
  });

  it("conta só o que saiu de verdade hoje, e em quantos chips", async () => {
    const r = await resumir({
      disparo_envios: [
        {
          id: "e1",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k1",
          tipo: "abertura",
          lead_id: "a",
          enviado_em: iso("2026-11-13T12:00:00Z"),
        },
        {
          id: "e2",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k2",
          tipo: "msg2",
          lead_id: "b",
          enviado_em: iso("2026-11-13T13:00:00Z"),
        },
        {
          id: "e3",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k1",
          tipo: "abertura",
          lead_id: "c",
          enviado_em: iso("2026-11-13T14:00:00Z"),
        },
        // simulado não saiu
        {
          id: "e4",
          organization_id: ORG,
          estado: "simulado",
          chip_id: "k3",
          tipo: "abertura",
          lead_id: "d",
          enviado_em: iso("2026-11-13T14:00:00Z"),
        },
        // ontem
        {
          id: "e5",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k4",
          tipo: "abertura",
          lead_id: "e",
          enviado_em: iso("2026-11-12T14:00:00Z"),
        },
        // outra organização
        {
          id: "e6",
          organization_id: OUTRA,
          estado: "enviado",
          chip_id: "k5",
          tipo: "abertura",
          lead_id: "f",
          enviado_em: iso("2026-11-13T14:00:00Z"),
        },
      ],
    });
    expect(r.motor?.enviadosHoje).toBe(3);
    expect(r.motor?.chipsHoje).toBe(2);
  });

  it("taxa de resposta: leads abertos nos últimos 7 dias que responderam depois da abertura", async () => {
    const r = await resumir({
      disparo_envios: [
        {
          id: "e1",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k1",
          tipo: "abertura",
          lead_id: "la",
          enviado_em: iso("2026-11-10T12:00:00Z"),
        },
        {
          id: "e2",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k1",
          tipo: "abertura",
          lead_id: "lb",
          enviado_em: iso("2026-11-11T12:00:00Z"),
        },
        {
          id: "e3",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k1",
          tipo: "abertura",
          lead_id: "lc",
          enviado_em: iso("2026-11-12T12:00:00Z"),
        },
        {
          id: "e4",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k1",
          tipo: "abertura",
          lead_id: "ld",
          enviado_em: iso("2026-11-12T12:00:00Z"),
        },
        // fora da janela de 7 dias
        {
          id: "e5",
          organization_id: ORG,
          estado: "enviado",
          chip_id: "k1",
          tipo: "abertura",
          lead_id: "le",
          enviado_em: iso("2026-11-01T12:00:00Z"),
        },
        // de outra organização, com resposta: não pode entrar no denominador nem no numerador
        {
          id: "e6",
          organization_id: OUTRA,
          estado: "enviado",
          chip_id: "k9",
          tipo: "abertura",
          lead_id: "lx",
          enviado_em: iso("2026-11-12T12:00:00Z"),
        },
      ],
      crm_leads: [
        {
          id: "la",
          organization_id: ORG,
          contact_id: "ca",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "lb",
          organization_id: ORG,
          contact_id: "cb",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "lc",
          organization_id: ORG,
          contact_id: "cc",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "ld",
          organization_id: ORG,
          contact_id: "cd",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "lx",
          organization_id: OUTRA,
          contact_id: "cx",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
      ],
      messages: [
        // la respondeu depois da abertura: conta
        {
          id: "m1",
          organization_id: ORG,
          contact_id: "ca",
          direction: "inbound",
          type: "text",
          metadata: {},
          created_at: iso("2026-11-10T13:00:00Z"),
        },
        // lb escreveu ANTES da abertura: não é resposta
        {
          id: "m2",
          organization_id: ORG,
          contact_id: "cb",
          direction: "inbound",
          type: "text",
          metadata: {},
          created_at: iso("2026-11-11T11:00:00Z"),
        },
        // lc: resposta automática do WhatsApp Business não é gente
        {
          id: "m3",
          organization_id: ORG,
          contact_id: "cc",
          direction: "inbound",
          type: "text",
          metadata: { automatica: true },
          created_at: iso("2026-11-12T12:01:00Z"),
        },
        // ld: só mensagem nossa
        {
          id: "m4",
          organization_id: ORG,
          contact_id: "cd",
          direction: "outbound",
          type: "text",
          metadata: {},
          created_at: iso("2026-11-12T13:00:00Z"),
        },
        {
          id: "m5",
          organization_id: OUTRA,
          contact_id: "cx",
          direction: "inbound",
          type: "text",
          metadata: {},
          created_at: iso("2026-11-12T13:00:00Z"),
        },
      ],
    });
    expect(r.motor?.aberturas7d).toBe(4);
    expect(r.motor?.respondidas7d).toBe(1);
    expect(r.motor?.taxaDeResposta).toBeCloseTo(0.25, 6);
  });
});

describe("as 8 semanas do gráfico", () => {
  it("devolve sempre 8 semanas, e semana sem dado vira 0", async () => {
    const r = await resumir({
      conversations: [
        // última semana: uma iniciada e respondida (houve mensagem dos dois lados), outra sem resposta
        {
          id: "c1",
          organization_id: ORG,
          status: "closed",
          is_group: false,
          created_at: iso("2026-11-12T12:00:00Z"),
          last_inbound_at: iso("2026-11-12T13:00:00Z"),
          last_outbound_at: iso("2026-11-12T12:00:00Z"),
        },
        {
          id: "c2",
          organization_id: ORG,
          status: "open",
          is_group: false,
          created_at: iso("2026-11-11T12:00:00Z"),
          last_inbound_at: null,
          last_outbound_at: iso("2026-11-11T12:00:00Z"),
        },
        // primeira semana: [19/09 03:00Z, 26/09 03:00Z)
        {
          id: "c3",
          organization_id: ORG,
          status: "closed",
          is_group: false,
          created_at: iso("2026-09-20T12:00:00Z"),
          last_inbound_at: iso("2026-09-20T13:00:00Z"),
          last_outbound_at: iso("2026-09-20T14:00:00Z"),
        },
        // antes da janela de 8 semanas
        {
          id: "c4",
          organization_id: ORG,
          status: "closed",
          is_group: false,
          created_at: iso("2026-09-01T12:00:00Z"),
          last_inbound_at: iso("2026-09-01T13:00:00Z"),
          last_outbound_at: iso("2026-09-01T14:00:00Z"),
        },
        // outra organização, na última semana
        {
          id: "c5",
          organization_id: OUTRA,
          status: "open",
          is_group: false,
          created_at: iso("2026-11-12T12:00:00Z"),
          last_inbound_at: iso("2026-11-12T13:00:00Z"),
          last_outbound_at: iso("2026-11-12T12:00:00Z"),
        },
      ],
    });
    expect(r.semanas).toHaveLength(8);
    expect(r.semanas[7]).toMatchObject({ iniciadas: 2, respondidas: 1 });
    expect(r.semanas[0]).toMatchObject({ iniciadas: 1, respondidas: 1 });
    for (const s of r.semanas.slice(1, 7))
      expect(s).toMatchObject({ iniciadas: 0, respondidas: 0 });
    // a última semana termina no fim de hoje (local) e começa 7 dias antes
    expect(r.semanas[7]!.inicio).toBe("2026-11-07T03:00:00.000Z");
  });

  it("organização vazia: 8 semanas zeradas, nada inventado", async () => {
    const r = await resumir({});
    expect(r.semanas.map((s) => [s.iniciadas, s.respondidas])).toEqual(Array(8).fill([0, 0]));
  });
});

describe("funis", () => {
  it("cada funil da organização com leads, etapas, motor e a fatia além da primeira etapa", async () => {
    const r = await resumir({
      crm_pipelines: [
        { id: "p1", organization_id: ORG, name: "Prospecção", position: 1, is_archived: false },
        { id: "p2", organization_id: ORG, name: "Pós-venda", position: 2, is_archived: false },
        { id: "p3", organization_id: ORG, name: "Arquivado", position: 3, is_archived: true },
        { id: "px", organization_id: OUTRA, name: "Da outra", position: 0, is_archived: false },
      ],
      crm_stages: [
        { id: "s1", organization_id: ORG, pipeline_id: "p1", position: 1, is_archived: false },
        { id: "s2", organization_id: ORG, pipeline_id: "p1", position: 2, is_archived: false },
        { id: "s3", organization_id: ORG, pipeline_id: "p1", position: 3, is_archived: false },
        { id: "s0", organization_id: ORG, pipeline_id: "p1", position: 0, is_archived: true },
        { id: "t1", organization_id: ORG, pipeline_id: "p2", position: 1, is_archived: false },
      ],
      crm_leads: [
        {
          id: "a",
          organization_id: ORG,
          pipeline_id: "p1",
          stage_id: "s1",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "b",
          organization_id: ORG,
          pipeline_id: "p1",
          stage_id: "s2",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "c",
          organization_id: ORG,
          pipeline_id: "p1",
          stage_id: "s3",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "d",
          organization_id: ORG,
          pipeline_id: "p1",
          stage_id: "s3",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
        {
          id: "x",
          organization_id: OUTRA,
          pipeline_id: "p1",
          stage_id: "s1",
          created_at: iso("2026-10-01T00:00:00Z"),
        },
      ],
      disparo_config: [{ organization_id: ORG, ligado: true, fonte_stage_id: "s1", ritmo: {} }],
    });
    expect(r.funis).toEqual([
      {
        id: "p1",
        nome: "Prospecção",
        leads: 4,
        etapas: 3,
        motorLigado: true,
        alemDaPrimeira: 0.75,
      },
      { id: "p2", nome: "Pós-venda", leads: 0, etapas: 1, motorLigado: false, alemDaPrimeira: 0 },
    ]);
  });

  it("motor desligado não acende o selo, mesmo apontando para a etapa", async () => {
    const r = await resumir({
      crm_pipelines: [
        { id: "p1", organization_id: ORG, name: "Funil", position: 1, is_archived: false },
      ],
      crm_stages: [
        { id: "s1", organization_id: ORG, pipeline_id: "p1", position: 1, is_archived: false },
      ],
      disparo_config: [{ organization_id: ORG, ligado: false, fonte_stage_id: "s1", ritmo: {} }],
    });
    expect(r.funis[0]!.motorLigado).toBe(false);
  });
});

describe("atividade recente", () => {
  it("as 6 últimas da organização, com autor, lead e rótulo legível", async () => {
    const atividades: Linha[] = Array.from({ length: 8 }, (_, n) => ({
      id: `a${n}`,
      organization_id: ORG,
      lead_id: "l1",
      type: "stage_changed",
      actor_kind: "user",
      performed_by_user_id: "u1",
      actor_agent_id: null,
      performed_at: iso(`2026-11-13T1${n}:00:00Z`),
    }));
    atividades.push({
      id: "ia",
      organization_id: ORG,
      lead_id: "l1",
      type: "ai_turn",
      actor_kind: "ai",
      performed_by_user_id: null,
      actor_agent_id: "ag1",
      performed_at: iso("2026-11-13T19:00:00Z"),
    });
    atividades.push({
      id: "outra",
      organization_id: OUTRA,
      lead_id: "lx",
      type: "note",
      actor_kind: "user",
      performed_by_user_id: "u9",
      actor_agent_id: null,
      performed_at: iso("2026-11-13T20:00:00Z"),
    });
    const r = await resumir(
      {
        crm_lead_activities: atividades,
        crm_leads: [
          {
            id: "l1",
            organization_id: ORG,
            title: "Marcos Lima",
            created_at: iso("2026-10-01T00:00:00Z"),
          },
        ],
        ai_agents: [{ id: "ag1", organization_id: ORG, name: "Sofia" }],
      },
      { u1: "Ana Souza" },
    );
    expect(r.atividades).toHaveLength(6);
    expect(r.atividades.map((a) => a.id)).toEqual(["ia", "a7", "a6", "a5", "a4", "a3"]);
    expect(r.atividades[0]).toMatchObject({
      autor: "Sofia",
      especie: "ai",
      rotulo: "Atendimento da IA",
      lead: "Marcos Lima",
    });
    expect(r.atividades[1]).toMatchObject({
      autor: "Ana Souza",
      especie: "user",
      rotulo: "Mudou de estágio",
      lead: "Marcos Lima",
    });
  });

  it("sem nome resolvido, o autor cai no rótulo genérico — nunca no id", async () => {
    const r = await resumir({
      crm_lead_activities: [
        {
          id: "a1",
          organization_id: ORG,
          lead_id: "l1",
          type: "note",
          actor_kind: "user",
          performed_by_user_id: "u1",
          actor_agent_id: null,
          performed_at: iso("2026-11-13T10:00:00Z"),
        },
      ],
    });
    expect(r.atividades[0]!.autor).toBe("Você/time");
    expect(r.atividades[0]!.lead).toBeNull();
  });
});

describe("acima de 1.000 linhas (o max_rows do PostgREST corta calado)", () => {
  const n = (prefixo: string, i: number) => `${prefixo}-${String(i).padStart(5, "0")}`;

  it("conversas esperando resposta, semana do gráfico, enviados e taxa contam TUDO", async () => {
    const conversas: Linha[] = Array.from({ length: 1500 }, (_, i) => ({
      id: n("c", i),
      organization_id: ORG,
      status: "open",
      is_group: false,
      created_at: iso("2026-11-12T12:00:00Z"),
      last_inbound_at: iso("2026-11-12T13:00:00Z"),
      last_outbound_at: i < 1200 ? iso("2026-11-12T12:00:00Z") : null,
    }));
    const envios: Linha[] = Array.from({ length: 1100 }, (_, i) => ({
      id: n("e", i),
      organization_id: ORG,
      estado: "enviado",
      chip_id: i < 600 ? "k1" : "k2",
      tipo: "abertura",
      lead_id: n("l", i),
      enviado_em: iso("2026-11-13T12:00:00Z"),
    }));
    const leads: Linha[] = Array.from({ length: 1100 }, (_, i) => ({
      id: n("l", i),
      organization_id: ORG,
      contact_id: n("ct", i),
      created_at: iso("2026-10-01T00:00:00Z"),
    }));
    const msgs: Linha[] = Array.from({ length: 1050 }, (_, i) => ({
      id: n("m", i),
      organization_id: ORG,
      contact_id: n("ct", i),
      direction: "inbound",
      type: "text",
      metadata: {},
      created_at: iso("2026-11-13T13:00:00Z"),
    }));
    const r = await resumir({
      conversations: conversas,
      disparo_envios: envios,
      crm_leads: leads,
      messages: msgs,
    });
    expect(r.conversas).toEqual({ abertas: 1500, esperandoResposta: 1500 });
    expect(r.semanas[7]).toMatchObject({ iniciadas: 1500, respondidas: 1200 });
    expect(r.motor?.enviadosHoje).toBe(1100);
    expect(r.motor?.chipsHoje).toBe(2);
    expect(r.motor?.aberturas7d).toBe(1100);
    expect(r.motor?.respondidas7d).toBe(1050);
  });
});

describe("quem não é gestor não recebe o motor", () => {
  it("sem incluirMotor: motor nulo e nenhum selo de motor nos funis", async () => {
    const r = await resumir(
      {
        crm_pipelines: [
          { id: "p1", organization_id: ORG, name: "Funil", position: 1, is_archived: false },
        ],
        crm_stages: [
          { id: "s1", organization_id: ORG, pipeline_id: "p1", position: 1, is_archived: false },
        ],
        disparo_config: [{ organization_id: ORG, ligado: true, fonte_stage_id: "s1", ritmo: {} }],
        disparo_envios: [
          {
            id: "e1",
            organization_id: ORG,
            estado: "enviado",
            chip_id: "k1",
            tipo: "abertura",
            lead_id: "a",
            enviado_em: iso("2026-11-13T12:00:00Z"),
          },
        ],
      },
      {},
      false,
    );
    expect(r.motor).toBeNull();
    expect(r.funis[0]!.motorLigado).toBe(false);
  });
});
