import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdatePanel } from "./UpdatePanel";

let dados: Record<string, unknown>;
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/system/useSystemVersion", () => ({
  useSystemVersion: () => ({ data: dados, isError: false }),
}));

afterEach(() => cleanup());

function montar() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <UpdatePanel />
    </QueryClientProvider>,
  );
}

// A instalação nova mostrava "Versão instalada: ." (versão vazia).
describe("tela de Atualização sem o agente do host", () => {
  it("mostra a versão instalada que a rota entrega", () => {
    dados = { current_version: "v1.0.0", is_owner: true, latest_version: "", agent_online: false, run: null };
    montar();
    expect(screen.getByText(/Versão instalada:/).textContent).toBe("Versão instalada: 1.0.0.");
  });

  it("nunca imprime a frase com a versão vazia", () => {
    dados = { current_version: "", is_owner: true, latest_version: "", agent_online: false, run: null };
    montar();
    expect(screen.getByText("Atualização automática indisponível")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Versão instalada:\s*\./);
  });
});
