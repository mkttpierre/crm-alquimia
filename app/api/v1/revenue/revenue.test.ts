// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { nomesDosAtendentes } from "@/lib/negocio/nomes-dos-atendentes";
import { repositorioFaturamentoSupabase } from "@/lib/negocio/repositorio-faturamento";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/negocio/repositorio-faturamento", () => ({ repositorioFaturamentoSupabase: vi.fn() }));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: vi.fn(async () => "BRL") }));
vi.mock("@/lib/negocio/nomes-dos-atendentes", () => ({ nomesDosAtendentes: vi.fn(async () => new Map()) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const repo = { fuso: vi.fn(), carregar: vi.fn() };
const get = (qs = "") => new NextRequest(`http://localhost/api/v1/revenue${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u" }, org: { orgId: ORG_ID, role: "manager" } } as never);
  vi.mocked(repositorioFaturamentoSupabase).mockReturnValue(repo as never);
  repo.fuso.mockResolvedValue("America/Sao_Paulo");
  repo.carregar.mockResolvedValue({
    negocios: [{ lead_id: "a", pipeline_id: "p1", closed_at: "2026-11-02T15:00:00Z", value_cents: 10000, currency: "BRL", itens: [] }],
    pedidos: [{ id: "o", ordered_at: "2026-11-03T15:00:00Z", total_cents: 2000, currency: "BRL", status: "paid" }],
    pipelines: new Map([["p1", "Kit"]]),
    truncado: false,
  });
});

describe("GET /revenue — organização com produto interno", () => {
  const dadosCom = (temProdutoInterno: boolean) => ({
    negocios: [{ lead_id: "a", pipeline_id: "p1", closed_at: "2026-11-09T15:00:00Z", value_cents: 10000, currency: "BRL", itens: [] }],
    pedidos: [{ id: "o", ordered_at: "2026-11-09T18:00:00Z", total_cents: 7000, currency: "BRL", status: "paid" }],
    pipelines: new Map([["p1", "Kit"]]),
    temProdutoInterno,
    truncado: false,
  });

  it("o total, as vendas e o ticket contam só negócios ganhos; o pedido da loja aparece 'fora do total'", async () => {
    repo.carregar.mockResolvedValueOnce(dadosCom(true));
    const { GET } = await import("./route");
    const { data } = (await (await GET(get("?desde=2026-11-08&ate=2026-11-14"))).json()) as { data: { total_cents: number; numero_de_vendas: number; ticket_medio_cents: number; somente_negocios: boolean; fora_do_total: { pedidos_cents: number; pedidos: number } } };
    expect(data).toMatchObject({ total_cents: 10000, numero_de_vendas: 1, ticket_medio_cents: 10000, somente_negocios: true, fora_do_total: { pedidos_cents: 7000, pedidos: 1 } });
  });

  it("sem produto interno, o comportamento é o de sempre (pedido entra na soma)", async () => {
    repo.carregar.mockResolvedValueOnce(dadosCom(false));
    const { GET } = await import("./route");
    const { data } = (await (await GET(get("?desde=2026-11-08&ate=2026-11-14"))).json()) as { data: { total_cents: number; numero_de_vendas: number; somente_negocios: boolean; fora_do_total: unknown } };
    expect(data).toMatchObject({ total_cents: 17000, numero_de_vendas: 2, somente_negocios: false, fora_do_total: null });
  });
});

describe("GET /revenue — painel", () => {
  it("lê as linhas dos DOIS períodos e devolve o resumo do anterior de mesmo tamanho", async () => {
    repo.carregar.mockResolvedValueOnce({
      negocios: [
        { lead_id: "atual", pipeline_id: "p1", closed_at: "2026-11-09T15:00:00Z", value_cents: 10000, currency: "BRL", itens: [] },
        { lead_id: "antes", pipeline_id: "p1", closed_at: "2026-11-02T15:00:00Z", value_cents: 4000, currency: "BRL", itens: [] },
      ],
      pedidos: [],
      pipelines: new Map([["p1", "Kit"]]),
      truncado: false,
    });
    const { GET } = await import("./route");
    const res = await GET(get("?desde=2026-11-08&ate=2026-11-14"));
    const { data } = (await res.json()) as { data: { total_cents: number; anterior: { desde: string; ate: string; total_cents: number; numero_de_vendas: number } } };
    expect(data.total_cents).toBe(10000);
    expect(data.anterior).toMatchObject({ desde: "2026-11-01", ate: "2026-11-07", total_cents: 4000, numero_de_vendas: 1 });
    // a janela de busca começa um dia antes do INÍCIO DO ANTERIOR (2026-11-01), não do período pedido
    expect(repo.carregar.mock.calls[0]?.[1]).toEqual({ de: "2026-10-31T00:00:00.000Z", ate: "2026-11-17T00:00:00.000Z" });
  });

  it("resolve o nome dos atendentes pela organização da sessão e entrega atendentes e vendas", async () => {
    repo.carregar.mockResolvedValueOnce({
      negocios: [{ lead_id: "a", pipeline_id: "p1", closed_at: "2026-11-09T15:00:00Z", value_cents: 10000, currency: "BRL", titulo: "Venda — Maria", owner_user_id: "u1", owner_kind: "user", itens: [] }],
      pedidos: [],
      pipelines: new Map([["p1", "Kit"]]),
      truncado: false,
    });
    vi.mocked(nomesDosAtendentes).mockResolvedValueOnce(new Map([["u1", "Ana"]]));
    const { GET } = await import("./route");
    const res = await GET(get("?desde=2026-11-08&ate=2026-11-14"));
    const { data } = (await res.json()) as { data: { por_atendente: Array<{ nome: string; vendas: number }>; vendas: Array<{ lead_id: string; titulo: string; atendente_nome: string; funil: string }> } };
    expect(vi.mocked(nomesDosAtendentes)).toHaveBeenCalledWith(ORG_ID, ["u1"]);
    expect(data.por_atendente).toMatchObject([{ nome: "Ana", vendas: 1 }]);
    expect(data.vendas[0]).toMatchObject({ lead_id: "a", titulo: "Venda — Maria", atendente_nome: "Ana", funil: "Kit" });
  });
});

describe("GET /revenue", () => {
  it("calcula o período pedido com a org da sessão e exige manager+", async () => {
    const { GET } = await import("./route");
    const res = await GET(get("?desde=2026-11-01&ate=2026-11-07&granularidade=semana"));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { total_cents: number; ticket_medio_cents: number; por_pipeline: { nome: string }[]; truncado: boolean; timezone: string } };
    expect(data).toMatchObject({ total_cents: 12000, ticket_medio_cents: 6000, truncado: false, timezone: "America/Sao_Paulo" });
    expect(data.por_pipeline[0]?.nome).toBe("Kit");
    expect(repo.carregar.mock.calls[0]?.[0]).toBe(ORG_ID);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("sem período usa os últimos 30 dias", async () => {
    const { GET } = await import("./route");
    const res = await GET(get());
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { desde: string; ate: string } };
    const dias = (new Date(`${data.ate}T00:00:00Z`).getTime() - new Date(`${data.desde}T00:00:00Z`).getTime()) / 86_400_000;
    expect(dias).toBe(29);
  });

  it("período inválido responde 422 sem consultar", async () => {
    const { GET } = await import("./route");
    expect((await GET(get("?desde=2026-11-07&ate=2026-11-01"))).status).toBe(422);
    expect((await GET(get("?granularidade=ano"))).status).toBe(422);
    expect(repo.carregar).not.toHaveBeenCalled();
  });

  it("agent é barrado pelo requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const { GET } = await import("./route");
    expect((await GET(get())).status).toBe(403);
    expect(repo.carregar).not.toHaveBeenCalled();
  });

  it("leitura truncada é avisada, e falha do banco responde 500", async () => {
    repo.carregar.mockResolvedValueOnce({ negocios: [], pedidos: [], pipelines: new Map(), truncado: true });
    const { GET } = await import("./route");
    const ok1 = (await (await GET(get("?desde=2026-11-01&ate=2026-11-02"))).json()) as { data: { truncado: boolean } };
    expect(ok1.data.truncado).toBe(true);
    repo.carregar.mockRejectedValueOnce(new Error("boom"));
    expect((await GET(get("?desde=2026-11-01&ate=2026-11-02"))).status).toBe(500);
  });
});

describe("GET /revenue — moeda", () => {
  const dadosEm = (moeda: string) => ({
    negocios: [{ lead_id: "a", pipeline_id: "p1", closed_at: "2026-11-09T15:00:00Z", value_cents: 5000, currency: moeda, itens: [] }],
    pedidos: [],
    pipelines: new Map([["p1", "Kit"]]),
    truncado: false,
  });

  it("sem moeda na consulta, o painel é na moeda da ORGANIZAÇÃO (não em BRL fixo)", async () => {
    vi.mocked(moedaDaOrganizacao).mockResolvedValueOnce("MXN");
    repo.carregar.mockResolvedValueOnce(dadosEm("MXN"));
    const { GET } = await import("./route");
    const { data } = (await (await GET(get("?desde=2026-11-08&ate=2026-11-14"))).json()) as { data: { currency: string; total_cents: number } };
    expect(vi.mocked(moedaDaOrganizacao)).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    expect(data).toMatchObject({ currency: "MXN", total_cents: 5000 });
  });

  it("a moeda pedida na consulta vale e não consulta a organização", async () => {
    repo.carregar.mockResolvedValueOnce(dadosEm("USD"));
    const { GET } = await import("./route");
    const { data } = (await (await GET(get("?desde=2026-11-08&ate=2026-11-14&currency=USD"))).json()) as { data: { currency: string; total_cents: number } };
    expect(vi.mocked(moedaDaOrganizacao)).not.toHaveBeenCalled();
    expect(data).toMatchObject({ currency: "USD", total_cents: 5000 });
  });
});
