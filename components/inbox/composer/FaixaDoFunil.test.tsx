import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelarFunilDaConversa, useAndamentoDoFunil } from "@/hooks/inbox/useSequenciaComando";

vi.mock("@/hooks/inbox/useSequenciaComando", () => ({ useAndamentoDoFunil: vi.fn(), cancelarFunilDaConversa: vi.fn(async () => undefined) }));

import { FaixaDoFunil } from "@/components/inbox/composer/FaixaDoFunil";

const funis = [{ id: "f1", nome: "Funil de valores", atalho: "funil-valores", palavras_chave: [], favorito: false, compartilhado: true, passos: [], duracao_ms: 0 }];

beforeEach(() => vi.clearAllMocks());

describe("FaixaDoFunil — o funil em andamento na conversa", () => {
  it("mostra o nome do funil, quantas saíram e o botão de cancelar", () => {
    vi.mocked(useAndamentoDoFunil).mockReturnValue({ data: { em_andamento: true, tipo: "funil_valores", enviadas: 2, total: 7, proxima_em: "2026-11-06T17:32:00Z" } } as never);
    render(<FaixaDoFunil conversationId="c1" funis={funis} />);
    expect(screen.getByText(/Funil de valores/)).toBeTruthy();
    expect(screen.getByText(/2 de 7/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(cancelarFunilDaConversa).toHaveBeenCalledWith("c1");
  });

  it("sem funil andando, não mostra nada", () => {
    vi.mocked(useAndamentoDoFunil).mockReturnValue({ data: { em_andamento: false, tipo: null, enviadas: 0, total: 0, proxima_em: null } } as never);
    const { container } = render(<FaixaDoFunil conversationId="c1" funis={funis} />);
    expect(container.textContent).toBe("");
  });
});
