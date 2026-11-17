import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Composer + barra de atalhos (mensagens prontas): digitar uma palavra mostra os cartões; um clique agenda o
 * funil ou a mensagem; o texto do comando nunca vai ao lead; Enter na caixa continua sendo "enviar o texto".
 */
const sendMock = vi.fn();
const noteMock = vi.fn();
const sequenciaMock = vi.fn();

vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: sendMock, isPending: false }) }));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: noteMock, isPending: false }) }));
vi.mock("@/hooks/inbox/useSequenciaComando", () => ({
  useSequenciaComando: () => ({ mutate: sequenciaMock, isPending: false }),
  useAndamentoDoFunil: () => ({ data: undefined }),
  cancelarFunilDaConversa: vi.fn(),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({ useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({
    data: [
      { id: "t1", title: "Valores: abertura", body: "Vou te explicar", shortcut: "/valores-1", owner_user_id: null },
      { id: "t2", title: "Kit 3 meses", body: "3 meses", shortcut: "/kit3", owner_user_id: null },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/inbox/useFunis", () => ({
  useFunis: () => ({
    data: [{ id: "f1", nome: "Funil de valores", atalho: "funil-valores", palavras_chave: ["valores"], favorito: false, compartilhado: true, passos: [{}, {}], duracao_ms: 3000 }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({ useDraftReply: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import { Composer } from "@/components/inbox/Composer";

const renderComposer = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" {...props} />
    </QueryClientProvider>,
  );

const campo = () => screen.getByLabelText(/mensagem/i);
const digitar = (texto: string) => {
  fireEvent.change(campo(), { target: { value: texto } });
  act(() => void vi.advanceTimersByTime(400));
};

describe("Composer + barra de atalhos", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMock.mockReset();
    noteMock.mockReset();
    sequenciaMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("digitar 'valores' mostra o funil e a mensagem com essa palavra, não as outras", () => {
    renderComposer();
    digitar("valores");
    expect(screen.getByRole("button", { name: /Funil de valores/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Valores: abertura/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Kit 3 meses/ })).not.toBeInTheDocument();
  });

  it("clicar no funil AGENDA (uma chamada com o id do funil), não envia texto e limpa o campo", () => {
    renderComposer();
    digitar("valores");
    fireEvent.click(screen.getByRole("button", { name: /Funil de valores/ }));
    expect(sequenciaMock).toHaveBeenCalledTimes(1);
    expect(sequenciaMock).toHaveBeenCalledWith({ conversation_id: "conv-1", funnel_id: "f1" }, expect.anything());
    expect(sendMock).not.toHaveBeenCalled();
    expect(campo()).toHaveValue("");
  });

  it("clicar numa mensagem agenda a mensagem avulsa (template_id)", () => {
    renderComposer();
    digitar("kit");
    fireEvent.click(screen.getByRole("button", { name: /Kit 3 meses/ }));
    expect(sequenciaMock).toHaveBeenCalledWith({ conversation_id: "conv-1", template_id: "t2" }, expect.anything());
  });

  it("conversa fora de chip do motor: a mensagem avulsa cai no envio comum (texto na caixa)", async () => {
    const { ApiError } = await import("@/lib/api/types");
    sequenciaMock.mockImplementation((_a: unknown, opts: { onError: (e: unknown) => void }) =>
      opts.onError(new ApiError(409, "sequencia_chip", { sem_chip_do_motor: true }, "req-1", "sem chip")),
    );
    renderComposer();
    digitar("kit");
    fireEvent.click(screen.getByRole("button", { name: /Kit 3 meses/ }));
    act(() => void vi.advanceTimersByTime(50));
    expect(campo()).toHaveValue("3 meses");
  });

  it("comando /funil-valores digitado inteiro e enviado: vai para o funil, nunca como mensagem", () => {
    renderComposer();
    digitar("/funil-valores");
    fireEvent.keyDown(campo(), { key: "Enter" });
    expect(sequenciaMock).toHaveBeenCalledWith({ conversation_id: "conv-1", funnel_id: "f1" }, expect.anything());
    expect(sendMock).not.toHaveBeenCalled();
    expect(campo()).toHaveValue("");
  });

  it("falha do agendamento devolve o texto digitado ao campo", () => {
    sequenciaMock.mockImplementation((_a: unknown, opts: { onError: (e: unknown) => void }) => opts.onError(new Error("x")));
    renderComposer();
    digitar("/funil-valores");
    fireEvent.keyDown(campo(), { key: "Enter" });
    act(() => void vi.advanceTimersByTime(50));
    expect(campo()).toHaveValue("/funil-valores");
  });

  it("frase com a palavra + Enter envia a frase (a barra nunca escolhe sozinha)", () => {
    renderComposer();
    digitar("valores ok, me manda");
    fireEvent.keyDown(campo(), { key: "Enter" });
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ body: "valores ok, me manda" }), expect.anything());
    expect(sequenciaMock).not.toHaveBeenCalled();
  });

  it("Esc fecha a barra", () => {
    renderComposer();
    digitar("valores");
    fireEvent.keyDown(campo(), { key: "Escape" });
    expect(screen.queryByRole("button", { name: /Funil de valores/ })).not.toBeInTheDocument();
  });

  it("em nota interna `/funil-valores` é só o texto da nota (e a barra não aparece)", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    fireEvent.change(screen.getByPlaceholderText(/nota interna/i), { target: { value: "/funil-valores" } });
    act(() => void vi.advanceTimersByTime(400));
    expect(screen.queryByRole("button", { name: /Funil de valores/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(noteMock).toHaveBeenCalledWith(expect.objectContaining({ body: "/funil-valores" }), expect.anything());
    expect(sequenciaMock).not.toHaveBeenCalled();
  });

  it("janela fechada (resposta barrada): nada agenda", () => {
    renderComposer({ janelaFechada: "Janela de 24h fechada" });
    digitar("/funil-valores");
    expect(campo()).toBeDisabled();
    expect(sequenciaMock).not.toHaveBeenCalled();
  });
});
