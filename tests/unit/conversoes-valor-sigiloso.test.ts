/**
 * A COMISSÃO NÃO SAI DA INSTALAÇÃO PARA A META.
 *
 * Um negócio de valor sigiloso (`crm_leads.valor_sigiloso`, migration 0251) tem em `value_cents` a COMISSÃO do operador. A
 * conversão da venda continua sendo reportada (a Meta precisa saber que houve venda para atribuir ao anúncio), mas SEM valor
 * e SEM moeda: o valor da comissão nunca viaja para o terceiro, nem no corpo da requisição nem no livro-razão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "22222222-2222-2222-2222-222222222222";
const CONTATO = "33333333-3333-3333-3333-333333333333";

const gravados: Array<{ tabela: string; valores: Record<string, unknown> }> = [];
let colunasPedidas: string[] = [];

function fakeAdmin(tabelas: Record<string, unknown>) {
  return {
    from(tabela: string) {
      const c: Record<string, unknown> = {};
      c.select = (colunas?: string) => {
        if (tabela === "crm_leads" && colunas) colunasPedidas = colunas.split(",").map((x) => x.trim());
        return c;
      };
      for (const m of ["eq", "neq", "order", "limit"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data: tabelas[tabela] ?? null, error: null });
      c.upsert = async (valores: Record<string, unknown>) => {
        gravados.push({ tabela, valores });
        return { error: null };
      };
      return c;
    },
    rpc: async () => ({ data: "token-decifrado", error: null }),
  };
}

const lead = (extra: Record<string, unknown> = {}) => ({
  id: LEAD, status: "won", value_cents: 493_71, currency: "BRL", closed_at: new Date().toISOString(), contact_id: CONTATO, valor_sigiloso: false, ...extra,
});
const contato = { phone_number: "+55 (11) 90000-0001", source_metadata: { ad_platform: "meta_ads", ad_source_id: "CLIQUE_ABC" } };
const conexao = { dataset_id: "123456789012345", access_token_encrypted: "\xdeadbeef", test_event_code: null, enabled: true };

const evento = (): EventRow => ({
  id: "evt", organization_id: ORG, event_type: "lead.won", entity_kind: "crm_lead", entity_id: LEAD,
  payload: {}, metadata: {}, consumed_by: [], attempts: 0, created_at: new Date().toISOString(),
});

function corpoEnviado(fetchSpy: ReturnType<typeof vi.spyOn>): { data: Array<Record<string, unknown>> } {
  return JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
}

beforeEach(() => {
  gravados.length = 0;
  colunasPedidas = [];
  vi.restoreAllMocks();
});

describe("conversão de venda — negócio de valor sigiloso", () => {
  it("a venda é reportada, mas SEM valor e SEM moeda no corpo que vai à Meta", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ crm_leads: lead({ valor_sigiloso: true }), contacts: contato, ad_platform_connections: conexao }) as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const r = await conversaoDeVendaHandler.handle(evento());

    expect(r.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const evt = corpoEnviado(fetchSpy).data[0]!;
    expect(evt.event_name).toBe("Purchase");
    expect(evt.custom_data ?? {}).not.toHaveProperty("value");
    expect(evt.custom_data ?? {}).not.toHaveProperty("currency");
    expect(JSON.stringify(corpoEnviado(fetchSpy))).not.toMatch(/493|4\.9371|49371/);
  });

  it("o livro-razão não guarda o valor da comissão: registra o envio com valor nulo", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ crm_leads: lead({ valor_sigiloso: true }), contacts: contato, ad_platform_connections: conexao }) as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await conversaoDeVendaHandler.handle(evento());
    const registro = gravados.find((g) => g.tabela === "ad_conversion_dispatches")!;
    expect(registro.valores.status).toBe("sent");
    expect(Object.values(registro.valores)).not.toContain(49371);
    expect(registro.valores.value_cents ?? registro.valores.valor_centavos ?? null).toBeNull();
  });

  it("negócio sigiloso SEM valor também é reportado (a venda conta; 'sem_valor' não se aplica)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ crm_leads: lead({ valor_sigiloso: true, value_cents: null }), contacts: contato, ad_platform_connections: conexao }) as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await conversaoDeVendaHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("negócio comum continua mandando o valor e a moeda, como sempre", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ crm_leads: lead(), contacts: contato, ad_platform_connections: conexao }) as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await conversaoDeVendaHandler.handle(evento());
    expect(corpoEnviado(fetchSpy).data[0]!.custom_data).toEqual({ value: 493.71, currency: "BRL" });
  });

  it("o handler LÊ a coluna do sigilo (sem ela não há como decidir)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ crm_leads: lead(), contacts: contato, ad_platform_connections: conexao }) as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await conversaoDeVendaHandler.handle(evento());
    expect(colunasPedidas).toContain("valor_sigiloso");
  });
});
