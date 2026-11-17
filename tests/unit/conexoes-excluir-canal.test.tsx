/**
 * Central de Conexões — o que a tela PROMETE antes de uma ação irreversível.
 *
 * Três enganos moravam aqui, todos do tipo que só aparece operando de verdade:
 *  1. listagem que falha renderizava a tela de primeira instalação ("conecte seu
 *     primeiro número") para quem já tem número no ar — convite a parear de novo
 *     um aparelho já conectado;
 *  2. o botão Excluir era clicável sem o serviço de WhatsApp ativo, e a rota
 *     falha fechado (503): o clique prometia uma desconexão que não acontecia;
 *  3. o diálogo jurava "só o canal é removido" e "escaneie o QR de novo" — texto
 *     fixo, escrito antes de o servidor saber decidir entre apagar e arquivar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/types";
import type { ChannelDeletionImpact } from "@/app/api/v1/channel-sessions/[id]/route";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";

const getMock = vi.fn();
const deleteMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: { warning: (m: string) => toastWarning(m), success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock("@/hooks/channels/usePacingKnobs", () => ({
  usePacingKnobs: () => ({ data: { items: [] } }),
}));

vi.mock("@/components/connections/AntiBanSheet", () => ({ AntiBanSheet: () => null }));

const listagem: {
  data: ChannelSession[] | undefined;
  isLoading: boolean;
  isError: boolean;
  schemaOutdated: boolean;
} = { data: [], isLoading: false, isError: false, schemaOutdated: false };

// Só a listagem é dublada: `channelLabel` e `deriveOverallHealth` do módulo real
// são o que está sob teste na bolinha e no rótulo dos botões.
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import { ConnectionsClient, frasesDoImpacto } from "@/components/connections/ConnectionsClient";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";

function canal(over: Partial<ChannelSession> = {}): ChannelSession {
  return {
    id: "canal-1",
    waha_session_name: "org_1111_aaa",
    display_name: "Vendas",
    phone_number: "5511999999999",
    status: "WORKING",
    status_reason: null,
    last_health_check_at: null,
    last_status_change_at: null,
    daily_message_limit: 250,
    is_warmup_complete: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

const IMPACTO_ARQUIVA: ChannelDeletionImpact = {
  outcome: "archive",
  history: { conversations: 12, messages: 340, agent_versions: 0 },
  configuration: { ai_routers: 1, channel_knobs: 0, before_send_traces: 7 },
  disparo: { chips_no_motor: 0 },
};

/**
 * A exclusão espera MAIS que o orçamento de revogação do servidor (6 s) e não se
 * repete sozinha: com o limite padrão (10 s, até 3 tentativas) a tela desistia
 * antes da resposta, mostrava erro vermelho em vez do aviso e disparava exclusões
 * concorrentes da mesma conexão.
 */
const OPCOES_DO_DELETE = { timeoutMs: 20_000, retryOnNetworkError: false };

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  getMock.mockReset();
  deleteMock.mockReset();
  postMock.mockReset();
  toastWarning.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  listagem.data = [canal()];
  listagem.isLoading = false;
  listagem.isError = false;
  listagem.schemaOutdated = false;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("listagem que falhou não vira 'primeira instalação'", () => {
  it("erro de carregamento aparece como erro, e não como zero número", () => {
    listagem.data = undefined;
    listagem.isError = true;

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText("Não foi possível carregar seus números.")).toBeInTheDocument();
    expect(screen.getByText(/esta lista não está mostrando o que existe/)).toBeInTheDocument();
    expect(screen.queryByText(/Conecte seu primeiro número/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nenhum número conectado ainda/)).not.toBeInTheDocument();
  });

  it("org realmente sem número continua vendo o convite de primeira conexão", () => {
    listagem.data = [];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText(/Conecte seu primeiro número/)).toBeInTheDocument();
  });

  it("banco sem a migration: avisa que canal excluído volta à lista", () => {
    listagem.schemaOutdated = true;

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText(/continua aparecendo nesta lista/)).toBeInTheDocument();
  });

  it("bolinha da sidebar não diz 'Nenhuma conexão' quando a lista falhou", () => {
    listagem.data = undefined;
    listagem.isError = true;

    render(wrap(<ConnectionHealthDot />));

    expect(screen.getByLabelText("Não foi possível verificar as conexões")).toBeInTheDocument();
  });
});

/**
 * O botão ficava desabilitado sem o serviço no ar, porque a rota falhava fechado
 * (503). Hoje a exclusão é sempre possível: o canal sai do CRM e, se o servidor
 * não respondeu, a resposta traz um aviso (toast amarelo, não vermelho).
 */
describe("Excluir sem o serviço de WhatsApp ativo", () => {
  it("continua disponível para o número pareado por QR", () => {
    render(wrap(<ConnectionsClient wahaConfigured={false} />));

    expect(screen.getByRole("button", { name: "Excluir Vendas" })).toBeEnabled();
  });

  it("o diálogo promete que a conexão sai do CRM mesmo com o servidor fora", async () => {
    getMock.mockResolvedValue({ data: { deletion_impact: IMPACTO_ARQUIVA } });

    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    fireEvent.click(screen.getByRole("button", { name: "Excluir Vendas" }));

    expect(
      await screen.findByText("Mesmo com o servidor fora do ar, a conexão sai do CRM. Conversas e contatos ficam."),
    ).toBeInTheDocument();
  });

  it("servidor que não respondeu vira aviso amarelo, não erro", async () => {
    const aviso =
      "O servidor de WhatsApp não respondeu. A conexão saiu do CRM, mas pode continuar ativa no aparelho: desconecte em Aparelhos conectados.";
    getMock.mockResolvedValue({ data: { deletion_impact: IMPACTO_ARQUIVA } });
    deleteMock.mockResolvedValue({
      data: { id: "canal-1", archived: true, impact: IMPACTO_ARQUIVA, revogado: false, aviso },
    });

    render(wrap(<ConnectionsClient wahaConfigured={false} />));
    fireEvent.click(screen.getByRole("button", { name: "Excluir Vendas" }));
    const confirmar = await screen.findByRole("button", { name: "Excluir" });
    await waitFor(() => expect(confirmar).toBeEnabled());
    fireEvent.click(confirmar);

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/api/v1/channel-sessions/canal-1", undefined, OPCOES_DO_DELETE));
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(aviso));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("continua disponível para o canal que não depende do transporte", () => {
    listagem.data = [canal({ waha_session_name: null, display_name: "Oficial" })];

    render(wrap(<ConnectionsClient wahaConfigured={false} />));

    expect(screen.getByRole("button", { name: "Excluir Oficial" })).toBeEnabled();
  });
});

/**
 * Mesma classe do Excluir, três linhas acima na mesma tela: o botão prometia uma
 * ação que a API recusa (422 `channel_without_session`). O canal oficial não tem
 * sessão no transporte para reiniciar — e o clique ainda abria o diálogo de QR,
 * que ele nunca vai ter, deixando o operador esperando um código que não vem.
 */
describe("Reconectar não é oferecido a quem não vive no transporte", () => {
  it("canal oficial não recebe o botão", () => {
    listagem.data = [canal({ waha_session_name: null, display_name: "Oficial" })];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.queryByRole("button", { name: /Reconectar/ })).not.toBeInTheDocument();
    // Não-vacuidade: o card É o do canal oficial, e as ações dele continuam lá.
    expect(screen.getByRole("button", { name: "Excluir Oficial" })).toBeInTheDocument();
  });

  it("número pareado por QR continua recebendo o botão", () => {
    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByRole("button", { name: /Reconectar/ })).toBeEnabled();
  });
});

describe("diálogo de exclusão diz a verdade antes do clique", () => {
  it("consome o preflight e lista o que fica guardado e o que para de atender", async () => {
    getMock.mockResolvedValue({ data: { deletion_impact: IMPACTO_ARQUIVA } });

    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: "Excluir Vendas" }));

    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith("/api/v1/channel-sessions/canal-1?impact=1"),
    );
    expect(await screen.findByText("Continua no inbox: 12 conversas e 340 mensagens.")).toBeInTheDocument();
    expect(
      screen.getByText("Fica salvo, mas sem número — para de atender: 1 roteador de IA."),
    ).toBeInTheDocument();
    // A promessa antiga: valia só para o número pareado por QR, e mesmo nele
    // dizia que "só o canal é removido".
    expect(screen.queryByText(/escanear o QR de novo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/só o canal é removido/)).not.toBeInTheDocument();
  });

  it("não deixa confirmar enquanto não sabe o que vai acontecer", async () => {
    getMock.mockReturnValue(new Promise(() => {}));

    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: "Excluir Vendas" }));

    const confirmar = await screen.findByRole("button", { name: "Excluir" });
    expect(confirmar).toBeDisabled();
    expect(screen.getByText(/Verificando o que está ligado/)).toBeInTheDocument();
  });

  it("preflight que falhou não vira promessa: admite que não sabe", async () => {
    getMock.mockRejectedValue(new Error("500"));

    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: "Excluir Vendas" }));

    expect(await screen.findByText(/Não foi possível verificar o que está ligado/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Excluir" })).toBeEnabled();
  });

  it("confirmar usa o impacto que o DELETE devolve para contar a conversa preservada", async () => {
    getMock.mockResolvedValue({ data: { deletion_impact: IMPACTO_ARQUIVA } });
    deleteMock.mockResolvedValue({
      data: { id: "canal-1", archived: true, impact: IMPACTO_ARQUIVA },
    });

    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: "Excluir Vendas" }));
    fireEvent.click(await screen.findByRole("button", { name: "Excluir" }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith("/api/v1/channel-sessions/canal-1", undefined, OPCOES_DO_DELETE),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Canal removido. 12 conversas continuam no inbox.",
      ),
    );
  });
});

describe("frasesDoImpacto", () => {
  it("canal virgem: diz que não há nada ligado — é o único caso em que a linha some", () => {
    expect(
      frasesDoImpacto({
        outcome: "delete",
        history: { conversations: 0, messages: 0, agent_versions: 0 },
        configuration: { ai_routers: 0, channel_knobs: 0, before_send_traces: 0 },
        disparo: { chips_no_motor: 0 },
      }),
    ).toEqual(["Este número não tem conversa, mensagem nem configuração ligada a ele."]);
  });

  it("contagem zero não vira frase", () => {
    const frases = frasesDoImpacto({
      outcome: "archive",
      history: { conversations: 0, messages: 0, agent_versions: 2 },
      configuration: { ai_routers: 0, channel_knobs: 0, before_send_traces: 0 },
      disparo: { chips_no_motor: 0 },
    });
    expect(frases).toEqual(["Fica salvo, mas sem número — para de atender: 2 versões de agente."]);
  });

  it("só auditoria pendurada: explica o arquivamento em vez de prometer que não há nada", () => {
    const frases = frasesDoImpacto({
      outcome: "archive",
      history: { conversations: 0, messages: 0, agent_versions: 0 },
      configuration: { ai_routers: 0, channel_knobs: 0, before_send_traces: 4 },
      disparo: { chips_no_motor: 0 },
    });
    expect(frases).toEqual([
      "Este canal tem registros internos, por isso ele é arquivado em vez de apagado.",
    ]);
  });

  it("número no motor de disparo: avisa que sai do motor e que os pendentes são cancelados, nos dois desfechos", () => {
    const aviso = "Este número está no motor de disparo; ele sai do motor e os envios pendentes dele são cancelados.";
    const apaga = frasesDoImpacto({
      outcome: "delete",
      history: { conversations: 0, messages: 0, agent_versions: 0 },
      configuration: { ai_routers: 0, channel_knobs: 0, before_send_traces: 0 },
      disparo: { chips_no_motor: 1 },
    });
    expect(apaga).toEqual(["Este número não tem conversa, mensagem nem configuração ligada a ele.", aviso]);
    const arquiva = frasesDoImpacto({ ...IMPACTO_ARQUIVA, disparo: { chips_no_motor: 1 } });
    expect(arquiva.at(-1)).toBe(aviso);
  });
});


describe("copiar detalhes de conexão no self-host HTTP", () => {
  it.each([true, false])("fallback execCommand=%s dá feedback e preserva detalhe", async (copied) => {
    listagem.data = [];
    getMock.mockResolvedValue({ data: { channels: [], members: [] } });
    postMock.mockRejectedValue(new ApiError(502, "connection_repair_required", { operation: "start" }, "request-owned"));
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockReturnValue(copied);
    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: "Conectar novo WhatsApp" }));
    const details = await screen.findByText(/request-owned/);
    fireEvent.click(screen.getByText("Detalhes para suporte"));
    fireEvent.click(screen.getByRole("button", { name: "Copiar detalhes" }));
    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith("copy"));
    await waitFor(() => expect(copied ? toastSuccess : toastError).toHaveBeenCalledWith(
      copied ? "Copiado!" : "Não foi possível copiar. Selecione e copie manualmente.",
    ));
    expect(details).toHaveTextContent("connection_repair_required");
    expect(details).toHaveTextContent("request-owned");
  });
});


it("Evolution mostra código junto do QR e sinal de chip mudo", async () => {
  listagem.data = [canal({ provider: "evolution", chip_mudo: true })];
  postMock.mockResolvedValue({ data: { status: "SCAN_QR_CODE", warning: null } });
  getMock.mockImplementation(async (url: string) => {
    if (url.includes("/qr?")) return { data: { base64: "data:image/png;base64,YWJj", pairing_code: "ABCD-1234", warning: null } };
    if (url.endsWith("/canal-1")) return { data: { status: "SCAN_QR_CODE" } };
    return { data: {} };
  });
  render(wrap(<ConnectionsClient wahaConfigured={false} />));
  expect(screen.getByText("Chip mudo")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
  expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
  expect(screen.getByAltText("QR Code para conectar WhatsApp")).toHaveAttribute("src", "data:image/png;base64,YWJj");
});

it("cancelar reconex?o de Evolution aberta não faz logout nem abre QR", async () => {
  listagem.data = [canal({ provider: "evolution" })];
  postMock.mockResolvedValue({ data: { status: "WORKING" } });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(wrap(<ConnectionsClient wahaConfigured={false} />));
  fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(postMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});


it("confirma reparo e mostra aviso de configuração sem impedir QR", async () => {
  listagem.data = [canal({ provider: "evolution" })];
  postMock.mockResolvedValueOnce({ data: { status: "WORKING" } })
    .mockResolvedValueOnce({ data: { status: "SCAN_QR_CODE", warning: "Confira o histórico no serviço." } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(wrap(<ConnectionsClient wahaConfigured={false} />));
  fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(postMock).toHaveBeenLastCalledWith("/api/v1/channel-sessions/canal-1/reconnect", { force: true }, { timeoutMs: 60_000 });
  expect(toastWarning).toHaveBeenCalledWith("Confira o histórico no serviço.");
});

it("Evolution em STARTING (connecting) já mostra o QR, sem ficar em Preparando", async () => {
  listagem.data = [canal({ provider: "evolution", status: "STOPPED" })];
  postMock.mockResolvedValue({ data: { status: "SCAN_QR_CODE", warning: null } });
  getMock.mockImplementation(async (url: string) => {
    if (url.includes("/qr?")) return { data: { base64: "data:image/png;base64,YWJj", pairing_code: null, warning: null } };
    if (url.endsWith("/canal-1")) return { data: { status: "STARTING" } };
    return { data: {} };
  });
  render(wrap(<ConnectionsClient wahaConfigured={false} />));
  fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
  const imagem = await screen.findByAltText("QR Code para conectar WhatsApp");
  expect(imagem).toHaveAttribute("src", "data:image/png;base64,YWJj");
  expect(screen.queryByText("Preparando o código…")).not.toBeInTheDocument();
});

describe("poll rápido só enquanto alguém está pareando", () => {
  const chamadasDoCanal = () => getMock.mock.calls.filter(([url]) => url === "/api/v1/channel-sessions/canal-1");

  afterEach(() => { vi.useRealTimers(); });

  it("sem modal de QR aberto não há chamada de 3 em 3 s", async () => {
    vi.useFakeTimers();
    getMock.mockResolvedValue({ data: { status: "WORKING" } });
    render(wrap(<ConnectionsClient wahaConfigured />));
    await vi.advanceTimersByTimeAsync(1_000);
    // A conferência inicial da tela é uma chamada por canal; depois disso, silêncio.
    const aposAbrir = chamadasDoCanal().length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chamadasDoCanal()).toHaveLength(aposAbrir);
  });

  it("com o modal de QR aberto o poll de 3 s continua", async () => {
    vi.useFakeTimers();
    postMock.mockResolvedValue({ data: { status: "SCAN_QR_CODE", warning: null } });
    getMock.mockResolvedValue({ data: { status: "SCAN_QR_CODE" } });
    render(wrap(<ConnectionsClient wahaConfigured />));
    await vi.advanceTimersByTimeAsync(1_000);
    fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const antes = chamadasDoCanal().length;
    await vi.advanceTimersByTimeAsync(9_100);
    expect(chamadasDoCanal().length - antes).toBeGreaterThanOrEqual(3);
  });
});
