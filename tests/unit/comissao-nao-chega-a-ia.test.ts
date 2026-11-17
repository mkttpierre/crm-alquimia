import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

/**
 * A COMISSÃO NÃO CHEGA À IA POR NENHUM CAMINHO.
 *
 * Uma venda registrada deixa em `crm_leads.value_cents` a soma das COMISSÕES do operador. O agente de IA lê negócios pelo
 * MCP (`crm_list_leads`, `crm_get_lead`, o retorno de `crm_update_lead` e `crm_move_lead_stage`, `crm_close_lead`). Então:
 *
 *  1. o negócio com `valor_sigiloso` sai com `value_cents` nulo, nos DOIS ingressos de ferramentas (o MCP externo e a
 *     ponte do agente nativo) — a resposta da API da TELA não é tocada e continua com o valor;
 *  2. nenhum código voltado à IA lê `value_cents`/`crm_lead_items` por conta própria (cerca contra leitor novo).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const COMUM = "33333333-3333-4333-8333-333333333333";

// O sigilo é da coluna `valor_sigiloso` (marca do banco: item interno da aba Produtos, venda registrada).
const linhaVenda = { id: LEAD, organization_id: ORG, pipeline_id: "p1", stage_id: "s1", title: "Venda — Maria", status: "won", value_cents: 12000, currency: "BRL", owner_user_id: null, tags: [], valor_sigiloso: true };
const linhaComum = { ...linhaVenda, id: COMUM, title: "Negócio à mão", status: "open", value_cents: 5000, valor_sigiloso: false };
const linhaSemColuna = { id: "44444444-4444-4444-8444-444444444444", organization_id: ORG, pipeline_id: "p1", stage_id: "s1", title: "Sem a coluna", status: "open", value_cents: 777, currency: "BRL", owner_user_id: null, tags: [] };

/** Supabase de mentira: toda consulta devolve as linhas da tabela; `maybeSingle`/`single` devolvem a que casa com `.eq("id", …)`. */
function fakeSupabase() {
  const tabelas: Record<string, Array<Record<string, unknown>>> = { crm_leads: [linhaVenda, linhaComum, linhaSemColuna] };
  return {
    from(tabela: string) {
      let filtroId: string | null = null;
      const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtroId === null || l.id === filtroId);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "range", "in", "is", "gt", "lt", "gte", "lte", "or", "not", "neq", "update", "insert"]) chain[m] = () => chain;
      chain.eq = (coluna: string, valor: unknown) => {
        if (coluna === "id") filtroId = String(valor);
        return chain;
      };
      chain.maybeSingle = async () => ({ data: linhas()[0] ?? null, error: null });
      chain.single = async () => ({ data: linhas()[0] ?? null, error: null });
      chain.then = (res: (v: unknown) => unknown) => res({ data: linhas(), error: null, count: linhas().length });
      return chain;
    },
  };
}

function ponte(toolIds: string[]) {
  const supabase = fakeSupabase();
  const ctx = {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: "agente-1", role: "ai_operator" },
    apiTokenId: "tok-1",
    requestId: "run-1",
    supabase,
  } as unknown as McpContext;
  const auth = {
    organizationId: ORG,
    role: "ai_operator",
    actor: ctx.actor,
    apiTokenId: "tok-1",
    scopes: ["mcp:read", "mcp:write", "actor:ai_agent", "role:ai_operator"],
  } as unknown as McpAuthResult;
  return pickToolsFromMcp({
    supabase: supabase as never,
    ctx,
    auth,
    toolIds,
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    pipelineIds: ["p1"],
  });
}

type Executavel = { execute: (args: unknown, opts: unknown) => Promise<unknown> };
const chamar = (t: unknown, args: unknown) => (t as Executavel).execute(args, { toolCallId: "t1", messages: [] });

describe("ponte do agente nativo: o negócio de uma venda registrada não mostra o valor", () => {
  it("crm_get_lead", async () => {
    const tools = ponte(["crm_get_lead"]);
    const r = (await chamar(tools.crm_get_lead, { lead_id: LEAD })) as { lead: Record<string, unknown> };
    expect(r.lead.id).toBe(LEAD);
    expect(r.lead.value_cents).toBeNull();
    expect(JSON.stringify(r)).not.toContain("12000");
  });

  it("crm_list_leads: a venda sai sem valor, o negócio comum mantém o dele", async () => {
    const tools = ponte(["crm_list_leads"]);
    const r = (await chamar(tools.crm_list_leads, { limit: 20 })) as { leads: Array<Record<string, unknown>> };
    const porId = new Map(r.leads.map((l) => [l.id, l]));
    expect(porId.get(LEAD)?.value_cents).toBeNull();
    expect(porId.get(COMUM)?.value_cents).toBe(5000);
    // a marca não sai para o modelo
    expect(JSON.stringify(r)).not.toMatch(/valor_sigiloso/);
  });

  it("falha fechado: uma saída de negócio que veio sem a coluna do sigilo não mostra o valor", async () => {
    const tools = ponte(["crm_list_leads"]);
    const r = (await chamar(tools.crm_list_leads, { limit: 20 })) as { leads: Array<Record<string, unknown>> };
    expect(r.leads.find((l) => l.title === "Sem a coluna")?.value_cents).toBeNull();
    expect(JSON.stringify(r)).not.toContain("777");
  });
});

describe("os dois ingressos de ferramentas aplicam o filtro (cerca no código)", () => {
  const RAIZ = process.cwd();
  it("MCP externo e ponte do agente chamam semComissao em volta do handler", () => {
    for (const arquivo of ["lib/mcp/server.ts", "lib/ai/runtime/tools.ts"]) {
      const fonte = readFileSync(join(RAIZ, arquivo), "utf8");
      expect(fonte, arquivo).toMatch(/semComissao\(\s*await\s+(tool|def)\.handler\(/);
    }
  });
});

describe("nenhum código voltado à IA lê o valor do negócio por conta própria", () => {
  const RAIZ = process.cwd();
  const PASTAS = ["lib/mcp", "lib/ai", "lib/agent-engine", "workers"];
  const IGNORAR = new Set(["node_modules", ".next"]);
  function arquivos(dir: string, saida: string[] = []): string[] {
    for (const nome of readdirSync(dir)) {
      if (IGNORAR.has(nome)) continue;
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
      else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.(ts|tsx)$/.test(nome)) saida.push(caminho);
    }
    return saida;
  }

  it("`value_cents` só aparece onde o filtro cobre (schemas das ferramentas de lead e o próprio filtro)", () => {
    const todos = PASTAS.flatMap((p) => arquivos(join(RAIZ, p)));
    expect(todos.length).toBeGreaterThan(100);
    const usam = todos
      .filter((f) => /value_cents/.test(readFileSync(f, "utf8")))
      .map((f) => relative(RAIZ, f).split(sep).join("/"))
      .sort();
    expect(usam).toEqual(["lib/mcp/sem-comissao.ts", "lib/mcp/tools/leads.ts"]);
  });
});
