import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";

import { QrDialog } from "./ConnectionsClient";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));

/**
 * O modal de QR consultava `/api/v1/channel-sessions/:id` a cada 3 s enquanto
 * estivesse montado, inclusive depois de o canal chegar a um estado em que nada
 * mais muda sozinho: desvinculado (FAILED/STOPPED, que só sai com "Gerar novo
 * QR") e conectado. Achado da varredura de 10/11/2026. Mede-se aqui o número de
 * chamadas ao status, com relógio falso.
 */

const SESSAO = "33333333-3333-4333-8333-333333333333";
const URL_STATUS = `/api/v1/channel-sessions/${SESSAO}`;

let statusDoCanal = "STARTING";

function chamadasDeStatus(): number {
  return vi.mocked(apiClient.get).mock.calls.filter(([url]) => url === URL_STATUS).length;
}

async function passar(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function montar(props: Partial<React.ComponentProps<typeof QrDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <QrDialog
        sessionId={SESSAO}
        title="Conectar"
        wahaConfigured
        evolution={false}
        onClose={vi.fn()}
        onConnected={vi.fn()}
        onForcePair={vi.fn(async () => undefined)}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  statusDoCanal = "STARTING";
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url === URL_STATUS) return { data: { status: statusDoCanal } };
    return { data: { base64: null, pairing_code: null, warning: null } };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("modal de QR: a consulta de 3 s para quando não há mais o que esperar", () => {
  it("CONTROLE: enquanto prepara o código, consulta a cada 3 s", async () => {
    montar();
    await passar(0);
    expect(chamadasDeStatus()).toBe(1);
    await passar(9_000);
    expect(chamadasDeStatus()).toBe(4);
  });

  it("para de consultar quando o canal está desvinculado (FAILED)", async () => {
    statusDoCanal = "FAILED";
    montar();
    await passar(0);
    expect(chamadasDeStatus()).toBe(1);
    await passar(30_000);
    expect(chamadasDeStatus()).toBe(1);
  });

  it("para de consultar quando o canal está desvinculado (STOPPED)", async () => {
    statusDoCanal = "STOPPED";
    montar();
    await passar(0);
    await passar(30_000);
    expect(chamadasDeStatus()).toBe(1);
  });

  it("para de consultar quando conectou (WORKING) e avisa uma vez só", async () => {
    const onConnected = vi.fn();
    montar({ onConnected });
    await passar(0);
    statusDoCanal = "WORKING";
    await passar(3_000);
    const ate = chamadasDeStatus();
    await passar(30_000);
    expect(chamadasDeStatus()).toBe(ate);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("para de consultar quando o modal fecha (desmonta)", async () => {
    const { unmount } = montar();
    await passar(0);
    unmount();
    const ate = chamadasDeStatus();
    await passar(30_000);
    expect(chamadasDeStatus()).toBe(ate);
  });

  it("volta a consultar depois de 'Gerar novo QR'", async () => {
    statusDoCanal = "FAILED";
    const onForcePair = vi.fn(async () => {
      statusDoCanal = "STARTING";
    });
    const tela = montar({ onForcePair });
    await passar(0);
    expect(chamadasDeStatus()).toBe(1);
    await act(async () => {
      tela.getByRole("button", { name: /Gerar novo QR/ }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await passar(9_000);
    expect(chamadasDeStatus()).toBeGreaterThanOrEqual(3);
  });
});

/**
 * A conexão nova da Evolution nasce com `qrcode: false` (`criarInstancia`), e até o primeiro
 * `/instance/connect` a Evolution diz `close` para ela, que o CRM grava como STOPPED. A primeira consulta de
 * status corre junto com o primeiro pedido de QR e chegava antes: o modal mostrava "Este número foi
 * desvinculado" para um número que nunca foi pareado, parava de consultar e não pedia QR nenhum.
 * Na Evolution, `close` é "sem sessão": o caminho é pedir o QR (o `/instance/connect` abre a sessão), e não
 * mandar a pessoa gerar outro. FAILED continua sendo desvinculado.
 */
describe("modal de QR da Evolution: conexão nova que a Evolution ainda dá como fechada (N4)", () => {
  const URL_QR = `/api/v1/channel-sessions/${SESSAO}/qr?format=json`;
  const pedidosDeQr = () => vi.mocked(apiClient.get).mock.calls.filter(([url]) => url === URL_QR).length;

  it("STOPPED na Evolution: não diz desvinculado, pede o QR e segue consultando até ele chegar", async () => {
    statusDoCanal = "STOPPED";
    let qr: string | null = null;
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      if (url === URL_STATUS) return { data: { status: statusDoCanal } };
      return { data: { base64: qr, pairing_code: null, warning: null } };
    });
    const tela = montar({ evolution: true });
    await passar(0);
    await passar(100);
    expect(tela.queryByText(/foi desvinculado/)).toBeNull();
    expect(pedidosDeQr()).toBeGreaterThanOrEqual(1);
    const consultas = chamadasDeStatus();
    await passar(9_000);
    expect(chamadasDeStatus()).toBeGreaterThan(consultas);
    qr = "data:image/png;base64,AAAA";
    statusDoCanal = "STARTING";
    await passar(15_000);
    expect(tela.getByAltText("QR Code para conectar WhatsApp").getAttribute("src")).toBe(qr);
  });

  // Em `close` sem QR nenhum, a consulta de 3 s não roda para sempre. Depois de
  // 2 minutos o modal para, volta à frase de desvinculado e oferece "Gerar novo QR", que religa a consulta.
  it("STOPPED na Evolution sem QR por 2 minutos: para de consultar e oferece gerar novo QR", async () => {
    statusDoCanal = "STOPPED";
    const onForcePair = vi.fn(async () => {
      statusDoCanal = "STARTING";
    });
    const tela = montar({ evolution: true, onForcePair });
    await passar(0);
    await passar(119_000);
    expect(tela.queryByText(/foi desvinculado/)).toBeNull();
    await passar(2_000);
    expect(tela.getByText(/foi desvinculado/)).toBeTruthy();
    const consultas = chamadasDeStatus();
    const qrs = pedidosDeQr();
    await passar(60_000);
    expect(chamadasDeStatus()).toBe(consultas);
    expect(pedidosDeQr()).toBe(qrs);

    await act(async () => {
      tela.getByRole("button", { name: /Gerar novo QR/ }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await passar(9_000);
    expect(chamadasDeStatus()).toBeGreaterThan(consultas);
    expect(tela.queryByText(/foi desvinculado/)).toBeNull();
  });

  it("FAILED na Evolution segue sendo desvinculado (com o botão de gerar novo QR)", async () => {
    statusDoCanal = "FAILED";
    const tela = montar({ evolution: true });
    await passar(0);
    await passar(100);
    expect(tela.getByText(/foi desvinculado/)).toBeTruthy();
  });
});
