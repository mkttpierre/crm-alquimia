import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { renderTemplate } from "@/lib/automation/template";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

/**
 * REGISTRAR VENDA NÃO FALA COM O LEAD, E A COMISSÃO NÃO SAI PELA AUTOMAÇÃO.
 *
 * Dois fechamentos no MOTOR de automações (`lib/automation/engine.ts`), com o motor de verdade e ações de mentira que só
 * anotam o que receberam:
 *
 *  1. Evento com `metadata.origem = registrar_venda` (o `lead.created` que a 0251 emite ao abrir o negócio da venda) não
 *     executa NENHUMA ação que fale com o lead ou arme algo que fale (WhatsApp, IA, fluxo de follow-up, mover etapa, que
 *     emite `lead.stage_changed` e arma o gatilho de etapa, webhook de saída, cujo destino pode iniciar uma mensagem).
 *     Etiqueta e responsável seguem.
 *  2. Em negócio de `valor_sigiloso`, o valor (a comissão) não entra no contexto de NENHUMA ação: nem `lead.value_cents`
 *     (que `{{lead.value_cents}}` renderizaria numa mensagem) nem o `payload` do evento.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const TIPOS = ["send_whatsapp_message", "send_ai_message", "start_message_flow", "create_or_move_lead", "add_tag", "assign_owner", "call_webhook"] as const;

const executadas: Array<{ tipo: string; ctx: ActionCtx }> = [];
const adiamentosPedidos: string[] = [];

beforeEach(() => {
  executadas.length = 0;
  adiamentosPedidos.length = 0;
  for (const tipo of TIPOS) {
    registerAction({
      type: tipo,
      // as ações de envio de verdade têm `postponeUntil` (janela, limite diário): o motor não pode nem consultá-lo numa venda
      postponeUntil: async () => {
        adiamentosPedidos.push(tipo);
        return null;
      },
      execute: async (ctx): Promise<ActionResultDetail> => {
        executadas.push({ tipo, ctx });
        return { type: tipo, status: "success" };
      },
    });
  }
});

const lead = (extra: Record<string, unknown> = {}) => ({
  id: LEAD,
  organization_id: ORG,
  contact_id: "c1",
  title: "Venda — Maria",
  status: "won",
  value_cents: 49371,
  currency: "BRL",
  valor_sigiloso: true,
  ...extra,
});

/** Supabase de mentira: devolve as linhas pré-carregadas e guarda o que a execução gravou. */
function fakeAdmin(linhaDoLead: Record<string, unknown>, acoes: string[]) {
  const regra = { id: "r1", name: "Boas-vindas", conditions: [], actions: acoes.map((type) => ({ type, config: { template: "Valor: {{lead.value_cents}}" } })) };
  const tabelas: Record<string, unknown[]> = {
    automation_rules: [regra],
    crm_leads: [linhaDoLead],
    contacts: [{ id: "c1", name: "Maria", phone_number: "+5511999990000" }],
  };
  const runs: Array<Record<string, unknown>> = [];
  const builder = (tabela: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "update"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: tabela === "automation_rule_runs" ? { id: "run-1" } : (tabelas[tabela]?.[0] ?? null), error: null });
    b.insert = (linha: Record<string, unknown>) => {
      if (tabela === "automation_rule_runs") runs.push(linha);
      return b;
    };
    b.then = (res: (v: unknown) => unknown) => res({ data: tabelas[tabela] ?? [], error: null });
    return b;
  };
  return { admin: { from: builder } as never, runs };
}

const evento = (tipo: string, payload: Record<string, unknown>, metadata: Record<string, unknown> = {}): EventRow => ({
  id: "evt-1",
  organization_id: ORG,
  event_type: tipo,
  entity_kind: "crm_lead",
  entity_id: LEAD,
  payload,
  metadata,
  consumed_by: [],
  attempts: 0,
});

const DA_VENDA = { origem: "registrar_venda" };
const TODAS = [...TIPOS];

describe("evento de Registrar venda: nenhuma ação que fale com o lead", () => {
  it("lead.created da venda: WhatsApp, IA, fluxo de follow-up, mover etapa e webhook NÃO executam (nem consultam adiamento); etiqueta e responsável sim", async () => {
    const { admin, runs } = fakeAdmin(lead(), TODAS);
    const r = await runAutomationForEvent(admin, evento("lead.created", { lead_id: LEAD, title: "Venda — Maria" }, DA_VENDA));

    expect(r.status).toBe("ok");
    expect(executadas.map((e) => e.tipo).sort()).toEqual(["add_tag", "assign_owner"]);
    // só as permitidas chegam a consultar adiamento (as de envio nem isso)
    expect([...adiamentosPedidos].sort()).toEqual(["add_tag", "assign_owner"]);
    // o rastro diz o motivo, ação por ação
    const resultado = (runs[0]!.actions_result as ActionResultDetail[]).filter((a) => a.status === "skipped");
    expect(resultado.map((a) => a.type).sort()).toEqual(["call_webhook", "create_or_move_lead", "send_ai_message", "send_whatsapp_message", "start_message_flow"]);
    expect(resultado.every((a) => a.detail?.reason === "registrar_venda")).toBe(true);
    // pular pelo motivo da venda não é falha da regra
    expect(runs[0]!.status).toBe("success");
  });

  it("qualquer evento que carregue a marca é tratado igual (ex.: uma mudança de etapa da venda)", async () => {
    const { admin } = fakeAdmin(lead(), ["send_whatsapp_message", "start_message_flow"]);
    await runAutomationForEvent(admin, evento("lead.stage_changed", { lead_id: LEAD, from_stage_id: "a", to_stage_id: "b" }, DA_VENDA));
    expect(executadas).toEqual([]);
    expect(adiamentosPedidos).toEqual([]);
  });

  it("SEM a marca o motor não mudou: o mesmo lead.created de um cadastro comum executa tudo", async () => {
    const { admin } = fakeAdmin(lead({ valor_sigiloso: false }), TODAS);
    await runAutomationForEvent(admin, evento("lead.created", { lead_id: LEAD }, {}));
    expect(executadas.map((e) => e.tipo).sort()).toEqual([...TODAS].sort());
  });

  it("uma regra só com ações de envio não 'falha' por causa da venda: o resultado é só pular, com o motivo", async () => {
    const { admin, runs } = fakeAdmin(lead(), ["send_whatsapp_message", "send_ai_message"]);
    await runAutomationForEvent(admin, evento("lead.created", { lead_id: LEAD }, DA_VENDA));
    expect(executadas).toEqual([]);
    expect(runs[0]!.status).toBe("success");
  });
});

describe("negócio de valor sigiloso: a comissão não entra no contexto de nenhuma ação", () => {
  it("lead.value_cents some do contexto e o template não renderiza o valor; o payload do evento também sai limpo", async () => {
    const { admin } = fakeAdmin(lead({ status: "open", valor_sigiloso: true }), ["send_whatsapp_message", "call_webhook"]);
    await runAutomationForEvent(admin, evento("lead.stage_changed", { lead_id: LEAD, to_stage_id: "b", value_cents: 49371, total_cents: 49371 }, {}));

    expect(executadas.map((e) => e.tipo).sort()).toEqual(["call_webhook", "send_whatsapp_message"]);
    for (const { ctx } of executadas) {
      const l = ctx.context.lead as Record<string, unknown>;
      expect(l).not.toHaveProperty("value_cents");
      expect(l.title).toBe("Venda — Maria");
      expect(JSON.stringify(ctx.context)).not.toContain("49371");
      expect(JSON.stringify(ctx.event.payload)).not.toContain("49371");
      expect(renderTemplate("Valor: {{lead.value_cents}} / {{event.value_cents}}", ctx.context)).toBe("Valor:  / ");
    }
    // o resto do payload segue (a ação continua sabendo qual negócio e qual etapa)
    expect(executadas[0]!.ctx.event.payload).toMatchObject({ lead_id: LEAD, to_stage_id: "b" });
  });

  it("negócio comum (valor_sigiloso = false) continua com o valor no contexto", async () => {
    const { admin } = fakeAdmin(lead({ status: "open", valor_sigiloso: false, value_cents: 5000 }), ["send_whatsapp_message"]);
    await runAutomationForEvent(admin, evento("lead.stage_changed", { lead_id: LEAD, value_cents: 5000 }, {}));
    const ctx = executadas[0]!.ctx;
    expect((ctx.context.lead as { value_cents: number }).value_cents).toBe(5000);
    expect(renderTemplate("{{lead.value_cents}}", ctx.context)).toBe("5000");
    expect(ctx.event.payload).toMatchObject({ value_cents: 5000 });
  });
});
