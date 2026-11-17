/**
 * O POST de envio de mensagem não se repete sozinho por tempo esgotado.
 *
 * Caso de 06/11: o cliente HTTP desistia em 10 s e mandava o POST de novo (200 ms e 400 ms depois) enquanto o
 * primeiro ainda esperava um chip lento. A rota agora honra a `Idempotency-Key`, então a repetição não envia — mas
 * também não serve para nada: ela só recebe "em andamento". O desenho é o primeiro pedido esperar o desfecho real,
 * com um limite acima do pior caso do canal (120 s de mídia), e nenhuma nova tentativa por rede/tempo.
 *
 * Também fixa os avisos do hook: o que é incerto não é tratado como falha, e a duplicata tem saída ("Enviar de novo").
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const post = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
const showApiError = vi.fn();
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: (e: unknown) => showApiError(e) }));
const toast = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { TEMPO_LIMITE_DO_ENVIO_MS, useSendMessage } from "@/hooks/inbox/useSendMessage";

function montar() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useSendMessage(), { wrapper });
}
const args = { conversation_id: "22222222-2222-4222-8222-222222222222", body: "Oi", type: "text" };

beforeEach(() => {
  post.mockReset();
  showApiError.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});

describe("useSendMessage", () => {
  it("o POST não repete por rede/tempo e espera mais que o pior caso do canal", async () => {
    post.mockResolvedValue({ data: { id: "m1", status: "sent", metadata: {} } });
    const { result } = montar();
    await act(async () => {
      await result.current.mutateAsync(args);
    });
    expect(post).toHaveBeenCalledWith("/api/v1/messages", args, expect.objectContaining({ retryOnNetworkError: false, timeoutMs: TEMPO_LIMITE_DO_ENVIO_MS }));
    expect(TEMPO_LIMITE_DO_ENVIO_MS).toBeGreaterThan(120_000);
  });

  it("tempo esgotado no canal (201 com failed incerto): avisa que pode ter sido entregue", async () => {
    post.mockResolvedValue({ data: { id: "m1", status: "failed", metadata: { resultado_incerto: true } } });
    const { result } = montar();
    await act(async () => {
      await result.current.mutateAsync(args);
    });
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/pode ter sido entregue/), expect.anything());
  });

  it("sem resposta do servidor: aviso de incerto, não o erro genérico, com 'Enviar de novo' que passa pela trava", async () => {
    post.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const { result } = montar();
    act(() => result.current.mutate(args));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(showApiError).not.toHaveBeenCalled();
    const [texto, opcoes] = toast.warning.mock.calls[0]!;
    expect(texto).toMatch(/pode ter saído/);
    post.mockResolvedValue({ data: { id: "m2", status: "sent", metadata: {} } });
    act(() => opcoes.action.onClick());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]![1]).not.toHaveProperty("allow_duplicate");
  });

  it("mensagem talvez enviada (409): pede confirmação; confirmado, manda com allow_duplicate", async () => {
    post.mockRejectedValueOnce(new ApiError(409, "mensagem_talvez_enviada", undefined, "r", "pode ter sido entregue"));
    const { result } = montar();
    act(() => result.current.mutate(args));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(showApiError).not.toHaveBeenCalled();
    post.mockResolvedValue({ data: { id: "m2", status: "sent", metadata: {} } });
    act(() => toast.warning.mock.calls[0]![1].action.onClick());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]![1]).toMatchObject({ ...args, allow_duplicate: true });
  });

  it("duplicata (409) também tem saída: 'Enviar de novo' confirma", async () => {
    post.mockRejectedValueOnce(new ApiError(409, "mensagem_duplicada", undefined, "r", "já enviada"));
    const { result } = montar();
    act(() => result.current.mutate(args));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.warning.mock.calls[0]![1].action.label).toBe("Enviar de novo");
  });

  it("envio em andamento (409): informa e não oferece reenviar", async () => {
    post.mockRejectedValueOnce(new ApiError(409, "envio_em_andamento", undefined, "r", "ainda sendo enviada"));
    const { result } = montar();
    act(() => result.current.mutate(args));
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(showApiError).not.toHaveBeenCalled();
  });

  it("falha certa continua no aviso de erro de sempre", async () => {
    post.mockRejectedValueOnce(new ApiError(422, "validation_error", undefined, "r", "x"));
    const { result } = montar();
    act(() => result.current.mutate(args));
    await waitFor(() => expect(showApiError).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
