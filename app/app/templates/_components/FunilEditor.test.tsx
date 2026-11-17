import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const salvar = vi.fn(async (_funil: unknown) => ({ data: {} }));
vi.mock("@/hooks/inbox/useFunis", () => ({ useSalvarFunil: () => ({ mutateAsync: salvar, isPending: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { FunilEditor } from "./FunilEditor";

const modelos = [
  { id: "11111111-1111-4111-8111-111111111111", title: "Abertura", body: "Oi", shortcut: null, owner_user_id: null },
  { id: "22222222-2222-4222-8222-222222222222", title: "Tabela", body: "", shortcut: null, owner_user_id: null },
  { id: "33333333-3333-4333-8333-333333333333", title: "Áudio preço", body: "", shortcut: null, owner_user_id: null },
];

beforeEach(() => salvar.mockClear());

function montarComTresPassos() {
  const onSalvo = vi.fn();
  render(<FunilEditor modelos={modelos} canShare onSalvo={onSalvo} />);
  fireEvent.change(screen.getByLabelText("Nome do funil"), { target: { value: "Funil de valores" } });
  for (const [i, m] of modelos.entries()) {
    fireEvent.click(screen.getByRole("button", { name: /Adicionar mensagem/ }));
    fireEvent.change(screen.getByLabelText(`Mensagem do passo ${i + 1}`), { target: { value: m.id } });
  }
  fireEvent.change(screen.getByLabelText("Espera antes do passo 2 (segundos)"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("Espera antes do passo 3 (segundos)"), { target: { value: "31" } });
  return { onSalvo };
}

describe("FunilEditor — montar um funil de mensagens programadas", () => {
  it("o atalho sai do nome e o total soma as esperas", () => {
    montarComTresPassos();
    expect(screen.getByLabelText("Atalho")).toHaveValue("funil-de-valores");
    expect(screen.getByText(/Total: 34 s/)).toBeTruthy();
  });

  it("salvar manda os passos na ordem, com espera em milissegundos", async () => {
    const { onSalvo } = montarComTresPassos();
    fireEvent.click(screen.getByRole("button", { name: /Salvar funil/ }));
    await vi.waitFor(() => expect(salvar).toHaveBeenCalled());
    const enviado = salvar.mock.calls[0]![0] as { atalho: string; passos: { template_id: string; atraso_ms: number }[] };
    expect(enviado.atalho).toBe("funil-de-valores");
    expect(enviado.passos.map((p) => [p.template_id, p.atraso_ms])).toEqual([
      [modelos[0]!.id, 0],
      [modelos[1]!.id, 3000],
      [modelos[2]!.id, 31000],
    ]);
    await vi.waitFor(() => expect(onSalvo).toHaveBeenCalled());
  });

  it("presença acima de 25 s mostra o erro e não salva", () => {
    montarComTresPassos();
    fireEvent.change(screen.getByLabelText("Presença do passo 3"), { target: { value: "gravando" } });
    fireEvent.change(screen.getByLabelText("Duração da presença do passo 3 (segundos)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar funil/ }));
    expect(screen.getByText(/máximo 25 s/)).toBeTruthy();
    expect(salvar).not.toHaveBeenCalled();
  });

  it("subir o passo 3 para o topo muda a ordem enviada", async () => {
    montarComTresPassos();
    fireEvent.click(screen.getByRole("button", { name: "Subir passo 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Subir passo 2" }));
    fireEvent.click(screen.getByRole("button", { name: /Salvar funil/ }));
    await vi.waitFor(() => expect(salvar).toHaveBeenCalled());
    const enviado = salvar.mock.calls[0]![0] as { passos: { template_id: string }[] };
    expect(enviado.passos[0]!.template_id).toBe(modelos[2]!.id);
  });
});
