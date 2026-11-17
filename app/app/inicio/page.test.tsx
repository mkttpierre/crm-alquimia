/**
 * O Início com dois painéis: quem vê o seletor e o painel de vendas, e de onde vem a escolha.
 *
 * Roda a página de servidor de verdade (`await InicioPage({ searchParams })`) com a sessão, o cookie, o resumo do
 * atendimento e o carregamento do painel de vendas substituídos. O que se prova é a DECISÃO de desenhar (papel, cookie,
 * período da URL) e o contrato com o carregador — não o Postgres.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Role } from "@/lib/auth/types";
import { calcularPainelDeVendas } from "@/lib/negocio/painel-vendas";
import type { PainelCarregado } from "@/lib/negocio/carregar-painel-vendas";
import type { ChaveDePeriodo } from "@/lib/negocio/periodos-do-painel";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "org-1";

const { anunciosProps, carregarPainel, carregarResumo, cookieGet, definirMeta, logger, refresh, toast } = vi.hoisted(() => ({
  anunciosProps: [] as Array<Record<string, unknown>>,
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  carregarPainel: vi.fn(),
  carregarResumo: vi.fn(),
  cookieGet: vi.fn(),
  definirMeta: vi.fn(async (_: unknown) => ({ ok: true }) as { ok: boolean; error?: string }),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

let papel: Role = "viewer";
let platformAdmin = false;
type Suporte = { id: string; status: "active" | "expired" | "revoked"; access_mode: "full" | "support_readonly" };
let suporte: Suporte | null = null;

vi.mock("@/lib/logger", () => ({ logger }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/actions/inicio/escolherPainel", () => ({ escolherPainelDoInicio: vi.fn() }));
vi.mock("@/app/actions/inicio/definirMetaMensal", () => ({ definirMetaMensal: definirMeta }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: USER, idioma: "pt-BR", is_platform_admin: platformAdmin, support: suporte }),
  resolveActiveOrg: async () => ({ orgId: ORG, name: "Org", role: papel }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ marca: "db-da-sessao" }) }));
vi.mock("@/lib/inicio/resumo", () => ({ carregarResumoDoInicio: carregarResumo }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map() }));
vi.mock("@/lib/negocio/carregar-painel-vendas", () => ({ carregarPainelDeVendasDaSessao: carregarPainel }));
// A leitura de anúncios fala com a plataforma e é async: a vista dela é testada à parte (PainelDeVendas.test.tsx).
vi.mock("./_components/vendas/AnunciosDoPeriodo", () => ({
  AnunciosDoPeriodo: (props: Record<string, unknown>) => {
    anunciosProps.push(props);
    return <div data-testid="anuncios-montado" />;
  },
}));

import InicioPage from "./page";

const RESUMO = {
  conversas: { abertas: 3, esperandoResposta: 1 },
  leads: { hoje: 2, ontem: 1 },
  motor: null,
  semanas: [],
  funis: [],
  atividades: [],
};

function carregado(over: { vendas?: boolean; chave?: ChaveDePeriodo } = {}): PainelCarregado {
  const comVendas = over.vendas !== false;
  const painel = calcularPainelDeVendas({
    negocios: comVendas
      ? [{ lead_id: "l1", pipeline_id: "p", closed_at: "2026-11-05T15:00:00.000Z", value_cents: 100_000, currency: "BRL", itens: [] }]
      : [],
    pedidos: [],
    pipelines: new Map([["p", "Funil"]]),
    moeda: "BRL",
    timezone: "America/Sao_Paulo",
    desde: "2026-11-01",
    ate: "2026-11-16",
    anterior: { desde: "2026-10-16", ate: "2026-10-31" },
    somenteNegocios: false,
    hoje: "2026-11-16",
    regrasDeOrigem: { produtos: [], por_fonte: {} },
    leads: { atual: { criados: 0, ganhos: 0 }, anterior: { criados: 0, ganhos: 0 } },
    comprasDosContatos: [],
    metaCents: null,
  });
  return { painel, periodo: { chave: over.chave ?? "mes", desde: "2026-11-01", ate: "2026-11-16" }, hoje: "2026-11-16", timezone: "America/Sao_Paulo", truncado: false };
}

async function abrir(periodo?: string) {
  render(await InicioPage({ searchParams: Promise.resolve(periodo ? { periodo } : {}) }));
}

const botaoDoSeletor = (nome: string) => screen.queryByRole("button", { name: nome });

beforeEach(() => {
  papel = "viewer";
  platformAdmin = false;
  suporte = null;
  carregarPainel.mockReset();
  carregarPainel.mockImplementation(async (_db: unknown, _org: string, chave: ChaveDePeriodo) => carregado({ chave }));
  carregarResumo.mockReset();
  carregarResumo.mockImplementation(async () => RESUMO);
  cookieGet.mockReset();
  cookieGet.mockReturnValue(undefined);
  definirMeta.mockClear();
  logger.error.mockClear();
  anunciosProps.length = 0;
  refresh.mockClear();
  toast.success.mockClear();
});
afterEach(cleanup);

describe("quem vê o seletor e o painel de vendas", () => {
  it("⭐ viewer e agent veem o Início de hoje: sem seletor, sem painel de vendas, e nem leem o cookie", async () => {
    for (const p of ["viewer", "agent"] as Role[]) {
      papel = p;
      // Mesmo com um cookie de vendas à mão (cargo rebaixado, cookie forjado).
      cookieGet.mockReturnValue({ value: "vendas" });
      await abrir();
      expect(botaoDoSeletor("Atendimento e envios")).toBeNull();
      expect(botaoDoSeletor("Vendas e faturamento")).toBeNull();
      expect(screen.queryByTestId("painel-de-vendas")).toBeNull();
      expect(screen.getByText("Conversas abertas")).toBeTruthy();
      cleanup();
    }
    expect(carregarPainel).not.toHaveBeenCalled();
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it("⭐ manager vê o seletor, e sem escolha anterior o painel é o de atendimento", async () => {
    papel = "manager";
    await abrir();
    expect(botaoDoSeletor("Atendimento e envios")?.getAttribute("aria-pressed")).toBe("true");
    expect(botaoDoSeletor("Vendas e faturamento")?.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Conversas abertas")).toBeTruthy();
    expect(screen.queryByTestId("painel-de-vendas")).toBeNull();
    expect(carregarPainel).not.toHaveBeenCalled();
  });

  it("admin e platform admin (fora do suporte) também veem o seletor; em suporte, não", async () => {
    papel = "admin";
    await abrir();
    expect(botaoDoSeletor("Vendas e faturamento")).toBeTruthy();
    cleanup();

    papel = "viewer";
    platformAdmin = true;
    await abrir();
    expect(botaoDoSeletor("Vendas e faturamento")).toBeTruthy();
    cleanup();

    suporte = { id: "s", status: "active", access_mode: "full" };
    await abrir();
    expect(botaoDoSeletor("Vendas e faturamento")).toBeNull();
  });
});

describe("o painel escolhido volta no próximo acesso, já no HTML do servidor", () => {
  it("⭐ cookie 'vendas': a página nasce com o painel de vendas (sem trocar depois) e o seletor marca a escolha", async () => {
    papel = "manager";
    cookieGet.mockReturnValue({ value: "vendas" });
    await abrir();
    expect(cookieGet).toHaveBeenCalledWith(`inicio_painel_${USER}`);
    expect(screen.getByTestId("painel-de-vendas")).toBeTruthy();
    expect(botaoDoSeletor("Vendas e faturamento")?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Conversas abertas")).toBeNull();
    expect(carregarResumo).not.toHaveBeenCalled();
  });

  it("cookie 'atendimento' ou lixo: o painel de atendimento", async () => {
    papel = "manager";
    for (const valor of ["atendimento", "financeiro", ""]) {
      cookieGet.mockReturnValue({ value: valor });
      await abrir();
      expect(screen.queryByTestId("painel-de-vendas")).toBeNull();
      expect(screen.getByText("Conversas abertas")).toBeTruthy();
      cleanup();
    }
  });
});

describe("o período vem da URL", () => {
  beforeEach(() => {
    papel = "manager";
    cookieGet.mockReturnValue({ value: "vendas" });
  });

  it("⭐ sem período: 'Este mês'; com período válido, ele; com lixo, 'Este mês'", async () => {
    await abrir();
    expect(carregarPainel.mock.calls.at(-1)?.slice(1, 3)).toEqual([ORG, "mes"]);
    cleanup();
    await abrir("7d");
    expect(carregarPainel.mock.calls.at(-1)?.slice(1, 3)).toEqual([ORG, "7d"]);
    cleanup();
    await abrir("90d");
    expect(carregarPainel.mock.calls.at(-1)?.slice(1, 3)).toEqual([ORG, "90d"]);
    cleanup();
    await abrir("<script>");
    expect(carregarPainel.mock.calls.at(-1)?.slice(1, 3)).toEqual([ORG, "mes"]);
  });

  it("a organização é a da sessão, e o cliente é o do USUÁRIO (a RLS decide)", async () => {
    await abrir("hoje");
    expect(carregarPainel.mock.calls[0]?.[0]).toEqual({ marca: "db-da-sessao" });
    expect(carregarPainel.mock.calls[0]?.[1]).toBe(ORG);
  });

  it("os cinco períodos aparecem como links, com o escolhido marcado", async () => {
    await abrir("mes-passado");
    const links = screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/app/inicio?periodo="));
    expect(links.map((a) => a.textContent)).toEqual(["Hoje", "7 dias", "Este mês", "Mês passado", "90 dias"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, null, null, "true", null]);
  });
});

describe("estados do painel", () => {
  beforeEach(() => {
    papel = "manager";
    cookieGet.mockReturnValue({ value: "vendas" });
  });

  it("⭐ empresa sem vendas: mensagem clara, sem cartões de zero nem gráfico", async () => {
    carregarPainel.mockImplementation(async () => carregado({ vendas: false }));
    await abrir();
    expect(screen.getByText(/Ainda não há vendas registradas/)).toBeTruthy();
    expect(screen.queryByText("Ticket médio")).toBeNull();
    expect(screen.queryByText("Faturamento por dia")).toBeNull();
  });

  it("com vendas: cartões, gráfico e blocos aparecem", async () => {
    await abrir();
    expect(screen.getByText("Faturamento")).toBeTruthy();
    expect(screen.getByText("Ticket médio")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Faturamento por dia" })).toBeTruthy();
    expect(screen.getByText("Produtos mais vendidos")).toBeTruthy();
    expect(screen.getByText("Vendas por origem")).toBeTruthy();
    expect(screen.getByText("Conversão de leads em venda")).toBeTruthy();
    expect(screen.getByText("Tempo médio até a venda")).toBeTruthy();
    expect(screen.getByText("Clientes que compraram de novo")).toBeTruthy();
    expect(screen.getByTestId("anuncios-montado")).toBeTruthy();
  });

  it("⭐ achado 10: os anúncios recebem o 'hoje' da organização e a série do painel (para cortar o gasto e o ROAS em ontem)", async () => {
    await abrir();
    expect(anunciosProps).toHaveLength(1);
    expect(anunciosProps[0]).toMatchObject({ organizationId: ORG, desde: "2026-11-01", ate: "2026-11-16", hoje: "2026-11-16", moeda: "BRL" });
    expect((anunciosProps[0]?.serie as unknown[]).length).toBe(16);
  });

  it("⭐ achado 3: a falha do painel deixa rastro no log, com a organização, a mensagem e o código, sem valor de dinheiro", async () => {
    // O formato REAL do erro do Supabase (postgrest-js sem `throwOnError`): objeto simples, NÃO `Error`. O `details` do 23514
    // traz a linha com valores, então nunca entra no log.
    carregarPainel.mockImplementation(async () => {
      throw {
        message: 'new row for relation "crm_leads" violates check constraint',
        code: "23514",
        details: "Failing row contains (value_cents=12345600, total_cents=9900000).",
        hint: "faturamento acima do limite",
      };
    });
    await abrir();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [mensagem, contexto] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(mensagem).toMatch(/painel de vendas/);
    expect(contexto).toEqual({ org_id: ORG, message: 'new row for relation "crm_leads" violates check constraint', code: "23514" });
    const registrado = JSON.stringify(logger.error.mock.calls);
    expect(registrado).not.toContain("[object Object]");
    expect(registrado).not.toMatch(/total_cents|value_cents|faturamento|12345600/);
  });

  it("Error comum: a mensagem vai ao log, sem código", async () => {
    carregarPainel.mockImplementation(async () => {
      throw new Error('column "meta_mensal_cents" does not exist');
    });
    await abrir();
    expect(logger.error.mock.calls[0]?.[1]).toEqual({ org_id: ORG, message: 'column "meta_mensal_cents" does not exist' });
  });

  it("erro que não é objeto (texto solto) ou objeto sem mensagem também vira texto no log, sem lançar", async () => {
    carregarPainel.mockImplementationOnce(async () => {
      throw "texto solto";
    });
    await abrir();
    expect(logger.error.mock.calls[0]?.[1]).toEqual({ org_id: ORG, message: "texto solto" });
    cleanup();
    carregarPainel.mockImplementationOnce(async () => {
      throw { code: "42501", details: "linha com valor 999" };
    });
    await abrir();
    const contexto = logger.error.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(contexto.code).toBe("42501");
    expect(contexto.message).toBe("erro sem mensagem");
    expect(JSON.stringify(contexto)).not.toContain("999");
    cleanup();
    carregarPainel.mockImplementationOnce(async () => {
      throw null;
    });
    await abrir();
    expect(logger.error.mock.calls[2]?.[1]).toEqual({ org_id: ORG, message: "null" });
  });

  it("falha ao carregar: a página não cai, avisa, e o seletor continua lá para voltar ao atendimento", async () => {
    carregarPainel.mockImplementation(async () => {
      throw new Error("banco fora do ar");
    });
    await abrir();
    expect(screen.getByText(/Não consegui carregar o painel de vendas/)).toBeTruthy();
    expect(botaoDoSeletor("Atendimento e envios")).toBeTruthy();
    expect(screen.queryByText(/banco fora do ar/)).toBeNull();
  });
});

describe("a meta do mês na tela", () => {
  beforeEach(() => {
    cookieGet.mockReturnValue({ value: "vendas" });
  });

  it("⭐ só o admin vê o formulário; o manager vê o aviso de que ainda não há meta", async () => {
    papel = "manager";
    await abrir();
    expect(screen.getByText(/A meta mensal ainda não foi definida/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salvar meta" })).toBeNull();
    cleanup();

    papel = "admin";
    await abrir();
    expect(screen.getByRole("button", { name: "Salvar meta" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apagar meta" })).toBeNull();
  });

  it("⭐ achado 3 (suporte): a tela segue o servidor — acesso total mostra o formulário; somente leitura e acompanhamento vencido, não", async () => {
    papel = "admin";
    suporte = { id: "s", status: "active", access_mode: "full" };
    await abrir();
    expect(screen.getByRole("button", { name: "Salvar meta" })).toBeTruthy();
    cleanup();

    suporte = { id: "s", status: "active", access_mode: "support_readonly" };
    await abrir();
    expect(screen.queryByRole("button", { name: "Salvar meta" })).toBeNull();
    expect(screen.getByText(/Defina quanto a empresa quer faturar|A meta mensal ainda não foi definida/)).toBeTruthy();
    cleanup();

    suporte = { id: "s", status: "expired", access_mode: "full" };
    await abrir();
    expect(screen.queryByRole("button", { name: "Salvar meta" })).toBeNull();
  });

  it("⭐ o texto digitado vira centavos para a Server Action, e a tela se atualiza", async () => {
    papel = "admin";
    await abrir();
    fireEvent.change(screen.getByLabelText("Meta do mês (BRL)"), { target: { value: "50.000,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar meta" }));
    await waitFor(() => expect(definirMeta).toHaveBeenCalledWith({ metaCents: 5_000_050 }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Meta salva.");
  });

  it("valor que não é número: avisa na tela e NÃO chama a ação", async () => {
    papel = "admin";
    await abrir();
    fireEvent.change(screen.getByLabelText("Meta do mês (BRL)"), { target: { value: "muito" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar meta" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Digite só números/);
    expect(definirMeta).not.toHaveBeenCalled();
  });

  it("erro da ação aparece como texto, sem derrubar a tela", async () => {
    papel = "admin";
    definirMeta.mockResolvedValueOnce({ ok: false, error: "forbidden_role" });
    await abrir();
    fireEvent.change(screen.getByLabelText("Meta do mês (BRL)"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar meta" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Só quem administra esta empresa pode definir a meta/);
    expect(refresh).not.toHaveBeenCalled();
  });
});
