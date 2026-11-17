import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabelaLeads } from "./tabela-leads";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/components/negocio/BotaoRegistrarVenda", () => ({ BotaoRegistrarVenda: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/app/leads",
  useSearchParams: () => new URLSearchParams("busca=ana&tag=vip&de=2026-03-01&ate=2026-03-31&cursor=eyJhIjoxfQ&anteriores=_"),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("tabela de Leads: visão salva", () => {
  it("guarda os filtros, mas não a posição da paginação (cursor e pilha de anteriores)", () => {
    render(
      <TabelaLeads
        org="org-1"
        resultado={{ linhas: [], total: 0 }}
        paginacao={{ tipo: "cursor", atual: "eyJhIjoxfQ", anteriores: ["_"], proximo: null }}
        pipelines={[]}
        tags={[]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Nome da visão"), { target: { value: "VIPs" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar visão" }));
    const salvas = JSON.parse(localStorage.getItem("leads-visoes:org-1") ?? "[]") as { nome: string; consulta: string }[];
    expect(salvas).toHaveLength(1);
    const consulta = new URLSearchParams(salvas[0]!.consulta);
    expect(consulta.get("busca")).toBe("ana");
    expect(consulta.get("tag")).toBe("vip");
    expect(consulta.has("cursor")).toBe(false);
    expect(consulta.has("anteriores")).toBe(false);
  });
});

describe("tabela de Leads: Exportar CSV", () => {
  const props: ComponentProps<typeof TabelaLeads> = {
    org: "org-1",
    resultado: { linhas: [], total: 0 },
    paginacao: { tipo: "cursor", atual: "", anteriores: [], proximo: null },
    pipelines: [],
    tags: [],
  };

  it("gerente vê o botão, e o pedido leva busca, tag e o intervalo de/ate ativos (sem o cursor da paginação)", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TabelaLeads {...props} podeExportar />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Exportar CSV" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Separado por vírgula" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/leads/export?busca=ana&tag=vip&de=2026-03-01&ate=2026-03-31");
    vi.unstubAllGlobals();
  });

  it("quem não é gerente não vê o botão", () => {
    render(<TabelaLeads {...props} />);
    expect(screen.queryByRole("button", { name: "Exportar CSV" })).toBeNull();
  });
});

/**
 * Em 375 px a página tinha 391 px de rolagem horizontal, com a tabela já dentro de um
 * `overflow-x-auto`. Quem vazava era o `sr-only` do cabeçalho "Ações": ele é `position: absolute`, e sem
 * ancestral posicionado o bloco de contenção dele é a página inteira, fora da caixa que rola. Ele ficava
 * na posição da última coluna (~766 px) e alargava o documento. A caixa da tabela passa a ser o bloco de
 * contenção (`relative`), e a rolagem fica só dentro dela. (jsdom não faz layout: a medida real é a da
 * jornada pela tela; aqui se tranca a causa.)
 */
describe("tabela de Leads: nada vaza da caixa que rola (N5)", () => {
  it("todo elemento posicionado da tabela tem a caixa com rolagem como bloco de contenção", () => {
    const { container } = render(
      <TabelaLeads
        org="org-1"
        resultado={{ linhas: [{ id: "c1", tipo: "pessoa", nome: "Ana", telefone: "+5511900000001", tags: ["vip"], total: 100, compras: 1, ciclo: null, ultima: null }] as never, total: 1 }}
        paginacao={{ tipo: "cursor", atual: "", anteriores: [], proximo: null }}
        pipelines={[]}
        tags={[]}
      />,
    );
    const caixa = container.querySelector("table")!.parentElement!;
    expect(caixa.className).toContain("overflow-x-auto");
    expect(caixa.className.split(/\s+/)).toContain("relative");
    expect(caixa.className.split(/\s+/)).toContain("max-w-full");
    expect(caixa.querySelectorAll(".sr-only").length).toBeGreaterThan(0);
  });
});
