import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("./tag-de-compra", () => ({ acrescentarTagsDeCompra: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-write-failure", () => ({ registraFalhaDeAtividade: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

import { registrarVenda } from "./registrar-venda";
import { vendaCriarSchema } from "./venda";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const PRODUTO = "55555555-5555-4555-8555-555555555555";
const ETAPA_A = "66666666-6666-4666-8666-666666666666";
const ETAPA_GANHO = "77777777-7777-4777-8777-777777777777";
const USUARIO = "88888888-8888-4888-8888-888888888888";
const AGORA = new Date("2026-11-08T15:00:00Z");

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "99999999-9999-4999-8999-999999999999" };

const retornoDaFuncao = (extra: Record<string, unknown> = {}) => ({
  ja_registrada: false,
  criado: false,
  lead_id: LEAD,
  contact_id: CONTATO,
  pipeline_id: "pipe",
  from_stage_id: ETAPA_A,
  to_stage_id: ETAPA_GANHO,
  total_cents: 12000,
  currency: "BRL",
  closed_at: AGORA.toISOString(),
  title: "Venda — Maria",
  ...extra,
});

/** Supabase de mentira: lê o fuso da organização e responde a UMA chamada de função, anotando os argumentos. */
function dbCom(resposta: { data: unknown; error: { message: string; code?: string } | null }, timezone: string | null = "America/Sao_Paulo") {
  const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const orgsLidas: string[] = [];
  const db = {
    from: (tabela: string) => {
      expect(tabela).toBe("organizations");
      return {
        select: () => ({
          eq: (_c: string, valor: string) => {
            orgsLidas.push(valor);
            return { maybeSingle: async () => ({ data: timezone ? { timezone } : null, error: null }) };
          },
        }),
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      chamadas.push({ fn, args });
      return resposta;
    },
  };
  return { db: db as never, chamadas, orgsLidas };
}

const entrada = (extra: Record<string, unknown> = {}) =>
  vendaCriarSchema.parse({ contact_id: CONTATO, itens: [{ product_id: PRODUTO, quantidade: 1, preco_unit_cents: 12000 }], ...extra });

beforeEach(() => vi.clearAllMocks());

describe("registrarVenda — o que vai ao banco", () => {
  it("chama UMA função do banco (uma transação) com a organização da sessão, nunca a do corpo", async () => {
    const { db, chamadas, orgsLidas } = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(db, ctx, { ...entrada(), organization_id: OUTRA_ORG } as never, "chave-1", { agora: AGORA });

    // A venda é UMA função (uma transação). Depois dela, só o aviso `venda.paga`, fora da transação.
    expect(chamadas.filter((c) => c.fn === "fn_registrar_venda")).toHaveLength(1);
    expect(chamadas[0]!.fn).toBe("fn_registrar_venda");
    expect(chamadas.slice(1).map((c) => c.fn)).toEqual(["emit_event"]);
    expect(chamadas[0]!.args.p_org).toBe(ORG);
    expect(JSON.stringify(chamadas[0]!.args)).not.toContain(OUTRA_ORG);
    expect(orgsLidas).toEqual([ORG]);
  });

  it("o valor editado por linha é o que vai (não o do catálogo), uma linha por produto", async () => {
    const { db, chamadas } = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(
      db,
      ctx,
      entrada({
        itens: [
          { product_id: PRODUTO, quantidade: 1, preco_unit_cents: 9990 },
          { product_id: PRODUTO, quantidade: 2, preco_unit_cents: 15000, desconto_cents: 1000 },
        ],
      }),
      null,
      { agora: AGORA },
    );
    expect(chamadas[0]!.args.p_itens).toEqual([
      { product_id: PRODUTO, nome: null, sku: null, quantidade: 1, preco_unit_cents: 9990, desconto_cents: 0 },
      { product_id: PRODUTO, nome: null, sku: null, quantidade: 2, preco_unit_cents: 15000, desconto_cents: 1000 },
    ]);
  });

  it("repassa a chave de idempotência e o negócio do dossiê", async () => {
    const { db, chamadas } = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(db, ctx, entrada({ lead_id: LEAD }), "chave-do-clique", { agora: AGORA });
    expect(chamadas[0]!.args).toMatchObject({ p_chave: "chave-do-clique", p_lead: LEAD, p_contact: CONTATO });
  });

  it("repassa o negócio PREVISTO (id ou \"novo\") para a função recusar se o alvo mudou; sem ele, null (sem conferência)", async () => {
    const a = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(a.db, ctx, entrada({ negocio_previsto: LEAD }), "k", { agora: AGORA });
    expect(a.chamadas[0]!.args.p_negocio_previsto).toBe(LEAD);
    const b = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(b.db, ctx, entrada({ negocio_previsto: "novo" }), "k", { agora: AGORA });
    expect(b.chamadas[0]!.args.p_negocio_previsto).toBe("novo");
    const c = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(c.db, ctx, entrada(), "k", { agora: AGORA });
    expect(c.chamadas[0]!.args.p_negocio_previsto).toBeNull();
  });

  it("data de hoje = agora; data passada = meio do dia no fuso da organização", async () => {
    const hoje = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(hoje.db, ctx, entrada({ data_venda: "2026-11-08" }), null, { agora: AGORA });
    expect(hoje.chamadas[0]!.args.p_fechada_em).toBe(AGORA.toISOString());

    const passada = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(passada.db, ctx, entrada({ data_venda: "2026-11-02" }), null, { agora: AGORA });
    expect(passada.chamadas[0]!.args.p_fechada_em).toBe("2026-11-02T15:00:00.000Z");
  });

  it("data futura é recusada ANTES de tocar o banco", async () => {
    const { db, chamadas } = dbCom({ data: retornoDaFuncao(), error: null });
    await expect(registrarVenda(db, ctx, entrada({ data_venda: "2026-11-09" }), null, { agora: AGORA })).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
      details: { motivo: "data_futura" },
    });
    expect(chamadas).toHaveLength(0);
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });
});

describe("registrarVenda — o rastro (timeline, audit, evento)", () => {
  it("sem negócio aberto: nasce um negócio e a venda deixa criado + ganho no audit, e UMA linha na timeline", async () => {
    const { db } = dbCom({ data: retornoDaFuncao({ criado: true }), error: null });
    const r = await registrarVenda(db, ctx, entrada(), "k", { agora: AGORA });

    // a resposta traz o total PERSISTIDO no negócio e a moeda dele (é o número que a confirmação mostra)
    expect(r).toMatchObject({ lead_id: LEAD, criado: true, ja_registrada: false, total_cents: 12000, currency: "BRL" });
    expect(emitLeadActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitLeadActivity).mock.calls[0]![1]).toMatchObject({
      organizationId: ORG,
      leadId: LEAD,
      type: "demand_closed",
      payload: expect.objectContaining({ desfecho: "won", origem: "registrar_venda", total_cents: 12000, to_stage_id: ETAPA_GANHO }),
    });
    const acoes = vi.mocked(audit).mock.calls.map((c) => c[0].action);
    expect(acoes).toEqual(["lead.created", "lead.won"]);
    expect(vi.mocked(audit).mock.calls.every((c) => c[0].organizationId === ORG)).toBe(true);
  });

  it("emite venda.paga para os agentes externos, SEM valor nenhum no aviso", async () => {
    const { db, chamadas } = dbCom({ data: retornoDaFuncao(), error: null });
    await registrarVenda(db, ctx, entrada(), "k", { agora: AGORA });
    const evento = chamadas.find((c) => c.fn === "emit_event")!;
    expect(evento.args).toMatchObject({ p_event_type: "venda.paga", p_entity_kind: "crm_lead", p_entity_id: LEAD, p_organization_id: ORG });
    expect(JSON.stringify(evento.args)).not.toMatch(/cents|12000|valor/);
    // Sem a marca de origem do Registrar venda: ela bloquearia o `call_webhook` que entrega o aviso.
    expect((evento.args.p_metadata as Record<string, unknown>).origem).toBeUndefined();
  });

  it("com negócio aberto: só o ganho (não cria negócio)", async () => {
    const { db } = dbCom({ data: retornoDaFuncao({ criado: false }), error: null });
    await registrarVenda(db, ctx, entrada(), "k", { agora: AGORA });
    expect(vi.mocked(audit).mock.calls.map((c) => c[0].action)).toEqual(["lead.won"]);
  });

  it("o mesmo clique repetido (mesma chave) devolve a venda e NÃO duplica timeline nem audit", async () => {
    const { db, chamadas } = dbCom({ data: retornoDaFuncao({ ja_registrada: true, from_stage_id: null }), error: null });
    const r = await registrarVenda(db, ctx, entrada(), "k", { agora: AGORA });
    expect(r).toMatchObject({ lead_id: LEAD, ja_registrada: true });
    // Nem o aviso `venda.paga` sai de novo: o agente externo não recebe a mesma venda duas vezes.
    expect(chamadas.map((c) => c.fn)).toEqual(["fn_registrar_venda"]);
    expect(emitLeadActivity).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("falha na timeline não desfaz a venda (a venda já foi commitada); é só registrada", async () => {
    vi.mocked(emitLeadActivity).mockResolvedValueOnce({ ok: false, error: "boom" });
    const { db } = dbCom({ data: retornoDaFuncao(), error: null });
    await expect(registrarVenda(db, ctx, entrada(), "k", { agora: AGORA })).resolves.toMatchObject({ lead_id: LEAD });
  });
});

describe("registrarVenda — falha no meio não deixa venda pela metade", () => {
  it("erro do banco = nada de timeline nem audit, e um erro HTTP legível", async () => {
    const { db } = dbCom({ data: null, error: { message: "venda:pipeline_no_won_stage" } });
    const erro = await registrarVenda(db, ctx, entrada(), "k", { agora: AGORA }).catch((e) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 422, code: "validation_failed", details: { motivo: "pipeline_no_won_stage" } });
    expect(emitLeadActivity).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["venda:contato_nao_encontrado", 404, "not_found"],
    ["venda:negocio_nao_encontrado", 404, "not_found"],
    ["venda:produto_nao_encontrado", 422, "validation_failed"],
    ["venda:data_futura", 422, "validation_failed"],
    ["venda:contato_anonimizado", 422, "validation_failed"],
  ])("%s vira %i %s", async (mensagem, status, code) => {
    const { db } = dbCom({ data: null, error: { message: mensagem } });
    await expect(registrarVenda(db, ctx, entrada(), "k", { agora: AGORA })).rejects.toMatchObject({ status, code });
  });

  it("o alvo mudou com o quadro aberto: 409 state_conflict com motivo, mensagem clara e nada de rastro", async () => {
    const { db } = dbCom({ data: null, error: { message: "venda:alvo_mudou" } });
    const erro = await registrarVenda(db, ctx, entrada({ negocio_previsto: LEAD }), "k", { agora: AGORA }).catch((e) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 409, code: "state_conflict", details: { motivo: "alvo_mudou" } });
    expect(erro.message).toMatch(/mudou/i);
    expect(emitLeadActivity).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("RLS negando (viewer ou outra organização) vira 403, sem vazar detalhe do banco", async () => {
    const { db } = dbCom({ data: null, error: { message: 'new row violates row-level security policy for table "crm_lead_items"', code: "42501" } });
    const erro = await registrarVenda(db, ctx, entrada(), "k", { agora: AGORA }).catch((e) => e);
    expect(erro).toMatchObject({ status: 403, code: "forbidden" });
    expect(erro.message).not.toMatch(/row-level|crm_lead_items/);
  });

  it("erro inesperado vira 500 sem repassar a mensagem do banco", async () => {
    const { db } = dbCom({ data: null, error: { message: 'relation "x" does not exist' } });
    const erro = await registrarVenda(db, ctx, entrada(), "k", { agora: AGORA }).catch((e) => e);
    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
    expect(erro.message).not.toContain("relation");
  });
});

describe("registrarVenda: tag de compra", () => {
  it("chama acrescentarTagsDeCompra para o negócio da venda", async () => {
    const { acrescentarTagsDeCompra } = await import("./tag-de-compra");
    const { db } = dbCom({ data: retornoDaFuncao(), error: null });
    const input = entrada();
    await registrarVenda(db, ctx, input, null, { agora: AGORA });
    expect(acrescentarTagsDeCompra).toHaveBeenCalledWith(db, ctx, LEAD, input.itens);
  });
});
