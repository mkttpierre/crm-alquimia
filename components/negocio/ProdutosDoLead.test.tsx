import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProdutosDoLead } from "./ProdutosDoLead";

const criar = vi.fn();
const apagar = vi.fn();
const aoMudar = vi.fn();

const ITEM = { id: "i1", nome: "5 MESES (OURO)", sku: "ouro", total_cents: 24574, currency: "BRL" };
let itens: Array<typeof ITEM> = [ITEM];

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/negocio/useItensDoNegocio", () => ({
  useItensDoNegocio: () => ({
    isLoading: false,
    isError: false,
    data: { itens, currency: "BRL", total_cents: itens.reduce((a, i) => a + i.total_cents, 0) },
  }),
  useCatalogoParaNegocio: () => ({
    isLoading: false,
    data: [
      { id: "p5", codigo: "ouro5", nome: "5 MESES (OURO)", preco_cents: 24574, moeda: "BRL", ativo: true, marca: null, so_interno: false },
      { id: "p7", codigo: "ouro7", nome: "7 MESES (OURO)", preco_cents: 30000, moeda: "BRL", ativo: true, marca: null, so_interno: false },
    ],
  }),
  useMutacoesDeItens: () => ({
    criar: { mutate: criar, isPending: false },
    apagar: { mutate: apagar, isPending: false },
  }),
}));

describe("ProdutosDoLead", () => {
  beforeEach(() => {
    criar.mockReset();
    apagar.mockReset();
    aoMudar.mockReset();
    itens = [ITEM];
  });

  it("mostra o produto e o faturado total do lead", () => {
    render(<ProdutosDoLead leadId="l1" podeEditar aoMudar={aoMudar} />);
    expect(screen.getByText("5 MESES (OURO)")).toBeTruthy();
    expect(screen.getByTestId("faturado-do-lead").textContent).toMatch(/245,74/);
  });

  it("escolher o produto o adiciona na hora, quantidade 1, sem pedir mais nada", () => {
    render(<ProdutosDoLead leadId="l1" podeEditar aoMudar={aoMudar} />);
    fireEvent.click(screen.getByText(/Adicionar produto/));
    fireEvent.change(screen.getByLabelText("Produto do catálogo"), { target: { value: "p7" } });
    expect(criar).toHaveBeenCalledTimes(1);
    expect(criar.mock.calls[0]![0]).toEqual({ product_id: "p7", quantidade: 1, desconto_cents: 0, acrescimo_cents: 0 });
  });

  it("o X remove o produto", () => {
    render(<ProdutosDoLead leadId="l1" podeEditar aoMudar={aoMudar} />);
    fireEvent.click(screen.getByLabelText("Remover 5 MESES (OURO)"));
    expect(apagar.mock.calls[0]![0]).toBe("i1");
  });

  it("sem permissão de edição não mostra adicionar nem remover", () => {
    render(<ProdutosDoLead leadId="l1" podeEditar={false} />);
    expect(screen.queryByText(/Adicionar produto/)).toBeNull();
    expect(screen.queryByLabelText("Remover 5 MESES (OURO)")).toBeNull();
  });

  it("lead sem produto mostra aviso e total zero", () => {
    itens = [];
    render(<ProdutosDoLead leadId="l1" podeEditar />);
    expect(screen.getByText("Nenhum produto neste negócio ainda.")).toBeTruthy();
    expect(screen.getByTestId("faturado-do-lead").textContent).toMatch(/0,00/);
  });
});
