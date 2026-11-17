/**
 * No onboarding, a caixa do QR ficava branca.
 *
 * A tela consulta o status a cada 3 s e, a cada resposta SCAN_QR_CODE, trocava a `key` (e o `src`) da
 * imagem. Cada troca remonta o `<img>` e pede `/api/v1/onboarding/whatsapp/qr` de novo, e o navegador
 * abandona o pedido anterior. Na Evolution esse pedido leva segundos (prepara a instância e chama o
 * `/instance/connect`, com prazo de 10 s): com uma imagem nova a cada 3 s, nenhuma chegava a carregar, e a
 * caixa (fundo branco) ficava vazia. O QR do WhatsApp dura ~20 s; a renovação vai a cada 15 s, como no
 * modal de Conexões.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/app/actions/onboarding/skipWhatsapp", () => ({ skipWhatsapp: vi.fn(), markWhatsappConfigured: vi.fn() }));
vi.mock("@/components/connections/CanalOficialClient", () => ({ CanalOficialClient: () => <div /> }));
vi.mock("@/components/connections/CanalParceiroClient", () => ({ CanalParceiroClient: () => <div /> }));

import { ConnectWhatsappClient } from "@/app/onboarding/connect-whatsapp/_client";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: "SCAN_QR_CODE", session: "org_teste" } }),
    }) as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function passar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("onboarding: o QR não é pedido de novo a cada consulta de status (N4)", () => {
  it("a imagem fica a mesma entre consultas de 3 s e só renova depois de 15 s", async () => {
    render(<ConnectWhatsappClient podeGerarQr sessionName="org_teste" oficialPodeReceber />);
    fireEvent.click(screen.getByTestId("forma-qr").querySelector("input")!);
    await passar(100);
    const img = () => screen.getByAltText(/código qr/i) as HTMLImageElement;
    const primeira = img().getAttribute("src");
    expect(primeira).toMatch(/^\/api\/v1\/onboarding\/whatsapp\/qr/);
    const elemento = img();

    // quatro consultas de status (3, 6, 9, 12 s): mesma imagem, mesmo elemento
    await passar(12_000);
    expect(img().getAttribute("src")).toBe(primeira);
    expect(img()).toBe(elemento);

    // depois de 15 s da primeira, o código é renovado
    await passar(6_000);
    expect(img().getAttribute("src")).not.toBe(primeira);
    // A renovação troca só o `src`; o elemento fica (sem `key`), e o navegador segura o
    // quadro anterior até decodificar o novo, sem a caixa branca de alguns segundos.
    expect(img()).toBe(elemento);
  });

  // Com `onError` a imagem saía do DOM e nada zerava o erro; o QR nunca voltava.
  it("depois de um erro de imagem, a próxima consulta pede um QR novo e a imagem volta", async () => {
    render(<ConnectWhatsappClient podeGerarQr sessionName="org_teste" oficialPodeReceber />);
    fireEvent.click(screen.getByTestId("forma-qr").querySelector("input")!);
    await passar(100);
    const primeira = (screen.getByAltText(/código qr/i) as HTMLImageElement).getAttribute("src");
    fireEvent.error(screen.getByAltText(/código qr/i));
    expect(screen.queryByAltText(/código qr/i)).toBeNull();
    expect(screen.getByText(/não consegui carregar o código/i)).toBeTruthy();

    // a consulta seguinte (3 s) não espera os 15 s: renova já, e a imagem volta com outro endereço
    await passar(3_000);
    const nova = screen.getByAltText(/código qr/i) as HTMLImageElement;
    expect(nova.getAttribute("src")).not.toBe(primeira);
    expect(screen.queryByText(/não consegui carregar o código/i)).toBeNull();
  });

  // Se a Evolution não gera QR, cada erro de imagem renovava na consulta seguinte, sem fim. Como no
  // modal de Conexões, a espera tem teto: depois de 5 falhas seguidas, a tela para de pedir e oferece o botão.
  it("depois de 5 falhas seguidas da imagem, para de pedir e mostra o botão para tentar de novo", async () => {
    render(<ConnectWhatsappClient podeGerarQr sessionName="org_teste" oficialPodeReceber />);
    fireEvent.click(screen.getByTestId("forma-qr").querySelector("input")!);
    await passar(100);
    for (let i = 0; i < 4; i++) {
      fireEvent.error(screen.getByAltText(/código qr/i));
      await passar(3_000);
    }
    // a quinta falha seguida encerra a espera
    fireEvent.error(screen.getByAltText(/código qr/i));
    await passar(100);
    expect(screen.queryByAltText(/código qr/i)).toBeNull();
    expect(screen.getByText(/depois de várias tentativas/i)).toBeTruthy();
    const fetchMock = vi.mocked(fetch);
    const chamadas = fetchMock.mock.calls.length;
    await passar(60_000);
    expect(fetchMock.mock.calls.length).toBe(chamadas);
    expect(screen.queryByAltText(/código qr/i)).toBeNull();

    // o botão pede uma sessão nova e religa a espera
    fireEvent.click(screen.getByRole("button", { name: /gerar novo qr code/i }));
    await passar(100);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("restart=1"))).toBe(true);
    expect(screen.getByAltText(/código qr/i)).toBeTruthy();
    expect(screen.queryByText(/depois de várias tentativas/i)).toBeNull();
    const depois = fetchMock.mock.calls.length;
    await passar(3_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(depois);
  });

  it("uma imagem que carrega zera a contagem de falhas", async () => {
    render(<ConnectWhatsappClient podeGerarQr sessionName="org_teste" oficialPodeReceber />);
    fireEvent.click(screen.getByTestId("forma-qr").querySelector("input")!);
    await passar(100);
    for (let i = 0; i < 4; i++) {
      fireEvent.error(screen.getByAltText(/código qr/i));
      await passar(3_000);
    }
    fireEvent.load(screen.getByAltText(/código qr/i));
    for (let i = 0; i < 4; i++) {
      fireEvent.error(screen.getByAltText(/código qr/i));
      await passar(3_000);
    }
    expect(screen.getByAltText(/código qr/i)).toBeTruthy();
    expect(screen.queryByText(/depois de várias tentativas/i)).toBeNull();
  });
});
