/**
 * As vistas do painel de vendas com dados: meta definida, anúncios (some sem fonte conectada), origem, espanhol.
 * Sem Server Action nem banco: as vistas recebem o resultado já calculado.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { calcularPainelDeVendas, type EntradaDoPainelDeVendas } from "@/lib/negocio/painel-vendas";
import type { PainelCarregado } from "@/lib/negocio/carregar-painel-vendas";
import { resumirAnuncios, type LeituraDeGasto } from "@/lib/plataformas-de-anuncio/gasto";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/inicio/definirMetaMensal", () => ({ definirMetaMensal: vi.fn() }));
vi.mock("@/app/actions/inicio/escolherPainel", () => ({ escolherPainelDoInicio: vi.fn() }));
// A vista de anúncios importa a leitura real (cliente de serviço do banco), que a vista pura não usa.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { AnunciosDoPeriodoVista } from "./AnunciosDoPeriodo";
import { Variacao } from "./CartoesDeVendas";
import { PainelDeVendas } from "./PainelDeVendas";

afterEach(cleanup);

function entrada(over: Partial<EntradaDoPainelDeVendas> = {}): EntradaDoPainelDeVendas {
  return {
    negocios: [
      { lead_id: "l1", pipeline_id: "p", closed_at: "2026-11-05T15:00:00.000Z", value_cents: 300_000, currency: "BRL", created_at: "2026-11-04T15:00:00.000Z", tags: ["META ADS"], contact_id: "c1", itens: [{ product_id: "x", nome: "Plano A", quantidade: 2, total_cents: 300_000, currency: "BRL" }] },
      { lead_id: "l2", pipeline_id: "p", closed_at: "2026-11-10T15:00:00.000Z", value_cents: 100_000, currency: "BRL", created_at: "2026-11-09T15:00:00.000Z", tags: [], contact_id: "c2", itens: [] },
      { lead_id: "l0", pipeline_id: "p", closed_at: "2026-10-20T15:00:00.000Z", value_cents: 200_000, currency: "BRL", created_at: "2026-10-19T15:00:00.000Z", tags: [], contact_id: "c3", itens: [] },
    ],
    pedidos: [],
    pipelines: new Map([["p", "Funil"]]),
    moeda: "BRL",
    timezone: "America/Sao_Paulo",
    desde: "2026-11-01",
    ate: "2026-11-16",
    anterior: { desde: "2026-10-16", ate: "2026-10-31" },
    somenteNegocios: false,
    hoje: "2026-11-16",
    regrasDeOrigem: { produtos: [], por_fonte: { meta: "Meta Ads" } },
    leads: { atual: { criados: 20, ganhos: 2 }, anterior: { criados: 10, ganhos: 1 } },
    comprasDosContatos: [],
    metaCents: 1_000_000,
    ...over,
  };
}

const carregar = (e: EntradaDoPainelDeVendas): PainelCarregado => ({
  painel: calcularPainelDeVendas(e),
  periodo: { chave: "mes", desde: e.desde, ate: e.ate },
  hoje: e.hoje,
  timezone: e.timezone,
  truncado: false,
});

describe("o painel com vendas", () => {
  it("⭐ mostra o faturamento, a variação contra o anterior, as vendas e o ticket médio", () => {
    render(<PainelDeVendas carregado={carregar(entrada())} idioma="pt-BR" admin={false} />);
    expect(screen.getAllByText(/4\.000,00/).length).toBeGreaterThan(0); // faturamento: 300.000 + 100.000 centavos
    const variacoes = screen.getAllByTestId("variacao").map((v) => v.textContent);
    expect(variacoes[0]).toMatch(/100/); // 400.000 contra 200.000
    expect(screen.getByText("Ticket médio")).toBeTruthy();
  });

  it("produtos e origem aparecem com os dados", () => {
    render(<PainelDeVendas carregado={carregar(entrada())} idioma="pt-BR" admin={false} />);
    const produtos = screen.getByText("Produtos mais vendidos").closest("section")!;
    expect(within(produtos).getByText("Plano A")).toBeTruthy();
    const origem = screen.getByText("Vendas por origem").closest("section")!;
    expect(within(origem).getByText("META ADS")).toBeTruthy();
    expect(within(origem).getByText("Sem origem")).toBeTruthy();
  });

  it("sem regras de origem: explica em vez de mostrar tudo como 'sem origem'", () => {
    render(<PainelDeVendas carregado={carregar(entrada({ regrasDeOrigem: { produtos: [], por_fonte: {} } }))} idioma="pt-BR" admin={false} />);
    expect(screen.getByText(/regras de origem cadastradas/)).toBeTruthy();
  });

  it("período de um dia só: o gráfico explica por que não aparece", () => {
    render(<PainelDeVendas carregado={carregar(entrada({ desde: "2026-11-16", ate: "2026-11-16" }))} idioma="pt-BR" admin={false} />);
    expect(screen.getByText(/O gráfico aparece a partir de dois dias/)).toBeTruthy();
  });

  it("⭐ empresa com produto interno: avisa que pedido da loja fica fora, sem mostrar valor de pedido", () => {
    const e = entrada({
      somenteNegocios: true,
      pedidos: [{ id: "o1", ordered_at: "2026-11-07T15:00:00.000Z", total_cents: 987_654_321, currency: "BRL", status: "paid" }],
    });
    const { container } = render(<PainelDeVendas carregado={carregar(e)} idioma="pt-BR" admin={false} />);
    expect(screen.getByText(/pedidos da loja ficam de fora/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/9\.876\.543/);
  });

  it("aviso de leitura incompleta quando o painel bateu no teto", () => {
    render(<PainelDeVendas carregado={{ ...carregar(entrada()), truncado: true }} idioma="pt-BR" admin={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/podem estar incompletos/);
  });

  it("em espanhol, os rótulos saem traduzidos", () => {
    render(<PainelDeVendas carregado={carregar(entrada())} idioma="es" admin={false} />);
    expect(screen.getByText("Facturación")).toBeTruthy();
    expect(screen.getByText("Ventas por origen")).toBeTruthy();
    expect(screen.getByText("Meta del mes")).toBeTruthy();
    expect(screen.queryByText("Faturamento")).toBeNull();
  });
});

describe("achado 2: tempo até a venda é uma métrica em que MENOR é melhor", () => {
  const h = (n: number) => n * 3_600_000;
  const negocioCom = (dia: string, horas: number, id: string) => ({
    lead_id: id,
    pipeline_id: "p",
    closed_at: `${dia}T15:00:00.000Z`,
    value_cents: 1_000,
    currency: "BRL",
    created_at: new Date(new Date(`${dia}T15:00:00.000Z`).getTime() - h(horas)).toISOString(),
    itens: [],
  });

  it("⭐ venda que passou a demorar MAIS (positivo) sai vermelha, não verde", () => {
    const e = entrada({ negocios: [negocioCom("2026-11-05", 48, "a"), negocioCom("2026-10-20", 24, "b")] });
    render(<PainelDeVendas carregado={carregar(e)} idioma="pt-BR" admin={false} />);
    const cartao = screen.getByText("Tempo médio até a venda").closest("section")!;
    const v = within(cartao).getByTestId("variacao");
    expect(v.textContent).toMatch(/100/);
    expect(v.className).toContain("text-error-fg");
    expect(v.className).not.toContain("text-success-fg");
  });

  it("⭐ venda que passou a demorar MENOS (negativo) sai verde", () => {
    const e = entrada({ negocios: [negocioCom("2026-11-05", 24, "a"), negocioCom("2026-10-20", 48, "b")] });
    render(<PainelDeVendas carregado={carregar(e)} idioma="pt-BR" admin={false} />);
    const cartao = screen.getByText("Tempo médio até a venda").closest("section")!;
    const v = within(cartao).getByTestId("variacao");
    expect(v.className).toContain("text-success-fg");
    expect(v.className).not.toContain("text-error-fg");
  });

  it("Variacao: sem a propriedade, positivo é verde e negativo é vermelho (faturamento); com ela, invertido; zero é neutro", () => {
    const cor = (v: number, menorEhMelhor?: boolean) => {
      const { unmount } = render(<Variacao variacao={v} idioma="pt-BR" menorEhMelhor={menorEhMelhor} />);
      const classe = screen.getByTestId("variacao").className;
      unmount();
      return classe.includes("text-success-fg") ? "verde" : classe.includes("text-error-fg") ? "vermelho" : "neutro";
    };
    expect(cor(10)).toBe("verde");
    expect(cor(-10)).toBe("vermelho");
    expect(cor(10, true)).toBe("vermelho");
    expect(cor(-10, true)).toBe("verde");
    expect(cor(0)).toBe("neutro");
    expect(cor(0, true)).toBe("neutro");
  });
});

describe("a meta do mês com meta definida", () => {
  it("⭐ barra de progresso, quanto falta e ritmo por dia", () => {
    render(<PainelDeVendas carregado={carregar(entrada())} idioma="pt-BR" admin={false} />);
    const barra = screen.getByRole("progressbar", { name: "Meta do mês" });
    expect(barra.getAttribute("aria-valuenow")).toBe("40"); // 400.000 de 1.000.000
    const cartao = barra.closest("section")!;
    expect(within(cartao).getByText("Falta")).toBeTruthy();
    expect(within(cartao).getByText(/6\.000,00/)).toBeTruthy(); // faltam 600.000 centavos
    expect(within(cartao).getByText("Ritmo necessário por dia")).toBeTruthy();
    expect(within(cartao).getByText(/15 dias restantes/)).toBeTruthy();
    expect(within(cartao).queryByRole("button", { name: "Salvar meta" })).toBeNull();
  });

  it("meta batida", () => {
    render(<PainelDeVendas carregado={carregar(entrada({ metaCents: 100_000 }))} idioma="pt-BR" admin />);
    expect(screen.getByText("Meta batida")).toBeTruthy();
    expect(screen.getByText("Passou da meta em")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Meta do mês" }).getAttribute("aria-valuenow")).toBe("100");
  });

  it("admin com meta vê o formulário preenchido e o botão de apagar", () => {
    render(<PainelDeVendas carregado={carregar(entrada())} idioma="pt-BR" admin />);
    expect((screen.getByLabelText("Meta do mês (BRL)") as HTMLInputElement).value).toBe("10000");
    expect(screen.getByRole("button", { name: "Apagar meta" })).toBeTruthy();
  });
});

describe("anúncios: gasto, ROAS e custo por venda", () => {
  const meta = (gasto: number): LeituraDeGasto => ({ estado: "conectada", plataforma: "meta_ads", gasto_cents: gasto, moeda: "BRL" });
  const google: LeituraDeGasto = { estado: "nao_conectada", plataforma: "google_ads" };
  const fat = { total_cents: 400_000, vendas: 2 };

  it("⭐ Meta conectado e Google não: mostra os três cartões e a lista de plataformas", () => {
    render(<AnunciosDoPeriodoVista resumo={resumirAnuncios([meta(100_000), google], fat)} moeda="BRL" idioma="pt-BR" />);
    expect(screen.getByText("Gasto em anúncios")).toBeTruthy();
    expect(screen.getByText("Retorno sobre o gasto (ROAS)")).toBeTruthy();
    expect(screen.getByText("4,00×")).toBeTruthy(); // 400.000 ÷ 100.000
    expect(screen.getByText("Custo por venda")).toBeTruthy();
    const lista = screen.getByText("Gasto por plataforma").closest("section")!;
    expect(within(lista).getByText("Meta Ads")).toBeTruthy();
    expect(within(lista).getByText("Google Ads")).toBeTruthy();
    expect(within(lista).getByText("não conectado")).toBeTruthy();
  });

  it("⭐ nenhuma fonte conectada: NADA é desenhado", () => {
    const { container } = render(
      <AnunciosDoPeriodoVista resumo={resumirAnuncios([{ estado: "nao_conectada", plataforma: "meta_ads" }, google], fat)} moeda="BRL" idioma="pt-BR" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("⭐ achado 10: período que chega a hoje avisa que o gasto não inclui hoje e até onde foi lido", () => {
    const resumo = resumirAnuncios([meta(100_000), google], { total_cents: 300_000, vendas: 3 }, { ate: "2026-11-15", sem_hoje: true });
    render(<AnunciosDoPeriodoVista resumo={resumo} moeda="BRL" idioma="pt-BR" />);
    const aviso = screen.getByText(/não inclui hoje/);
    expect(aviso.textContent).toMatch(/15\/11/);
    expect(aviso.textContent).toMatch(/mesmo intervalo/);
  });

  it("período já encerrado: sem aviso de 'hoje'", () => {
    const resumo = resumirAnuncios([meta(100_000), google], fat, { ate: "2026-10-31", sem_hoje: false });
    render(<AnunciosDoPeriodoVista resumo={resumo} moeda="BRL" idioma="pt-BR" />);
    expect(screen.queryByText(/não inclui hoje/)).toBeNull();
  });

  it("⭐ achado 10: 'Hoje' mostra os cartões sem número e diz que o gasto de hoje só fecha amanhã", () => {
    const resumo = resumirAnuncios([{ estado: "dia_incompleto", plataforma: "meta_ads" }, google], fat, { ate: "2026-11-15", sem_hoje: true });
    render(<AnunciosDoPeriodoVista resumo={resumo} moeda="BRL" idioma="pt-BR" />);
    expect(screen.getAllByText(/só fica completo amanhã/).length).toBeGreaterThan(0);
    expect(screen.getByText("Gasto em anúncios")).toBeTruthy();
    expect(screen.queryByText("4,00×")).toBeNull();
    expect(screen.queryByText(/não inclui hoje/)).toBeNull();
  });

  it("conta sem conta padrão: o cartão fica e mostra o caminho para resolver", () => {
    render(<AnunciosDoPeriodoVista resumo={resumirAnuncios([{ estado: "sem_conta", plataforma: "meta_ads" }, google], fat)} moeda="BRL" idioma="pt-BR" />);
    expect(screen.getByText(/sem conta de anúncios padrão/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Escolher a conta de anúncios padrão" }).getAttribute("href")).toBe("/app/settings/meta-ads");
  });
});
