import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotaoExportarCsv, urlDeExportacao } from "./BotaoExportarCsv";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(cleanup);

describe("urlDeExportacao", () => {
  it("leva só os filtros preenchidos", () => {
    expect(urlDeExportacao("contacts", { search: "ana", tag: "", source: undefined }, "virgula")).toBe(
      "/api/v1/contacts/export?search=ana",
    );
  });

  it("sem filtro, é o endereço limpo", () => {
    expect(urlDeExportacao("leads", {}, "virgula")).toBe("/api/v1/leads/export");
  });

  it("ponto e vírgula vai como separador; a vírgula é o padrão e não vai na URL", () => {
    expect(urlDeExportacao("leads", { busca: "a&b", pipeline: "f1" }, "ponto-e-virgula")).toBe(
      "/api/v1/leads/export?busca=a%26b&pipeline=f1&separador=ponto-e-virgula",
    );
  });
});

function abrirMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Exportar CSV" }), { key: "Enter" });
}

describe("BotaoExportarCsv", () => {
  const criarUrl = vi.fn(() => "blob:csv");
  const revogarUrl = vi.fn();
  let cliques: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    cliques = [];
    Object.assign(URL, { createObjectURL: criarUrl, revokeObjectURL: revogarUrl });
    // O clique no link temporário de download: guarda o nome do arquivo em vez de navegar.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      cliques.push(this.download);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mostra o botão Exportar CSV e, aberto, as duas opções de separador", () => {
    render(<BotaoExportarCsv rota="leads" filtros={{ busca: "ana" }} />);
    abrirMenu();
    expect(screen.getByRole("menuitem", { name: "Separado por vírgula" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /ponto e vírgula/ })).toBeTruthy();
  });

  it("pede a rota com os filtros ativos e, com 200, baixa o arquivo com o nome do cabeçalho", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("a,b\r\n", {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="leads-2026-11-13.csv"' },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<BotaoExportarCsv rota="leads" filtros={{ busca: "ana", tag: "vip", pipeline: "" }} />);
    abrirMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /ponto e vírgula/ }));
    });
    await waitFor(() => expect(cliques).toEqual(["leads-2026-11-13.csv"]));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/leads/export?busca=ana&tag=vip&separador=ponto-e-virgula");
    expect(toast.error).not.toHaveBeenCalled();
    // M2: o endereço do blob NÃO é revogado no mesmo instante do clique (o navegador ainda pode estar lendo): só um pouco depois.
    expect(revogarUrl).not.toHaveBeenCalled();
    await waitFor(() => expect(revogarUrl).toHaveBeenCalledWith("blob:csv"), { timeout: 3000 });
  });

  it.each([
    [403, "forbidden", "Sem permissão."],
    [429, "rate_limited", "Muitas exportações seguidas. Tente de novo em um minuto."],
    [500, "internal_error", "Não foi possível exportar."],
  ])("status %i vira aviso na tela e NÃO baixa o JSON de erro como arquivo", async (status, code, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "Content-Type": "application/json" } })),
    );
    render(<BotaoExportarCsv rota="contacts" filtros={{}} />);
    abrirMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Separado por vírgula" }));
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(criarUrl).not.toHaveBeenCalled();
    expect(cliques).toEqual([]);
  });

  it("resposta de erro sem JSON legível usa a mensagem padrão; falha de rede também", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    const { unmount } = render(<BotaoExportarCsv rota="contacts" filtros={{}} />);
    abrirMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Separado por vírgula" }));
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível exportar."));
    unmount();

    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    render(<BotaoExportarCsv rota="contacts" filtros={{}} />);
    abrirMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Separado por vírgula" }));
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível exportar."));
    expect(cliques).toEqual([]);
  });
});
