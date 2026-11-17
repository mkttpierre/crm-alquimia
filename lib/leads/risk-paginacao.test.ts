/**
 * A ROTINA DE RISCO ACIMA DE 1.000 LINHAS.
 *
 * O PostgREST corta toda resposta em `max_rows` (1.000) EM SILÊNCIO, e um
 * `.in()` com milhares de ids estoura a URL. As três leituras da rotina não
 * paginavam. Medido em produção (10/11/2026), numa organização com 2.438
 * negócios abertos e 1.541 estados gravados: a cada passada os negócios que
 * ficavam fora do corte pareciam novos, e o observador regravava o estado e
 * emitia `lead_cooled` de novo — 189.668 linhas falsas na timeline (97% da
 * tabela), ~20 mil por dia, um único negócio com 788. A segunda organização,
 * cujos negócios caíam todos depois da linha 1.000, nunca era visitada.
 *
 * O dublê abaixo reproduz os dois limites do PostgREST; nada mais.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/agenda/protecao-followup", () => ({
  protecaoAgendaSupabase: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/leads/reactivation", () => ({
  propoeReativacao: vi.fn(async () => null),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { calculaBucketsAtuais } from "@/lib/leads/risk-seed";
import { listaOrgsComNegocioAberto, observaTravessias } from "@/lib/leads/risk-worker";

const MAX_ROWS = 1000;
const MAX_IDS_NA_URL = 300;

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>) {
  const escritas: Array<{ tabela: string; linhas: Linha[] }> = [];

  function consulta(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let ordem: string | null = null;
    let faixa: [number, number] | null = null;
    let erro: { message: string } | null = null;

    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => (filtros.push((l) => l[col] === v), q),
      gt: (col: string, v: string) => (filtros.push((l) => String(l[col]) > v), q),
      in: (col: string, vs: unknown[]) => {
        if (vs.length > MAX_IDS_NA_URL) erro = { message: "URI too long" };
        const conjunto = new Set(vs);
        filtros.push((l) => conjunto.has(l[col]));
        return q;
      },
      order: (col: string) => ((ordem = col), q),
      range: (de: number, ate: number) => ((faixa = [de, ate]), q),
      upsert: (linhas: Linha | Linha[]) => {
        escritas.push({ tabela, linhas: Array.isArray(linhas) ? linhas : [linhas] });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (r: { data: Linha[] | null; error: { message: string } | null }) => unknown) => {
        if (erro) return resolve({ data: null, error: erro });
        let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordem) {
          const col = ordem;
          linhas = [...linhas].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
        }
        if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
        return resolve({ data: linhas.slice(0, MAX_ROWS), error: null });
      },
    };
    return q;
  }

  const admin = { from: (tabela: string) => consulta(tabela) } as unknown as SupabaseClient;
  return { admin, escritas };
}

const ORG = "org-a";
const AGORA = new Date("2026-11-10T12:00:00.000Z");
const HA_60_DIAS = new Date(AGORA.getTime() - 60 * 24 * 3600_000).toISOString();
const id = (prefixo: string, n: number) => `${prefixo}-${String(n).padStart(5, "0")}`;

function negociosAbertos(org: string, quantos: number, prefixo = "lead"): Linha[] {
  return Array.from({ length: quantos }, (_, n) => ({
    id: id(prefixo, n),
    organization_id: org,
    status: "open",
    stage_id: "estagio-1",
    contact_id: id(`contato-${prefixo}`, n),
    last_activity_at: HA_60_DIAS,
    created_at: HA_60_DIAS,
  }));
}

beforeEach(() => vi.clearAllMocks());

describe("rotina de risco acima de 1.000 linhas", () => {
  it("classifica todos os negócios abertos, não só os 1.000 primeiros", async () => {
    const { admin } = bancoFalso({ crm_leads: negociosAbertos(ORG, 1500) });

    const atuais = await calculaBucketsAtuais(admin, ORG, AGORA);

    expect(atuais).toHaveLength(1500);
  });

  it("não reemite 'esfriou' para negócio cujo estado já está gravado além da linha 1.000", async () => {
    const leads = negociosAbertos(ORG, 1500);
    // Ordem física invertida em relação aos negócios: sem paginação, o corte de
    // cada leitura cai num pedaço diferente — exatamente o que o Postgres faz
    // quando não há `order by`.
    const estados = [...leads].reverse().map((l) => ({
      lead_id: l.id,
      organization_id: ORG,
      bucket: "critico",
    }));
    const { admin, escritas } = bancoFalso({ crm_leads: leads, crm_lead_risk_states: estados });

    const r = await observaTravessias(admin, ORG, AGORA);

    expect(r.avaliados).toBe(1500);
    expect(r.travessias).toBe(0);
    expect(escritas).toHaveLength(0);
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("enxerga o retorno agendado de um contato mesmo com mais contatos do que cabem na URL", async () => {
    const leads = negociosAbertos(ORG, 1500);
    const alvo = leads[1400]!;
    const { admin } = bancoFalso({
      crm_leads: leads,
      cron_jobs: [
        {
          organization_id: ORG,
          kind: "at",
          enabled: true,
          contact_id: alvo.contact_id,
          next_run_at: new Date(AGORA.getTime() + 24 * 3600_000).toISOString(),
        },
      ],
    });

    const atuais = await calculaBucketsAtuais(admin, ORG, AGORA);

    expect(atuais.find((e) => e.leadId === alvo.id)?.bucket).toBe("em_voo");
  });

  it("visita a organização cujos negócios ficam todos depois da linha 1.000", async () => {
    const { admin } = bancoFalso({
      crm_leads: [...negociosAbertos("org-a", 1200, "a"), ...negociosAbertos("org-b", 30, "b")],
    });

    const orgs = await listaOrgsComNegocioAberto(admin);

    expect(orgs.sort()).toEqual(["org-a", "org-b"]);
  });
});
