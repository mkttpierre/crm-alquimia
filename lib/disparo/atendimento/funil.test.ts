/**
 * O atendimento movendo o card do funil: quando a etapa da conversa muda, o
 * card vai para a etapa equivalente do funil do lead, pelo mapa da organização
 * (`atendimento.funil`), com a linha na timeline e sem recuar o que um humano
 * já pôs adiante.
 *
 * Duas camadas: o atendimento pede o movimento certo (repositório em memória),
 * e `moverCardDoAtendimento` grava do jeito certo (banco falso que registra
 * cada filtro — a prova de que toda escrita leva `organization_id`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { CONFIG_PROSPECCAO_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { atendimentoSchema, errosDaConfig } from "./config";
import { ATIVIDADE_DO_ATENDIMENTO, moverCardDoAtendimento, ORIGEM_DO_ATENDIMENTO } from "./funil";
import { criarJulgar } from "./jev";

const ORG = "55555555-5555-4555-8555-555555555555";
const AGORA = new Date("2026-10-14T13:00:00Z");
let n = 0;

describe("atendimento pede o movimento do card pelo mapa da organização", () => {
  const MAPA = { qualificando: "qualificado", perdido: "perdido", nao_contatar: "perdido" } as const;
  function cenario(funil: Record<string, string>) {
    const cfg = atendimentoSchema.parse({ ...CONFIG_PROSPECCAO_EXEMPLO, funil });
    const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), cfg);
    const lead = repo.novoLead(`f${++n}`, { campos: { codigo: "AB12" } });
    const diz = (texto: string) =>
      atenderMensagem({ repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) }, ORG, lead.id, { chave: `fm${++n}`, messageId: null, texto, midia: false });
    return { repo, lead, diz };
  }

  it("o mapa entra no schema e etapa inválida é recusada", () => {
    expect(errosDaConfig({ ...CONFIG_PROSPECCAO_EXEMPLO, funil: MAPA })).toEqual([]);
    expect(errosDaConfig({ ...CONFIG_PROSPECCAO_EXEMPLO, funil: { ganhou: "ganho" } }).length).toBeGreaterThan(0);
  });

  it("recusa → perdido: a conversa nasce (respondeu, sem equivalente) e o 'não' de novo move para perdido", async () => {
    const { repo, lead, diz } = cenario(MAPA);
    await diz("não tenho interesse");
    await diz("não");
    expect(repo.movimentos.map((m) => [m.etapa, m.slug])).toEqual([
      ["respondeu", null],
      ["perdido", "perdido"],
    ]);
    expect(repo.movimentos.every((m) => m.leadId === lead.id && m.modo === "simulado")).toBe(true);
  });

  it("etapa que não muda não pede movimento de novo", async () => {
    const { repo, diz } = cenario(MAPA);
    await diz("já temos uma agência que cuida disso");
    await diz("já tenho uma empresa que faz");
    const pedidos = repo.movimentos.map((m) => m.etapa);
    expect(new Set(pedidos).size).toBe(pedidos.length);
  });

  it("sem mapa nada se move e o resumo não muda", async () => {
    const { repo, diz } = cenario({});
    await diz("não tenho interesse");
    const r = await diz("não");
    expect(repo.movimentos.map((m) => m.etapa)).toEqual(["respondeu", "perdido"]);
    expect(repo.movimentos.every((m) => m.slug === null)).toBe(true);
    expect(r.resumo).not.toMatch(/card/);
  });

  it("o desfecho aparece no resumo da leitura", async () => {
    const { repo, diz } = cenario({ perdido: "perdido" });
    repo.funilResponde = "nao_recua";
    await diz("não tenho interesse");
    const r = await diz("não");
    expect(r.resumo).toMatch(/card não movido \(nao_recua\)/);
  });
});

/** Banco falso: crm_leads, crm_stages, a timeline e o evento; registra filtros e escritas. */
function bancoFalso(lead: Record<string, unknown> | null, opcoes: { conflito?: boolean } = {}) {
  const etapas = [
    { organization_id: ORG, pipeline_id: "pipe-1", id: "s-base", slug: "base", name: "Base", position: 1000, is_archived: false },
    { organization_id: ORG, pipeline_id: "pipe-1", id: "s-resp", slug: "respondeu", name: "Respondeu", position: 3000, is_archived: false },
    { organization_id: ORG, pipeline_id: "pipe-1", id: "s-qual", slug: "qualificando", name: "Qualificando", position: 4000, is_archived: false },
    { organization_id: ORG, pipeline_id: "pipe-1", id: "s-perd", slug: "perdido", name: "Perdido", position: 7000, is_archived: false },
  ];
  const escritas: { tabela: string; dados: unknown; filtros: [string, unknown][] }[] = [];
  const atividades: Record<string, unknown>[] = [];
  const eventos: Record<string, unknown>[] = [];
  const from = (tabela: string) => {
    const filtros: [string, unknown][] = [];
    let dados: unknown = null;
    const linhas = () => {
      const base = tabela === "crm_leads" ? (lead ? [lead] : []) : tabela === "crm_stages" ? etapas : [];
      return base.filter((r) => filtros.every(([c, v]) => (r as Record<string, unknown>)[c] === v));
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      update: (d: unknown) => ((dados = d), q),
      insert: async (d: Record<string, unknown> | Record<string, unknown>[]) => {
        atividades.push(...(Array.isArray(d) ? d : [d]));
        return { error: null };
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: (r: { data: unknown; error: null }) => void) => {
        if (dados) {
          escritas.push({ tabela, dados, filtros: [...filtros] });
          const afetadas = opcoes.conflito ? [] : linhas();
          for (const r of afetadas) Object.assign(r, dados as object);
          return Promise.resolve({ data: afetadas.map((r) => ({ id: (r as { id: string }).id })), error: null }).then(ok);
        }
        return Promise.resolve({ data: linhas(), error: null }).then(ok);
      },
    };
    return q;
  };
  const rpc = async (_f: string, args: Record<string, unknown>) => (eventos.push(args), { error: null });
  return { db: { from, rpc } as unknown as SupabaseClient, escritas, atividades, eventos };
}

const leadEm = (stage: string, status = "open") => ({ organization_id: ORG, id: "lead-1", pipeline_id: "pipe-1", stage_id: stage, contact_id: "c-1", status });
const mover = (db: SupabaseClient, etapa: "respondeu" | "qualificando" | "perdido", slug: string | null) =>
  moverCardDoAtendimento(db, { organizationId: ORG, leadId: "lead-1", etapa, slug, modo: "simulado" });

describe("moverCardDoAtendimento", () => {
  it("move, grava stage_changed na timeline e emite lead.stage_changed — tudo escopado na organização", async () => {
    const b = bancoFalso(leadEm("s-resp"));
    expect(await mover(b.db, "qualificando", "qualificando")).toBe("movido");
    expect(b.escritas).toHaveLength(1);
    expect(b.escritas[0]!.dados).toEqual({ stage_id: "s-qual" });
    // Trava otimista pela etapa de origem + organização: nunca update solto.
    expect(b.escritas[0]!.filtros).toEqual(expect.arrayContaining([["organization_id", ORG], ["id", "lead-1"], ["stage_id", "s-resp"], ["status", "open"]]));
    expect(b.atividades).toHaveLength(1);
    expect(b.atividades[0]).toMatchObject({
      organization_id: ORG,
      lead_id: "lead-1",
      type: ATIVIDADE_DO_ATENDIMENTO,
      source_module: ORIGEM_DO_ATENDIMENTO,
      actor_kind: "system",
    });
    expect(String(b.atividades[0]!.reason)).toMatch(/Movido de Respondeu para Qualificando/);
    expect(b.eventos[0]).toMatchObject({ p_event_type: "lead.stage_changed", p_organization_id: ORG });
  });

  it("não recua o card que um humano pôs adiante; saída (perdido) recua", async () => {
    const b = bancoFalso(leadEm("s-qual"));
    expect(await mover(b.db, "respondeu", "respondeu")).toBe("nao_recua");
    expect(b.escritas).toEqual([]);
    expect(await mover(bancoFalso(leadEm("s-qual")).db, "perdido", "perdido")).toBe("movido");
  });

  it("negócio fechado, etapa inexistente, sem mapa e já-lá não escrevem nada", async () => {
    for (const [lead, etapa, slug, esperado] of [
      [leadEm("s-resp", "won"), "qualificando", "qualificando", "lead_fechado"],
      [leadEm("s-resp"), "qualificando", "nao_existe", "sem_etapa_no_funil"],
      [leadEm("s-resp"), "qualificando", null, "sem_mapa"],
      [leadEm("s-qual"), "qualificando", "qualificando", "ja_esta_la"],
      [null, "qualificando", "qualificando", "lead_nao_encontrado"],
    ] as const) {
      const b = bancoFalso(lead);
      expect(await mover(b.db, etapa, slug)).toBe(esperado);
      expect(b.escritas).toEqual([]);
      expect(b.atividades).toEqual([]);
    }
  });

  it("humano mexeu entre a leitura e a escrita: a decisão dele vence, nada na timeline", async () => {
    const b = bancoFalso(leadEm("s-resp"), { conflito: true });
    expect(await mover(b.db, "qualificando", "qualificando")).toBe("conflito_humano");
    expect(b.atividades).toEqual([]);
  });
});
