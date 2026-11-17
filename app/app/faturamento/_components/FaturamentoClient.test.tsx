import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { FaturamentoClient } from "./FaturamentoClient";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined, useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
// O recharts mede o contêiner (0×0 no jsdom) e não desenha nada: o que se afirma aqui é que o gráfico recebe a série certa.
vi.mock("recharts", async (original) => {
  const real = await original<Record<string, unknown>>();
  return { ...real, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="recharts-container">{children}</div> };
});

function respostaDia() {
  return {
    data: {
      timezone: "America/Sao_Paulo",
      truncado: false,
      currency: "BRL",
      desde: "2026-11-01",
      ate: "2026-11-07",
      granularidade: "dia",
      total_cents: 1000,
      receita_negocios_cents: 1000,
      receita_pedidos_cents: 0,
      numero_de_vendas: 1,
      ticket_medio_cents: 1000,
      serie: [{ chave: "2026-11-07", total_cents: 1000, vendas: 1 }],
      por_produto: [],
      por_pipeline: [],
      por_atendente: [],
      vendas: [],
      vendas_cortadas: false,
      somente_negocios: false,
      fora_do_total: null,
      anterior: { desde: "2026-10-25", ate: "2026-10-31", total_cents: 0, numero_de_vendas: 0, ticket_medio_cents: null },
      ignorados_outra_moeda: 0,
    },
  };
}

function respostaCompleta() {
  const base = respostaDia().data;
  return {
    data: {
      ...base,
      desde: "2026-11-08",
      ate: "2026-11-14",
      total_cents: 60000,
      receita_negocios_cents: 60000,
      numero_de_vendas: 3,
      ticket_medio_cents: 20000,
      serie: [
        { chave: "2026-11-09", total_cents: 40000, vendas: 2 },
        { chave: "2026-11-10", total_cents: 20000, vendas: 1 },
      ],
      por_produto: [
        { chave: "p-barato", nome: "1 MÊS (BETA)", quantidade: 5, total_cents: 20000 },
        { chave: "p-caro", nome: "12 MESES (BETA)", quantidade: 2, total_cents: 40000 },
        { chave: "__sem_produto__", nome: null, quantidade: 0, total_cents: 1500 },
      ],
      por_pipeline: [{ pipeline_id: "pipe-1", nome: "Kit", total_cents: 60000, vendas: 3 }],
      por_atendente: [
        { tipo: "usuario", user_id: "u1", nome: "Ana", vendas: 2, total_cents: 40000 },
        { tipo: "ia", user_id: null, nome: null, vendas: 1, total_cents: 20000 },
      ],
      vendas: [
        { tipo: "negocio", id: "lead-1", lead_id: "lead-1", pipeline_id: "pipe-1", titulo: "Venda — Maria", funil: "Kit", data: "2026-11-10T15:00:00Z", valor_cents: 20000, produtos: ["2× 1 MÊS (BETA)"], atendente_id: null, atendente_nome: null, atendente_tipo: "ia" },
        { tipo: "negocio", id: "lead-2", lead_id: "lead-2", pipeline_id: "pipe-1", titulo: "Venda — João", funil: "Kit", data: "2026-11-09T15:00:00Z", valor_cents: 30000, produtos: ["12 MESES (BETA)"], atendente_id: "u1", atendente_nome: "Ana", atendente_tipo: "usuario" },
        { tipo: "pedido", id: "ped-1", lead_id: null, pipeline_id: null, titulo: null, funil: null, data: "2026-11-09T12:00:00Z", valor_cents: 10000, produtos: [], atendente_id: null, atendente_nome: null, atendente_tipo: null },
      ],
      // período anterior: 50.000 em 4 vendas (ticket 12.500) → faturamento +20%, vendas -25%, ticket +60%
      anterior: { desde: "2026-11-01", ate: "2026-11-07", total_cents: 50000, numero_de_vendas: 4, ticket_medio_cents: 12500 },
    },
  };
}

class ErroDeRenderBoundary extends React.Component<
  { children: React.ReactNode },
  { erro: boolean }
> {
  state = { erro: false };

  static getDerivedStateFromError() {
    return { erro: true };
  }

  render() {
    return this.state.erro ? <p role="alert">A tela caiu</p> : this.props.children;
  }
}

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ErroDeRenderBoundary>
        <FaturamentoClient />
      </ErroDeRenderBoundary>
    </QueryClientProvider>,
  );
}

describe("FaturamentoClient — troca de granularidade", () => {
  let concluirConsultaMes: (() => void) | undefined;

  beforeEach(() => {
    concluirConsultaMes = undefined;
    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.get).mockImplementation((url: string) => {
      if (url.includes("granularidade=dia")) return Promise.resolve(respostaDia());
      // Mantém a resposta diária como placeholder durante a requisição mensal.
      return new Promise((resolve) => {
        concluirConsultaMes = () => resolve({
          data: {
            ...respostaDia().data,
            granularidade: "mes",
            serie: [{ chave: "2026-11", total_cents: 1000, vendas: 1 }],
          },
        });
      });
    });
  });

  it("não derruba a tela ao trocar Dia por Mês enquanto a resposta diária está visível", async () => {
    montar();
    expect(await screen.findByText("07/11")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Agrupar por" }), {
      target: { value: "mes" },
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("faturamento")).toBeInTheDocument();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining("granularidade=mes")));
    expect(screen.getByText("07/11")).toBeInTheDocument();
    concluirConsultaMes?.();
    expect(await screen.findByText("Nov/2026")).toBeInTheDocument();
  });

  it("preserva uma chave inesperada da API sem derrubar a tela", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        ...respostaDia().data,
        serie: [{ chave: "data-invalida", total_cents: 1000, vendas: 1 }],
      },
    });

    montar();

    expect(await screen.findByText("data-invalida")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("FaturamentoClient — painel com dados", () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.get).mockResolvedValue(respostaCompleta());
  });

  it("os três cartões comparam com o período anterior de mesmo tamanho", async () => {
    montar();
    await screen.findByTestId("grafico-faturamento");
    const variacoes = screen.getAllByTestId("variacao").map((n) => n.textContent?.replace(/\s+/g, " ").trim());
    expect(variacoes).toHaveLength(3);
    expect(variacoes[0]).toContain("+20%");
    expect(variacoes[1]).toContain("-25%");
    expect(variacoes[2]).toContain("+60%");
    expect(variacoes.every((v) => v?.includes("vs. período anterior"))).toBe(true);
  });

  it("sem período anterior com vendas, o cartão diz que não há com o que comparar (e não inventa %)", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { ...respostaCompleta().data, anterior: { desde: "2026-11-01", ate: "2026-11-07", total_cents: 0, numero_de_vendas: 0, ticket_medio_cents: null } } });
    montar();
    await screen.findByTestId("grafico-faturamento");
    expect(screen.queryAllByTestId("variacao")).toHaveLength(0);
    expect(screen.getAllByText("Sem período anterior para comparar")).toHaveLength(3);
  });

  it("o gráfico recebe a série do período e o contêiner está montado", async () => {
    montar();
    const grafico = await screen.findByTestId("grafico-faturamento");
    expect(screen.getByTestId("recharts-container")).toBeInTheDocument();
    // a mesma série em texto, para leitor de tela
    const linhas = within(grafico).getAllByRole("listitem").map((li) => li.textContent?.replace(/\s+/g, " "));
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatch(/09\/11: R\$\s*400,00/);
    expect(linhas[1]).toMatch(/10\/11: R\$\s*200,00/);
  });

  it("produtos mais vendidos: ordenados por quantidade, com a sobra sem produto à parte", async () => {
    montar();
    const ranking = await screen.findByTestId("ranking-de-produtos");
    const itens = within(ranking).getAllByRole("listitem");
    expect(itens[0]).toHaveTextContent("1 MÊS (BETA)");
    expect(itens[0]).toHaveTextContent("5 vendidos");
    expect(itens[1]).toHaveTextContent("12 MESES (BETA)");
    expect(itens).toHaveLength(2);
    expect(screen.getByText(/Sem produto informado: R\$\s*15,00/)).toBeInTheDocument();
  });

  it("atendentes com mais vendas: pessoa pelo nome e o agente de IA separado", async () => {
    montar();
    const ranking = await screen.findByTestId("ranking-de-atendentes");
    const itens = within(ranking).getAllByRole("listitem");
    expect(itens[0]).toHaveTextContent("Ana");
    expect(itens[0]).toHaveTextContent("2 vendas");
    expect(itens[1]).toHaveTextContent("Agente de IA");
    expect(itens[1]).toHaveTextContent("1 venda");
  });

  it("por funil lista o funil com vendas e total", async () => {
    montar();
    const ranking = await screen.findByTestId("ranking-de-funis");
    expect(ranking).toHaveTextContent("Kit");
    expect(ranking).toHaveTextContent("3 vendas");
  });

  it("tabela das vendas: link do lead, produtos, atendente, funil, data e valor; pedido da loja não vira link", async () => {
    montar();
    const tabela = await screen.findByTestId("tabela-de-vendas");
    const link = within(tabela).getByRole("link", { name: "Venda — João" });
    expect(link).toHaveAttribute("href", "/app/pipelines/pipe-1?lead=lead-2");
    const linhas = within(tabela).getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length > 0);
    expect(linhas).toHaveLength(3);
    const joao = linhas.find((l) => l.textContent?.includes("Venda — João"))!;
    expect(joao).toHaveTextContent("12 MESES (BETA)");
    expect(joao).toHaveTextContent("Ana");
    expect(joao).toHaveTextContent("Kit");
    expect(joao).toHaveTextContent("09/11/2026");
    expect(joao).toHaveTextContent(/R\$\s*300,00/);
    const maria = linhas.find((l) => l.textContent?.includes("Venda — Maria"))!;
    expect(maria).toHaveTextContent("Agente de IA");
    const pedido = linhas.find((l) => l.textContent?.includes("Pedido da loja"))!;
    expect(within(pedido).queryByRole("link")).toBeNull();
  });

  it("avisa quando a lista foi cortada nas vendas mais recentes", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { ...respostaCompleta().data, vendas_cortadas: true } });
    montar();
    expect(await screen.findByText("Mostrando as 200 vendas mais recentes do período.")).toBeInTheDocument();
  });

  it("celular: nada na tela impõe largura fixa que empurre a página (a lista não é <table>, os blocos têm min-w-0)", async () => {
    montar();
    const raiz = await screen.findByTestId("faturamento");
    expect(raiz.className).toContain("min-w-0");
    expect(raiz.querySelector("table")).toBeNull();
    expect(raiz.innerHTML).not.toMatch(/overflow-x-(auto|scroll)/);
  });
});

describe("FaturamentoClient — organização com produto interno", () => {
  it("diz que o total conta só negócios ganhos e mostra os pedidos da loja à parte, 'fora do total'", async () => {
    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.get).mockResolvedValue({ data: { ...respostaCompleta().data, somente_negocios: true, fora_do_total: { pedidos_cents: 7000, pedidos: 2 } } });
    montar();
    const nota = await screen.findByTestId("fora-do-total");
    expect(nota).toHaveTextContent("Fora do total");
    expect(nota).toHaveTextContent("Pedidos da loja 2");
    expect(nota).toHaveTextContent(/R\$\s*70,00/);
    expect(nota).toHaveTextContent("O total conta só os negócios ganhos.");
    // o cartão de faturamento não soma pedido
    expect(screen.queryByText(/Pedidos da loja R\$/)).toBeNull();
  });

  it("sem produto interno não há nota nenhuma", async () => {
    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.get).mockResolvedValue(respostaCompleta());
    montar();
    await screen.findByTestId("grafico-faturamento");
    expect(screen.queryByTestId("fora-do-total")).toBeNull();
  });
});

describe("FaturamentoClient — período sem vendas", () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { ...respostaDia().data, total_cents: 0, receita_negocios_cents: 0, numero_de_vendas: 0, ticket_medio_cents: null, serie: [{ chave: "2026-11-07", total_cents: 0, vendas: 0 }] },
    });
  });

  it("mostra o estado vazio com o botão que leva a Leads, sem gráfico nem tabelas", async () => {
    montar();
    const vazio = await screen.findByTestId("faturamento-vazio");
    expect(vazio).toHaveTextContent("Nenhuma venda neste período.");
    expect(within(vazio).getByRole("link", { name: "Ir para Leads" })).toHaveAttribute("href", "/app/leads");
    expect(screen.queryByTestId("grafico-faturamento")).toBeNull();
    expect(screen.queryByTestId("tabela-de-vendas")).toBeNull();
  });

  it("os cartões continuam aí, zerados", async () => {
    montar();
    await screen.findByTestId("faturamento-vazio");
    expect(screen.getAllByText(/R\$\s*0,00/).length).toBeGreaterThan(0);
  });
});
