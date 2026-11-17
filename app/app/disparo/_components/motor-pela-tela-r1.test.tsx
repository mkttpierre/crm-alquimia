/**
 * Correção R1 das telas do motor: nada mente quando uma leitura falha (selo do modo, chips, simulação), toda gravação
 * que falha avisa, o que é perigoso pede confirmação, e a seção Avançado devolve o teto diário à tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lerRitmo, RITMO_PADRAO } from "@/lib/disparo/config";
import type { ConfigDaTela, EstadoDoMotor, SimulacaoDaTela } from "@/lib/disparo-painel/esquemas";

import { CadenciaDoMotor } from "./CadenciaDoMotor";
import { ChipsEditor } from "./ChipsEditor";
import { DisparoClient } from "./DisparoClient";
import { FonteDosLeads } from "./FonteDosLeads";
import { PerfisDeRitmo } from "./PerfisDeRitmo";
import { passosIniciais, PrimeirosPassos } from "./PrimeirosPassos";
import { SegurancaDeEnvio, TextoQueAcompanha } from "./SegurancaDeEnvio";
import { SimulacaoDoDia } from "./SimulacaoDoDia";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/app/disparo" }));

type Chamada = { url: string; metodo: string; corpo: unknown };
let chamadas: Chamada[] = [];
let respostas: (url: string, metodo: string) => { status?: number; corpo: unknown } | undefined;
const ok = (data: unknown): { status?: number; corpo: unknown } => ({ corpo: { data } });

beforeEach(() => {
  chamadas = [];
  respostas = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = String(entrada);
      const metodo = init?.method ?? "GET";
      chamadas.push({ url, metodo, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = respostas(url, metodo) ?? ok({});
      return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function comCliente(no: ReactNode) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={cliente}>{no}</QueryClientProvider>);
}
const escritas = () => chamadas.filter((c) => c.metodo !== "GET");

const CONFIG: Extract<ConfigDaTela, { existe: true }> = {
  existe: true,
  etapas: [],
  etapa_arquivada: null,
  leads_na_etapa: null,
  ligado: false,
  modo: "simulado",
  teto_diario: null,
  cadencia: "reativacao_3_toques",
  fonte_stage_id: null,
  ritmo: RITMO_PADRAO,
  perfil: "recomendado",
  modelos: {},
  proibidos: [],
  recomendado: RITMO_PADRAO,
};
const SIMULACAO: SimulacaoDaTela = {
  perfil: "recomendado", perfil_atual: "recomendado", dia: "2026-11-17", janela: [{ inicio: 480, fim: 1140 }], fuso_minutos: -180,
  porChip: [], totalNovas: 0, primeira: null, ultima: null, pausasLongas: 0,
};
const ESTADO = (p: Partial<EstadoDoMotor> = {}) =>
  ({
    existe: true, ligado: false, modo: "real", modo_efetivo: "real", chave_da_organizacao: true, chave_do_servidor: true, destinos_permitidos: null,
    motivo_simulado: null, teto_diario: null, cadencia: "reativacao_3_toques", atendimento_ligado: false, agora: "2026-11-17T13:00:00Z", fuso_minutos: -180,
    hoje: { data: "2026-11-17", feriado: false, janela: [{ inicio: 480, fim: 1140 }], dentro_da_janela: true },
    janela: { semana: [], sabado: [], domingo: [] },
    ritmo: { intervalo_nova: { min: 10, max: 18 }, intervalo_piso_min: 10, pausa: { min: 20, max: 40 }, pausa_a_cada: { min: 5, max: 9 }, max_aberturas_hora: 6, max_envios_hora: 12 },
    proximo_envio: null, contagens: { pendente: 0, enviando: 0, enviado: 0, simulado: 0, cancelado: 0, falhou: 0, hoje: 0 }, chips: { total: 1, ativos: 1, sem_canal: 0 },
    ...p,
  }) as EstadoDoMotor;

function telaInteira(config: Partial<typeof CONFIG>, estado: { status?: number; corpo: unknown } | undefined, patch?: { status: number; corpo: unknown }) {
  respostas = (url, metodo) => {
    if (metodo === "PATCH" && patch) return patch;
    if (url.endsWith("/api/v1/disparo/config")) return ok({ ...CONFIG, ...config });
    if (url.includes("/simulacao")) return ok(SIMULACAO);
    if (url.includes("/api/v1/disparo/estado")) return estado;
    if (url.includes("/chips")) return ok({ itens: [] });
    if (url.includes("channel-sessions")) return { corpo: { data: [] } };
    if (url.includes("/fila")) return ok({ itens: [], pagina: 1, tamanho: 20, total: 0 });
    return undefined;
  };
}

describe("I1: o selo do modo não mente sem o /estado", () => {
  it("modo real com /estado fora do ar: 'aguardando confirmação do servidor', e nenhuma instrução de .env", async () => {
    telaInteira({ modo: "real" }, { status: 500, corpo: { error: { message: "x" } } });
    comCliente(<DisparoClient podeEditar podeTrocarModo />);
    expect(await screen.findByText("Real · aguardando confirmação do servidor")).toBeTruthy();
    expect(screen.queryByText("Simulado · nada sai")).toBeNull();
    expect(screen.queryByText("DISPARO_REAL_LIBERADO=sim")).toBeNull();
  });

  it("modo real com as duas chaves: 'Enviando de verdade' e a trava dupla explicada no card Modo", async () => {
    telaInteira({ modo: "real", ligado: true }, ok(ESTADO({ destinos_permitidos: 2, chips: { total: 2, ativos: 2, sem_canal: 1 } })));
    comCliente(<DisparoClient podeEditar podeTrocarModo />);
    expect(await screen.findByText("Enviando de verdade")).toBeTruthy();
    expect(await screen.findByText(/as duas chaves estão ligadas/)).toBeTruthy();
    expect(screen.getByText(/só deixa sair para 2 números/)).toBeTruthy();
    expect(screen.getByText(/1 chip sem conexão só simula/)).toBeTruthy();
  });
});

describe("I2: gravação que falha avisa", () => {
  it("erro ao aplicar perfil aparece no topo", async () => {
    telaInteira({}, ok(ESTADO({ modo: "simulado", modo_efetivo: "simulado" })), { status: 500, corpo: { error: { message: "O banco não respondeu." } } });
    comCliente(<DisparoClient podeEditar podeTrocarModo={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /Acelerado/ }));
    fireEvent.click(screen.getByRole("button", { name: "Usar este perfil" }));
    expect(await screen.findByText("O banco não respondeu.")).toBeTruthy();
  });

  it("erro ao ligar o motor aparece no topo; resposta sem mensagem vira frase completa", async () => {
    telaInteira({}, ok(ESTADO({ modo: "simulado", modo_efetivo: "simulado" })), { status: 500, corpo: {} });
    comCliente(<DisparoClient podeEditar podeTrocarModo={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ligar o motor" }));
    expect(await screen.findByText("Não foi possível salvar o ajuste.")).toBeTruthy();
  });

  it("ligar com o envio real valendo pede confirmação", async () => {
    telaInteira({ modo: "real" }, ok(ESTADO({ ligado: false })));
    comCliente(<DisparoClient podeEditar podeTrocarModo />);
    fireEvent.click(await screen.findByRole("button", { name: "Ligar o motor" }));
    expect(escritas()).toEqual([]);
    expect(screen.getByText(/As mensagens vão sair de verdade/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ligar e enviar de verdade" }));
    await waitFor(() => expect(escritas()).toEqual([{ url: "/api/v1/disparo/config", metodo: "PATCH", corpo: { ligado: true } }]));
  });

  it("erro ao trocar a cadência aparece no card", async () => {
    respostas = (_u, m) => (m === "PATCH" ? { status: 500, corpo: {} } : undefined);
    comCliente(<CadenciaDoMotor atual="reativacao_3_toques" podeEditar />);
    fireEvent.click(screen.getByRole("button", { name: "Usar esta cadência" }));
    expect(await screen.findByText("Não foi possível salvar o ajuste.")).toBeTruthy();
  });
});

describe("M3: perfil sobre números personalizados pede confirmação", () => {
  it("o primeiro clique só avisa; o segundo aplica", () => {
    const onAplicar = vi.fn();
    render(<PerfisDeRitmo atual="personalizado" previa="conservador" onPrevia={vi.fn()} onAplicar={onAplicar} aplicando={false} podeEditar />);
    fireEvent.click(screen.getByRole("button", { name: "Usar este perfil" }));
    expect(onAplicar).not.toHaveBeenCalled();
    expect(screen.getByText(/Isso troca seus números personalizados/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trocar mesmo" }));
    expect(onAplicar).toHaveBeenCalledWith("conservador");
  });
});

describe("I3: chips e simulação sem dado não fingem vazio", () => {
  it("chips carregando não dizem 'nenhum WhatsApp'; com erro há 'Tentar de novo'; vazio leva a Conexões", () => {
    const onTentar = vi.fn();
    const { rerender } = comCliente(<ChipsEditor chips={[]} conexoes={[]} podeEditar carregando />);
    expect(screen.queryByText(/Nenhum WhatsApp conectado/)).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ChipsEditor chips={[]} conexoes={[]} podeEditar erro onTentar={onTentar} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(onTentar).toHaveBeenCalled();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ChipsEditor chips={[]} conexoes={[]} podeEditar />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("link", { name: "Conexões" }).getAttribute("href")).toBe("/app/connections");
  });

  it("simulação com erro não diz 'hoje não há janela'; em prévia, diz que ainda não foi aplicado", () => {
    const { rerender } = render(
      <SimulacaoDoDia simulacao={undefined} carregando={false} erro onTentar={vi.fn()} pausa={{ min: 20, max: 40 }} onPersonalizar={vi.fn()} podeEditar />,
    );
    expect(screen.getByText("Não foi possível simular o dia.")).toBeTruthy();
    expect(screen.queryByText(/Hoje não há janela/)).toBeNull();
    rerender(<SimulacaoDoDia simulacao={SIMULACAO} carregando={false} previa="Acelerado" pausa={{ min: 15, max: 30 }} onPersonalizar={vi.fn()} podeEditar />);
    expect(screen.getByText("Prévia do perfil Acelerado — ainda não aplicado")).toBeTruthy();
  });
});

describe("I4: de onde vêm os leads", () => {
  it("sem etapa nenhuma: leva a criar um funil", () => {
    comCliente(<FonteDosLeads etapas={[]} etapaAtual={null} etapaArquivada={null} leadsNaEtapa={null} podeEditar />);
    expect(screen.getByRole("link", { name: "Criar um funil" }).getAttribute("href")).toBe("/app/pipelines");
  });

  it("etapa escolhida que foi arquivada aparece desabilitada", () => {
    comCliente(
      <FonteDosLeads
        etapas={[{ id: "e1", nome: "Novo", funil_id: "p1", funil: "Vendas" }]}
        etapaAtual="e9"
        etapaArquivada={{ id: "e9", nome: "Antiga" }}
        leadsNaEtapa={0}
        podeEditar
      />,
    );
    const opcao = screen.getByRole("option", { name: "Antiga (arquivada)" }) as HTMLOptionElement;
    expect(opcao.disabled).toBe(true);
  });
});

describe("Gaveta: Avançado, campo vazio e saída com rascunho", () => {
  it("teto diário volta à tela na seção Avançado e vai no PATCH fora do ritmo", async () => {
    comCliente(<SegurancaDeEnvio ritmo={RITMO_PADRAO} tetoDiario={null} aberto onFechar={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Teto de conversas novas por chip no dia"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(escritas()).toHaveLength(1));
    expect(escritas()[0]!.corpo).toEqual({ teto_diario: 30 });
  });

  it("Voltar ao recomendado do Avançado tira o teto e devolve fuso e filtro ao padrão", async () => {
    const ritmo = lerRitmo({ fusoMinutos: -240, filtroAbertura: { porChipOrigem: true } });
    comCliente(<SegurancaDeEnvio ritmo={ritmo} tetoDiario={20} aberto onFechar={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao recomendado: Avançado" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(escritas()).toHaveLength(1));
    expect(escritas()[0]!.corpo).toEqual({ teto_diario: null, ritmo: { fusoMinutos: RITMO_PADRAO.fusoMinutos, filtroAbertura: RITMO_PADRAO.filtroAbertura } });
  });

  it("campo numérico aceita ficar vazio enquanto se redigita", () => {
    comCliente(<SegurancaDeEnvio ritmo={RITMO_PADRAO} aberto onFechar={vi.fn()} />);
    const campo = screen.getByLabelText("Mensagens por hora") as HTMLInputElement;
    fireEvent.change(campo, { target: { value: "" } });
    expect(campo.value).toBe("");
    fireEvent.change(campo, { target: { value: "9" } });
    expect(campo.value).toBe("9");
  });

  it("fechar com alteração pede 'Descartar alterações?'", () => {
    const onFechar = vi.fn();
    comCliente(<SegurancaDeEnvio ritmo={RITMO_PADRAO} aberto onFechar={onFechar} />);
    fireEvent.change(screen.getByLabelText("Mensagens por hora"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onFechar).not.toHaveBeenCalled();
    expect(screen.getByText("Descartar alterações?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onFechar).toHaveBeenCalled();
  });
});

describe("M5: primeiros passos", () => {
  const base = { conectado: true, temChip: false, temEtapa: false, temAbertura: false, envioReal: false };
  it("sem motor criado, os passos das seções não são links", () => {
    render(<PrimeirosPassos passos={passosIniciais({ ...base, existe: false })} />);
    expect(screen.queryByRole("link", { name: /Escolher a etapa/ })).toBeNull();
    expect(screen.getByText("Escolher a etapa dos leads")).toBeTruthy();
  });
  it("gestor sem poder trocar o modo vê 'peça a um administrador'", () => {
    render(<PrimeirosPassos passos={passosIniciais({ ...base, existe: true, podeTrocarModo: false })} />);
    expect(screen.getByText(/peça a um administrador/)).toBeTruthy();
  });
});

describe("Avançado: imagem da abertura e editores de mapa e condições", () => {
  const ritmo = lerRitmo({
    rampasPorChip: { "celular-a": [5, 8] },
    filtroAbertura: { camposIguais: { d1_pronto: "true" } },
    lembretes: { tetoDia: { audio: 5 }, relevancia: [{ campo: "porta", igual: "blindada" }] },
  });

  it("a abertura lista só imagens; mídia gravada que não é imagem é recusada com o motivo", async () => {
    respostas = (url) =>
      url.includes("/api/v1/media-library")
        ? ok([
            { id: "img", name: "Foto.png", kind: "image", mime: "image/png", size_bytes: 1000 },
            { id: "vid", name: "Video.mp4", kind: "video", mime: "video/mp4", size_bytes: 1000 },
          ])
        : undefined;
    comCliente(<SegurancaDeEnvio ritmo={lerRitmo({ aberturaMidiaId: "vid" })} aberto onFechar={vi.fn()} />);
    expect(await screen.findByRole("option", { name: "Foto.png" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Video\.mp4/ })).toBeNull();
    expect(screen.getByText("A abertura aceita só imagem; vídeo ainda não é enviado pelo motor.")).toBeTruthy();
  });

  it("mapa (rampas por chip) e condições (relevância) gravam o que foi digitado", async () => {
    comCliente(<SegurancaDeEnvio ritmo={ritmo} aberto onFechar={vi.fn()} />);
    const rampa = screen.getByDisplayValue("5, 8");
    fireEvent.change(rampa, { target: { value: "6, 9" } });
    fireEvent.blur(rampa);
    const aceitos = screen.getByDisplayValue("blindada");
    fireEvent.change(aceitos, { target: { value: "blindada, aberta" } });
    fireEvent.blur(aceitos);
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(escritas()).toHaveLength(1));
    const corpo = escritas()[0]!.corpo as { ritmo: Record<string, unknown> };
    expect(corpo.ritmo.rampasPorChip).toEqual({ "celular-a": [6, 9] });
    expect((corpo.ritmo.lembretes as { relevancia: unknown }).relevancia).toEqual([{ campo: "porta", igual: ["blindada", "aberta"] }]);
  });

  it("Voltar ao recomendado com um campo aberto: o campo acompanha e o salvar leva o padrão", async () => {
    comCliente(<SegurancaDeEnvio ritmo={ritmo} aberto onFechar={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue("5, 8"), { target: { value: "7, 7" } }); // digitando, sem sair do campo
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao recomendado: Avançado" }));
    expect(screen.queryByDisplayValue("7, 7")).toBeNull();
    expect(screen.queryByDisplayValue("blindada")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(escritas()).toHaveLength(1));
    const corpo = escritas()[0]!.corpo as { ritmo: Record<string, unknown> };
    expect(corpo.ritmo.rampasPorChip).toEqual({});
    expect(corpo.ritmo.lembretes).toEqual(RITMO_PADRAO.lembretes);
    expect(corpo.ritmo.filtroAbertura).toEqual(RITMO_PADRAO.filtroAbertura);
  });

  it("o texto aberto acompanha o valor trocado por fora", () => {
    const { rerender } = render(<TextoQueAcompanha rotulo="v" valor="5, 8" onConfirmar={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("v"), { target: { value: "9" } });
    rerender(<TextoQueAcompanha rotulo="v" valor="10, 12" onConfirmar={vi.fn()} />);
    expect((screen.getByLabelText("v") as HTMLInputElement).value).toBe("10, 12");
  });
});


describe("Correções da tela do motor", () => {
  it("M4: modo real gravado e /estado fora do ar: ligar pede confirmação e não grava antes", async () => {
    telaInteira({ modo: "real" }, { status: 500, corpo: { error: { message: "x" } } });
    comCliente(<DisparoClient podeEditar podeTrocarModo />);
    fireEvent.click(await screen.findByRole("button", { name: "Ligar o motor" }));
    expect(escritas()).toEqual([]);
    expect(screen.getByText(/As mensagens vão sair de verdade/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ligar e enviar de verdade" }));
    await waitFor(() => expect(escritas()).toEqual([{ url: "/api/v1/disparo/config", metodo: "PATCH", corpo: { ligado: true } }]));
  });

  it("(a) com a simulação anterior na tela enquanto a prévia chega: 'Carregando prévia…', sem o rótulo de prévia", () => {
    render(<SimulacaoDoDia simulacao={SIMULACAO} carregando={false} previa="Acelerado" previaCarregando pausa={{ min: 15, max: 30 }} onPersonalizar={vi.fn()} podeEditar />);
    expect(screen.getByText("Carregando prévia…")).toBeTruthy();
    expect(screen.queryByText(/ainda não aplicado/)).toBeNull();
  });

  it("(c) imagem da abertura gravada e biblioteca carregando: 'Carregando…' desabilitado, não um select em branco", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    comCliente(<SegurancaDeEnvio ritmo={lerRitmo({ aberturaMidiaId: "img" })} aberto onFechar={vi.fn()} />);
    const select = screen.getByLabelText("Imagem da abertura (a mensagem vai como legenda)") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByRole("option", { name: "Carregando…" })).toBeTruthy();
  });
});
