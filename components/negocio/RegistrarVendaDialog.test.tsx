import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

import { RegistrarVendaDialog } from "./RegistrarVendaDialog";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));

import { toast } from "sonner";

const CONTATO = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";

const produto = (id: string, nome: string, preco: number, extra: Record<string, unknown> = {}) => ({
  id, codigo: id, nome, preco_cents: preco, moeda: "BRL", ativo: true, marca: "Marca Beta", so_interno: true, ...extra,
});
const CATALOGO = [
  produto("a0000000-0000-4000-8000-000000000001", "1 MÊS (BETA)", 12000),
  produto("a0000000-0000-4000-8000-000000000003", "3 MESES (BETA)", 18200),
  produto("a0000000-0000-4000-8000-0000000000ee", "Plano em dólar", 9900, { moeda: "USD" }),
  produto("a0000000-0000-4000-8000-0000000000aa", "Perfume da loja", 5000, { so_interno: false, marca: "Loja" }),
];

const ALVO_NOVO = { negocio: null, moeda: "BRL", itens: [], ja_no_negocio_cents: 0, timezone: "America/Sao_Paulo", hoje: "2026-11-07" };
const ALVO_COM_NEGOCIO = {
  negocio: { id: LEAD, titulo: "Negócio de Exemplo" },
  moeda: "BRL",
  itens: [{ id: "i1", nome: "1 MÊS (BETA) já lançado", quantidade: 1, preco_unit_cents: 12000, desconto_cents: 0, acrescimo_cents: 0, total_cents: 12000, currency: "BRL" }],
  ja_no_negocio_cents: 12000,
  timezone: "America/Sao_Paulo",
  hoje: "2026-11-07",
};

function servir(alvo: unknown) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/sales/alvo")) return { data: alvo };
    if (url.startsWith("/api/v1/products")) return { data: CATALOGO };
    throw new Error(`GET inesperado ${url}`);
  });
}

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RegistrarVendaDialog open onOpenChange={vi.fn()} contactId={CONTATO} nomeDoContato="Fulano" />
    </QueryClientProvider>,
  );
}

const escolher = async (nome: string) => fireEvent.click(await screen.findByRole("button", { name: new RegExp(nome) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.post).mockReset();
});

describe("Registrar venda — o negócio que será usado (incremental)", () => {
  it("consulta o alvo pelo contato, e mostra os itens que JÁ estão no negócio, somente leitura", async () => {
    servir(ALVO_COM_NEGOCIO);
    montar();
    const jaNoNegocio = await screen.findByTestId("ja-no-negocio");
    expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith(`/api/v1/sales/alvo?contact_id=${CONTATO}`);
    expect(within(jaNoNegocio).getByText("1 MÊS (BETA) já lançado")).toBeInTheDocument();
    // somente leitura: nenhum campo editável nem botão de remover dentro do bloco
    expect(within(jaNoNegocio).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(jaNoNegocio).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("Negócio de Exemplo")).toBeInTheDocument();
  });

  it("mostra 'já no negócio', 'esta venda' e 'total final' e o total final é a SOMA dos dois", async () => {
    servir(ALVO_COM_NEGOCIO);
    montar();
    await escolher("3 MESES");
    expect(screen.getByTestId("total-ja-no-negocio")).toHaveTextContent(/R\$\s*120,00/);
    expect(screen.getByTestId("total-desta-venda")).toHaveTextContent(/R\$\s*182,00/);
    expect(screen.getByTestId("total-final")).toHaveTextContent(/R\$\s*302,00/);
    // editar o valor da linha mexe só em "esta venda" e no total final
    const preco = screen.getAllByPlaceholderText("0,00")[0]!;
    fireEvent.change(preco, { target: { value: "100,00" } });
    expect(screen.getByTestId("total-desta-venda")).toHaveTextContent(/R\$\s*100,00/);
    expect(screen.getByTestId("total-ja-no-negocio")).toHaveTextContent(/R\$\s*120,00/);
    expect(screen.getByTestId("total-final")).toHaveTextContent(/R\$\s*220,00/);
  });

  it("sem negócio aberto: avisa que a venda abrirá um negócio novo, sem bloco 'já no negócio', e o total final é só a venda", async () => {
    servir(ALVO_NOVO);
    montar();
    await escolher("1 MÊS");
    expect(screen.queryByTestId("ja-no-negocio")).toBeNull();
    expect(screen.getByText("A venda abrirá um negócio novo para este contato.")).toBeInTheDocument();
    expect(screen.getByTestId("total-final")).toHaveTextContent(/R\$\s*120,00/);
  });

  it("não deixa confirmar enquanto não sabe qual negócio será usado", async () => {
    vi.mocked(apiClient.get).mockImplementation((url: string) =>
      url.startsWith("/api/v1/sales/alvo") ? new Promise(() => undefined) : Promise.resolve({ data: CATALOGO }),
    );
    montar();
    await escolher("1 MÊS").catch(() => undefined);
    expect(screen.getByRole("button", { name: "Confirmar venda" })).toBeDisabled();
  });
});

describe("Registrar venda — moeda", () => {
  it("o seletor mostra só produtos na moeda do negócio usado (o em dólar some)", async () => {
    servir(ALVO_COM_NEGOCIO);
    montar();
    await screen.findByRole("button", { name: /1 MÊS \((BETA)\)/ });
    expect(screen.queryByRole("button", { name: /Plano em dólar/ })).toBeNull();
  });

  it("negócio novo: vale a moeda da ORGANIZAÇÃO, não a do primeiro produto da lista", async () => {
    servir({ ...ALVO_NOVO, moeda: "USD" });
    montar();
    await screen.findByRole("button", { name: /Plano em dólar/ });
    expect(screen.queryByRole("button", { name: /1 MÊS \((BETA)\)/ })).toBeNull();
    await escolher("Plano em dólar");
    expect(screen.getByTestId("total-final")).toHaveTextContent(/\$\s*99[.,]00/);
  });
});

describe("Registrar venda — data no fuso da organização", () => {
  it("o padrão e o limite do campo são o 'hoje' da organização (não o do navegador)", async () => {
    servir(ALVO_NOVO); // hoje na organização: 2026-11-07
    montar();
    await screen.findByTestId("total-final");
    const data = (await screen.findByLabelText("Data da venda")) as HTMLInputElement;
    await waitFor(() => expect(data.value).toBe("2026-11-07"));
    expect(data.max).toBe("2026-11-07");
  });
});

describe("Registrar venda — confirmar", () => {
  beforeEach(() => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { lead_id: LEAD, contact_id: CONTATO, pipeline_id: "p", criado: false, ja_registrada: false, total_cents: 30200, currency: "BRL", closed_at: "2026-11-07T15:00:00Z", title: "x" } });
  });

  it("manda a chave de idempotência (UUID) e a data escolhida; a MESMA chave na retentativa do mesmo conteúdo, outra se o conteúdo mudar", async () => {
    servir(ALVO_COM_NEGOCIO);
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ data: { lead_id: LEAD, contact_id: CONTATO, pipeline_id: "p", criado: false, ja_registrada: false, total_cents: 30200, currency: "BRL", closed_at: "x", title: "x" } });
    montar();
    await escolher("3 MESES");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    const chaves = vi.mocked(apiClient.post).mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(chaves[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chaves[1]).toBe(chaves[0]);
    expect(vi.mocked(apiClient.post).mock.calls[0]![0]).toBe("/api/v1/sales");
    expect(vi.mocked(apiClient.post).mock.calls[0]![1]).toMatchObject({ contact_id: CONTATO, data_venda: "2026-11-07" });
  });

  it("conteúdo diferente = chave nova (mudou o valor depois de uma falha: é outra tentativa)", async () => {
    servir(ALVO_NOVO);
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error("falhou")).mockRejectedValueOnce(new Error("falhou"));
    montar();
    await escolher("3 MESES");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getAllByPlaceholderText("0,00")[0]!, { target: { value: "150,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    const [k1, k2] = vi.mocked(apiClient.post).mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(k2).not.toBe(k1);
  });

  it("manda o negócio PREVISTO: o id do que o quadro mostrou, ou \"novo\" quando mostrou que abriria um", async () => {
    servir(ALVO_COM_NEGOCIO);
    const a = montar();
    await escolher("3 MESES");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.post).mock.calls[0]![1]).toMatchObject({ negocio_previsto: LEAD });
    a.unmount();

    vi.mocked(apiClient.post).mockClear();
    servir(ALVO_NOVO);
    montar();
    await escolher("3 MESES");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.post).mock.calls[0]![1]).toMatchObject({ negocio_previsto: "novo" });
  });

  it("o alvo mudou com o quadro aberto (409): recarrega a prévia, avisa, mantém as linhas e NÃO fecha nem comemora", async () => {
    servir(ALVO_COM_NEGOCIO);
    vi.mocked(apiClient.post).mockRejectedValueOnce(new ApiError(409, "state_conflict", { motivo: "alvo_mudou" }, "req-1", "O negócio desta venda mudou"));
    const aoMudar = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RegistrarVendaDialog open onOpenChange={aoMudar} contactId={CONTATO} nomeDoContato="Fulano" />
      </QueryClientProvider>,
    );
    await escolher("3 MESES");
    await screen.findByTestId("total-ja-no-negocio");
    const leituras = () => vi.mocked(apiClient.get).mock.calls.filter((c) => String(c[0]).startsWith("/api/v1/sales/alvo")).length;
    const antes = leituras();
    // enquanto o quadro está aberto, o negócio mostrado foi encerrado: a prévia nova é "negócio novo"
    servir(ALVO_NOVO);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));

    expect(await screen.findByText(/O negócio desta venda mudou/)).toBeInTheDocument();
    await waitFor(() => expect(leituras()).toBeGreaterThan(antes));
    await waitFor(() => expect(screen.queryByTestId("ja-no-negocio")).toBeNull());
    expect(screen.getByText("A venda abrirá um negócio novo para este contato.")).toBeInTheDocument();
    expect(screen.getByTestId("linhas-da-venda")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(aoMudar).not.toHaveBeenCalled();

    // confirmar de novo já leva a previsão NOVA (e uma chave nova: é outra intenção)
    vi.mocked(apiClient.post).mockResolvedValue({ data: { lead_id: LEAD, contact_id: CONTATO, pipeline_id: "p", criado: true, ja_registrada: false, total_cents: 18200, currency: "BRL", closed_at: "x", title: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    const [c1, c2] = vi.mocked(apiClient.post).mock.calls;
    expect(c1![1]).toMatchObject({ negocio_previsto: LEAD });
    expect(c2![1]).toMatchObject({ negocio_previsto: "novo" });
    expect((c2![2] as { idempotencyKey: string }).idempotencyKey).not.toBe((c1![2] as { idempotencyKey: string }).idempotencyKey);
  });

  it("a confirmação mostra o total que ficou GRAVADO no negócio (o da resposta), não o que o quadro calculou", async () => {
    servir(ALVO_COM_NEGOCIO);
    montar();
    await escolher("3 MESES");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venda" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const texto = String(vi.mocked(toast.success).mock.calls[0]![0]);
    expect(texto).toContain("Venda registrada");
    expect(texto).toMatch(/R\$\s*302,00/);
  });
});
