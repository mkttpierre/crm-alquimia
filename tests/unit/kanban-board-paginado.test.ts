/**
 * O quadro paginado por etapa — GET /api/v1/pipelines/[id]/board.
 *
 * Medido: o quadro de uma organização (uns 2 mil leads) baixava todos os
 * leads num JSON de 2,7 MB para mostrar 50 por coluna. A rota agora devolve, por
 * etapa, os primeiros N na ordem da coluna e o TOTAL real; "Mostrar mais" pede a
 * página seguinte daquela etapa, e os filtros da tela valem no servidor.
 *
 * O Supabase aqui é um banco em memória que INTERPRETA os filtros (eq, is, lt,
 * contains, or/ilike, order, range, count) — não um stub que devolve fixo. Sem
 * isso, "o total respeita o filtro" seria uma afirmação sobre o mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const PIPE = "00000000-0000-4000-8000-0000000000bb";
const OUTRO_PIPE = "00000000-0000-4000-8000-0000000000bc";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D_OUTRO = "00000000-0000-4000-8000-00000000000d";
const DONO = "00000000-0000-4000-8000-0000000000ee";

type Row = Record<string, unknown>;

function idLead(etapa: string, i: number): string {
  return `${etapa.slice(-1)}${String(i).padStart(3, "0")}0000-0000-4000-8000-000000000000`.slice(0, 36);
}

function semear(): Record<string, Row[]> {
  const leads: Row[] = [];
  // Etapa A: 120 leads. Pares têm a tag "vip"; múltiplos de 3 têm dono;
  // múltiplos de 5 estão atrasados.
  for (let i = 0; i < 120; i++) {
    leads.push({
      id: idLead("a", i),
      organization_id: ORG,
      pipeline_id: PIPE,
      stage_id: A,
      title: `Lead ${i}`,
      description: null,
      status: "open",
      position_in_stage: (i + 1) * 1000,
      value_cents: 100,
      tags: i % 2 === 0 ? ["vip"] : [],
      owner_user_id: i % 3 === 0 ? DONO : null,
      owner_agent_id: null,
      owner_kind: i % 3 === 0 ? "human" : null,
      expected_close_date: i % 5 === 0 ? "2000-01-01" : "2999-01-01",
      contact_id: null,
      updated_at: "2026-10-27T00:00:00Z",
    });
  }
  for (let i = 0; i < 3; i++) {
    leads.push({
      id: idLead("b", i),
      organization_id: ORG,
      pipeline_id: PIPE,
      stage_id: B,
      title: `Fechamento ${i}`,
      description: "cliente, (grande)",
      status: "open",
      position_in_stage: (i + 1) * 1000,
      value_cents: 0,
      tags: ["a,b"],
      owner_user_id: null,
      owner_agent_id: null,
      owner_kind: null,
      expected_close_date: null,
      contact_id: null,
      updated_at: "2026-10-27T00:00:00Z",
    });
  }
  return {
    crm_pipelines: [
      { id: PIPE, organization_id: ORG, name: "Funil principal", is_default: true, settings: {} },
      { id: OUTRO_PIPE, organization_id: ORG, name: "Outro", is_default: false, settings: {} },
    ],
    crm_stages: [
      { id: A, organization_id: ORG, pipeline_id: PIPE, name: "Base", position: 0, is_archived: false },
      { id: B, organization_id: ORG, pipeline_id: PIPE, name: "Fechar", position: 1, is_archived: false },
      { id: C, organization_id: ORG, pipeline_id: PIPE, name: "Vazia", position: 2, is_archived: false },
      { id: D_OUTRO, organization_id: ORG, pipeline_id: OUTRO_PIPE, name: "Alheia", position: 0, is_archived: false },
    ],
    crm_leads: leads,
    crm_lead_scores: leads.map((l) => ({
      organization_id: ORG,
      lead_id: l.id,
      ai_probability: 0.5,
      ai_probability_reason: "r",
      ai_probability_band: "morno",
      ai_probability_evidence: { factors: [] },
      ai_probability_at: null,
    })),
  };
}

// ─── banco em memória que interpreta o dialeto do PostgREST ────────────────

function desescapar(valor: string): string {
  if (!valor.startsWith('"')) return valor;
  return valor.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** ilike do PostgREST: `*` vira `%`, depois LIKE com `\` de escape. */
function casaIlike(texto: unknown, padraoBruto: string): boolean {
  if (typeof texto !== "string") return false;
  const padrao = padraoBruto.replace(/\*/g, "%");
  let re = "";
  for (let i = 0; i < padrao.length; i++) {
    const c = padrao[i]!;
    if (c === "\\") {
      re += (padrao[++i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is").test(texto);
}

function dividirForaDeAspas(s: string): string[] {
  const partes: string[] = [];
  let atual = "";
  let aspas = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && aspas) {
      atual += c + (s[++i] ?? "");
      continue;
    }
    if (c === '"') aspas = !aspas;
    if (c === "," && !aspas) {
      partes.push(atual);
      atual = "";
    } else atual += c;
  }
  partes.push(atual);
  return partes;
}

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

function bancoFalso(tabelas: Record<string, Row[]>, chamadas: Chamada[]) {
  function consulta(tabela: string) {
    const filtros: Array<(r: Row) => boolean> = [];
    const ordens: Array<{ col: string; asc: boolean }> = [];
    let faixa: [number, number] | null = null;
    let contar = false;
    let unico = false;
    const reg = (metodo: string, args: unknown[]) => chamadas.push({ tabela, metodo, args });

    const resolver = () => {
      let linhas = (tabelas[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
      linhas = [...linhas].sort((x, y) => {
        for (const o of ordens) {
          const a = x[o.col] as string | number;
          const b = y[o.col] as string | number;
          if (a === b) continue;
          return (a < b ? -1 : 1) * (o.asc ? 1 : -1);
        }
        return 0;
      });
      const count = linhas.length;
      if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
      if (unico) return { data: linhas[0] ?? null, error: null };
      return { data: linhas, error: null, count: contar ? count : null };
    };

    const q = {
      select(_cols?: string, opts?: { count?: string }) {
        if (opts?.count === "exact") contar = true;
        return q;
      },
      eq(c: string, v: unknown) {
        reg("eq", [c, v]);
        filtros.push((r) => r[c] === v);
        return q;
      },
      neq(c: string, v: unknown) {
        filtros.push((r) => r[c] !== v);
        return q;
      },
      is(c: string, v: null) {
        reg("is", [c, v]);
        filtros.push((r) => r[c] == null);
        return q;
      },
      lt(c: string, v: string) {
        filtros.push((r) => r[c] != null && (r[c] as string) < v);
        return q;
      },
      gt(c: string, v: number) {
        filtros.push((r) => r[c] != null && (r[c] as number) > v);
        return q;
      },
      not(c: string, op: string, v: unknown) {
        if (op === "is" && v === null) filtros.push((r) => r[c] != null);
        return q;
      },
      in(c: string, vs: unknown[]) {
        reg("in", [c, vs]);
        filtros.push((r) => vs.includes(r[c]));
        return q;
      },
      contains(c: string, literal: string) {
        reg("contains", [c, literal]);
        const itens = dividirForaDeAspas(literal.slice(1, -1)).map(desescapar);
        filtros.push((r) => itens.every((i) => (r[c] as string[]).includes(i)));
        return q;
      },
      or(expr: string) {
        reg("or", [expr]);
        const ramos = dividirForaDeAspas(expr).map((ramo) => {
          const [col, op, ...resto] = ramo.split(".");
          const valor = desescapar(resto.join("."));
          if (op !== "ilike") throw new Error(`op não suportado no falso: ${op}`);
          return (r: Row) => casaIlike(r[col!], valor);
        });
        filtros.push((r) => ramos.some((f) => f(r)));
        return q;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        ordens.push({ col, asc: opts?.ascending !== false });
        return q;
      },
      range(de: number, ate: number) {
        faixa = [de, ate];
        return q;
      },
      maybeSingle() {
        unico = true;
        return q;
      },
      insert() {
        return Promise.resolve({ error: null });
      },
      then(ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) {
        return Promise.resolve(resolver()).then(ok, falha);
      },
    };
    return q;
  }

  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: (t: string) => consulta(t),
  };
}

// ────────────────────────────────────────────────────────────────────────────

let chamadas: Chamada[];

beforeEach(() => {
  chamadas = [];
  vi.mocked(createClient).mockResolvedValue(
    bancoFalso(semear(), chamadas) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
});

async function pedir(qs = "", pipeline = PIPE) {
  const { GET } = await import("@/app/api/v1/pipelines/[id]/board/route");
  const res = await GET(
    new NextRequest(`http://localhost/api/v1/pipelines/${pipeline}/board${qs}`),
    { params: Promise.resolve({ id: pipeline }) },
  );
  const corpo = (await res.json()) as { data: Record<string, unknown>; error?: { code: string } };
  return { status: res.status, corpo };
}

type LeadOut = { id: string; stage_id: string; position_in_stage: number; score?: unknown };

describe("primeira carga: uma página por etapa", () => {
  it("devolve só os primeiros 50 da etapa, na ordem da coluna, com o total real", async () => {
    const { status, corpo } = await pedir();
    expect(status).toBe(200);
    const leads = corpo.data.leads as LeadOut[];
    const daA = leads.filter((l) => l.stage_id === A);
    expect(daA).toHaveLength(50);
    expect(daA.map((l) => l.position_in_stage)).toEqual(
      Array.from({ length: 50 }, (_, i) => (i + 1) * 1000),
    );
    expect(leads.filter((l) => l.stage_id === B)).toHaveLength(3);

    const paginas = corpo.data.stage_pages as Record<string, { total: number; value_cents: number; next_position: number | null }>;
    expect(paginas[A]).toEqual({ total: 120, value_cents: 120 * 100, next_position: 51_000 });
    expect(paginas[B]).toEqual({ total: 3, value_cents: 0, next_position: null });
    expect(paginas[C]).toEqual({ total: 0, value_cents: 0, next_position: null });
  });

  it("mantém o formato antigo (pipeline, stages, leads) e as tags do funil inteiro", async () => {
    const { corpo } = await pedir();
    expect((corpo.data.pipeline as { id: string }).id).toBe(PIPE);
    expect((corpo.data.stages as Array<{ id: string }>).map((s) => s.id)).toEqual([A, B, C]);
    expect(Array.isArray(corpo.data.leads)).toBe(true);
    expect(corpo.data.tags).toEqual(["a,b", "vip"]);
  });

  it("busca os dados auxiliares (score) só dos leads devolvidos", async () => {
    const { corpo } = await pedir();
    const devolvidos = new Set((corpo.data.leads as LeadOut[]).map((l) => l.id));
    const pedidos = chamadas
      .filter((c) => c.tabela === "crm_lead_scores" && c.metodo === "in")
      .flatMap((c) => c.args[1] as string[]);
    expect(new Set(pedidos)).toEqual(devolvidos);
    expect((corpo.data.leads as LeadOut[]).every((l) => l.score)).toBe(true);
  });

  it("refetch com páginas abertas: `limites` devolve tantos quantos a coluna já mostrava", async () => {
    const { corpo } = await pedir(`?limites=${A}:100`);
    const daA = (corpo.data.leads as LeadOut[]).filter((l) => l.stage_id === A);
    expect(daA).toHaveLength(100);
    expect((corpo.data.stage_pages as Record<string, { next_position: number }>)[A]!.next_position).toBe(101_000);
  });

  it("lead do deep link fora das páginas vem em `lead_em_foco`, sem entrar nas colunas", async () => {
    const alvo = idLead("a", 110);
    const { corpo } = await pedir(`?lead=${alvo}`);
    expect((corpo.data.leads as LeadOut[]).some((l) => l.id === alvo)).toBe(false);
    const foco = corpo.data.lead_em_foco as LeadOut;
    expect(foco.id).toBe(alvo);
    expect(foco.score).toBeTruthy();
  });
});

describe("página seguinte de uma etapa", () => {
  it("offset=50 traz os leads 51..100 da etapa, com total e próxima posição", async () => {
    const { status, corpo } = await pedir(`?stage_id=${A}&offset=50`);
    expect(status).toBe(200);
    const leads = corpo.data.leads as LeadOut[];
    expect(leads.map((l) => l.position_in_stage)).toEqual(
      Array.from({ length: 50 }, (_, i) => (i + 51) * 1000),
    );
    expect(corpo.data).toMatchObject({ stage_id: A, offset: 50, total: 120, next_position: 101_000 });
  });

  it("a última página não tem próxima posição", async () => {
    const { corpo } = await pedir(`?stage_id=${A}&offset=100`);
    expect(corpo.data.leads as LeadOut[]).toHaveLength(20);
    expect(corpo.data.next_position).toBeNull();
  });

  it("etapa de outro pipeline é 404, não vaza leads", async () => {
    const { status } = await pedir(`?stage_id=${D_OUTRO}&offset=0`);
    expect(status).toBe(404);
  });
});

describe("filtros no servidor: página e total respeitam o filtro", () => {
  it("busca por título conta só quem casa", async () => {
    // "Lead 1" casa 1, 10..19 e 100..119 = 31.
    const { corpo } = await pedir("?q=lead%201");
    const daA = (corpo.data.leads as LeadOut[]).filter((l) => l.stage_id === A);
    expect(daA).toHaveLength(31);
    expect((corpo.data.stage_pages as Record<string, { total: number }>)[A]!.total).toBe(31);
    expect((corpo.data.stage_pages as Record<string, { total: number }>)[B]!.total).toBe(0);
  });

  it("busca com % é literal, não curinga; vírgula e parênteses não quebram o `or`", async () => {
    const pct = await pedir("?q=" + encodeURIComponent("Lead 1%"));
    expect((pct.corpo.data.leads as LeadOut[])).toHaveLength(0);
    const virgula = await pedir("?q=" + encodeURIComponent("cliente, (grande)"));
    expect((virgula.corpo.data.leads as LeadOut[]).map((l) => l.stage_id)).toEqual([B, B, B]);
  });

  it("tag, responsável e atrasados", async () => {
    const tag = await pedir("?tag=vip");
    expect((tag.corpo.data.stage_pages as Record<string, { total: number }>)[A]!.total).toBe(60);
    expect((tag.corpo.data.leads as LeadOut[]).filter((l) => l.stage_id === A)).toHaveLength(50);

    const tagVirgula = await pedir("?tag=" + encodeURIComponent("a,b"));
    expect((tagVirgula.corpo.data.stage_pages as Record<string, { total: number }>)[B]!.total).toBe(3);

    const dono = await pedir(`?owner=${DONO}`);
    expect((dono.corpo.data.stage_pages as Record<string, { total: number }>)[A]!.total).toBe(40);

    const semDono = await pedir("?owner=unassigned");
    expect((semDono.corpo.data.stage_pages as Record<string, { total: number }>)[A]!.total).toBe(80);

    const atrasados = await pedir("?overdue=1");
    expect((atrasados.corpo.data.stage_pages as Record<string, { total: number }>)[A]!.total).toBe(24);
  });

  it("página seguinte com filtro continua filtrada", async () => {
    const { corpo } = await pedir(`?stage_id=${A}&offset=50&tag=vip`);
    expect(corpo.data.total).toBe(60);
    expect((corpo.data.leads as LeadOut[])).toHaveLength(10);
  });

  it("filtro inválido é 400 (nunca vira consulta com lixo)", async () => {
    expect((await pedir("?owner=nao-e-uuid")).status).toBe(400);
    expect((await pedir("?stage_id=x")).status).toBe(400);
    expect((await pedir("?por_etapa=9999")).status).toBe(400);
  });
});
