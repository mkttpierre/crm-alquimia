/**
 * O texto só volta à caixa quando é SEGURO: falha certa (nada saiu). Quando o desfecho é incerto ou a mensagem já
 * saiu, devolver o texto convida a clicar de novo — foi assim que a mesma frase saiu três vezes em 06/11. Nesses
 * casos quem fala com o operador é o aviso do envio (`useSendMessage`), que oferece a saída explícita.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const sendMock = vi.fn();
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({ useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({ useMessageTemplates: () => ({ data: [], isLoading: false }) }));
vi.mock("@/hooks/inbox/useDraftReply", () => ({ useDraftReply: () => ({ mutate: vi.fn(), isPending: false }) }));

import { Composer } from "@/components/inbox/Composer";

function enviarComErro(err: unknown) {
  sendMock.mockImplementation((_args: unknown, opts?: { onError?: (e: unknown) => void }) => opts?.onError?.(err));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
  const caixa = screen.getByLabelText(/mensagem/i);
  fireEvent.change(caixa, { target: { value: "Oi, Maria! Já te mando o valor." } });
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
  });
  return caixa;
}

beforeEach(() => sendMock.mockReset());
afterEach(() => cleanup());

describe("Composer: quando o texto volta à caixa", () => {
  it("falha certa (o servidor recusou): o texto volta", async () => {
    const caixa = enviarComErro(new ApiError(422, "validation_error", undefined, "r", "x"));
    await new Promise((r) => requestAnimationFrame(r));
    expect(caixa).toHaveValue("Oi, Maria! Já te mando o valor.");
  });

  it("sem resposta do servidor (tempo esgotado): o texto NÃO volta", async () => {
    const caixa = enviarComErro(new DOMException("aborted", "AbortError"));
    await new Promise((r) => requestAnimationFrame(r));
    expect(caixa).toHaveValue("");
  });

  it("proxy que desistiu (504): o texto NÃO volta", async () => {
    const caixa = enviarComErro(new ApiError(504, "internal_error", undefined, "r", "x"));
    await new Promise((r) => requestAnimationFrame(r));
    expect(caixa).toHaveValue("");
  });

  it.each(["mensagem_duplicada", "mensagem_talvez_enviada", "envio_em_andamento"])("%s: o texto NÃO volta", async (code) => {
    const caixa = enviarComErro(new ApiError(409, code, undefined, "r", "x"));
    await new Promise((r) => requestAnimationFrame(r));
    expect(caixa).toHaveValue("");
  });
});
