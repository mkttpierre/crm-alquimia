/**
 * A tela do motor (variação C): perfis com prévia que só aplica no botão, "Voltar ao recomendado" por
 * seção, modo real com a frase e a linha do .env, primeiros passos que somem, e os botões dos chips chamando a rota
 * certa. O `fetch` é dublado por URL: o que se mede é o que a tela PEDE ao servidor.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lerRitmo, RITMO_PADRAO } from "@/lib/disparo/config";
import { PERFIS_DE_RITMO } from "@/lib/disparo/perfis";
import type { ChipDaTela, ConfigDaTela } from "@/lib/disparo-painel/esquemas";

import { ChipsEditor } from "./ChipsEditor";
import { DisparoClient } from "./DisparoClient";
import { ModoDoMotor } from "./ModoDoMotor";
import { PerfisDeRitmo } from "./PerfisDeRitmo";
import { passosIniciais, PrimeirosPassos } from "./PrimeirosPassos";
import { SegurancaDeEnvio } from "./SegurancaDeEnvio";

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

describe("Perfis de ritmo", () => {
  it("marca o perfil em uso e tira os números de PERFIS_DE_RITMO", () => {
    render(<PerfisDeRitmo atual="recomendado" previa={null} onPrevia={vi.fn()} onAplicar={vi.fn()} aplicando={false} podeEditar />);
    const recomendado = screen.getByRole("button", { name: /Recomendado/ });
    expect(recomendado.getAttribute("aria-pressed")).toBe("true");
    const acelerado = PERFIS_DE_RITMO.acelerado;
    expect(screen.getByText(`Rampa de ${acelerado.rampa![0]} até ${acelerado.rampa!.at(-1)} por dia`)).toBeTruthy();
    expect(screen.queryByText("Personalizado")).toBeNull();
  });

  it("ritmo fora dos perfis: selo Personalizado e nenhum card marcado", () => {
    render(<PerfisDeRitmo atual="personalizado" previa={null} onPrevia={vi.fn()} onAplicar={vi.fn()} aplicando={false} podeEditar />);
    expect(screen.getByText("Personalizado")).toBeTruthy();
    for (const b of screen.getAllByRole("button")) expect(b.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicar só pré-visualiza; aplicar é o botão", () => {
    const onPrevia = vi.fn();
    const onAplicar = vi.fn();
    const { rerender } = render(<PerfisDeRitmo atual="recomendado" previa={null} onPrevia={onPrevia} onAplicar={onAplicar} aplicando={false} podeEditar />);
    fireEvent.click(screen.getByRole("button", { name: /Acelerado/ }));
    expect(onPrevia).toHaveBeenCalledWith("acelerado");
    expect(onAplicar).not.toHaveBeenCalled();
    rerender(<PerfisDeRitmo atual="recomendado" previa="acelerado" onPrevia={onPrevia} onAplicar={onAplicar} aplicando={false} podeEditar />);
    fireEvent.click(screen.getByRole("button", { name: "Usar este perfil" }));
    expect(onAplicar).toHaveBeenCalledWith("acelerado");
  });
});

describe("Tela inteira: a prévia não aplica até confirmar", () => {
  const config: ConfigDaTela = {
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

  it("clicar em Acelerado pede a simulação com ?perfil=acelerado e não grava; o botão grava { perfil }", async () => {
    respostas = (url) => {
      if (url.endsWith("/api/v1/disparo/config")) return ok(config);
      if (url.includes("/api/v1/disparo/simulacao"))
        return ok({ perfil: "x", perfil_atual: "recomendado", dia: "2026-11-17", janela: [], fuso_minutos: -180, porChip: [], totalNovas: 0, primeira: null, ultima: null, pausasLongas: 0 });
      if (url.includes("/api/v1/disparo/estado")) return ok({ existe: false, agora: "x" });
      if (url.includes("/chips")) return ok({ itens: [] });
      if (url.includes("channel-sessions")) return { corpo: { data: [] } };
      if (url.includes("/fila")) return ok({ itens: [], pagina: 1, tamanho: 20, total: 0 });
      return undefined;
    };
    comCliente(<DisparoClient podeEditar podeTrocarModo={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /Acelerado/ }));
    await waitFor(() => expect(chamadas.some((c) => c.url.includes("/simulacao?perfil=acelerado"))).toBe(true));
    expect(escritas()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Usar este perfil" }));
    await waitFor(() => expect(escritas()).toHaveLength(1));
    expect(escritas()[0]).toMatchObject({ url: "/api/v1/disparo/config", metodo: "PATCH", corpo: { perfil: "acelerado" } });
  });
});

describe("Personalizar: Voltar ao recomendado restaura só a seção", () => {
  it("devolve a seção ao RITMO_PADRAO, salva só o que mudou e mostra o erro do servidor no campo", async () => {
    const ritmo = lerRitmo({ intervaloNova: { min: 30, max: 40 }, maxEnviosHora: 20 });
    comCliente(<SegurancaDeEnvio ritmo={ritmo} aberto onFechar={vi.fn()} />);
    const minimo = screen.getByLabelText("Chip em rampa (mínimo)") as HTMLInputElement;
    expect(minimo.value).toBe("30");
    expect(screen.getAllByText(`${RITMO_PADRAO.intervaloNova.min}–${RITMO_PADRAO.intervaloNova.max} min`).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Voltar ao recomendado: Intervalo entre conversas novas" }));
    expect((screen.getByLabelText("Chip em rampa (mínimo)") as HTMLInputElement).value).toBe(String(RITMO_PADRAO.intervaloNova.min));
    // A outra seção não volta: o máximo por hora continua o personalizado.
    expect((screen.getByLabelText("Mensagens por hora") as HTMLInputElement).value).toBe("20");

    respostas = (_url, metodo) =>
      metodo === "PATCH"
        ? { status: 422, corpo: { error: { message: "Dados inválidos.", details: { campos: [{ caminho: "ritmo.maxEnviosHora", mensagem: "número alto demais" }] } } } }
        : undefined;
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(escritas()).toHaveLength(1));
    expect(escritas()[0]!.corpo).toEqual({ ritmo: { intervaloNova: RITMO_PADRAO.intervaloNova } });
    expect(await screen.findByText("número alto demais")).toBeTruthy();
  });
});

describe("Modo", () => {
  it("o real exige a frase exata e, sem a segunda chave, mostra a linha do .env", async () => {
    comCliente(<ModoDoMotor modo="simulado" chaveDoServidor={false} podeTrocar />);
    fireEvent.click(screen.getByRole("button", { name: "Mudar para o envio real" }));
    const ligar = screen.getByRole("button", { name: "Ligar o envio real" }) as HTMLButtonElement;
    expect(ligar.disabled).toBe(true);
    expect(screen.getByText("DISPARO_REAL_LIBERADO=sim")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Para ligar o envio real/), { target: { value: "enviar de verdade" } });
    expect(ligar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Para ligar o envio real/), { target: { value: "ENVIAR DE VERDADE" } });
    expect(ligar.disabled).toBe(false);
    fireEvent.click(ligar);
    await waitFor(() => expect(escritas()).toEqual([{ url: "/api/v1/disparo/config", metodo: "PATCH", corpo: { modo: "real" } }]));
  });

  it("real escolhido sem a chave do servidor: a tela diz a linha do .env", () => {
    comCliente(<ModoDoMotor modo="real" chaveDoServidor={false} podeTrocar={false} />);
    expect(screen.getByText("DISPARO_REAL_LIBERADO=sim")).toBeTruthy();
    expect(screen.getByText("Só quem administra a organização troca o modo.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Primeiros passos", () => {
  const todos = { conectado: true, temChip: true, temEtapa: true, temAbertura: true, envioReal: true };

  it("some quando tudo está feito", () => {
    const { container } = render(<PrimeirosPassos passos={passosIniciais(todos)} />);
    expect(container.innerHTML).toBe("");
  });

  it("enquanto falta algo, lista os cinco passos e quantos já foram", () => {
    render(<PrimeirosPassos passos={passosIniciais({ ...todos, temEtapa: false, envioReal: false })} />);
    expect(screen.getByText("3 de 5")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Escolher a etapa dos leads/ }).getAttribute("href")).toBe("#leads");
  });
});

describe("Chips: cada botão chama a rota certa", () => {
  const chip = (p: Partial<ChipDaTela>): ChipDaTela => ({
    id: "c1", nome: "chip1", estado: "ativo", saude: "verde", dia_rampa: 4, channel_session_id: "s1", tem_canal: true, pausado_ate: null,
    proximo_envio_em: null, ultimo_envio_em: null, envios_hoje: 0, teto_hoje: 40, saude_motivo: null, saude_do_dia: null, ...p,
  });
  const conexao = (id: string, status = "WORKING") => ({
    id, waha_session_name: id, display_name: `Número ${id}`, phone_number: null, status, status_reason: null, last_health_check_at: null,
    last_status_change_at: null, daily_message_limit: 100, is_warmup_complete: null, created_at: "2026-11-01T00:00:00Z",
  });

  it("pausar, retomar, retirar (com confirmação) e usar no motor", async () => {
    comCliente(
      <ChipsEditor
        chips={[chip({}), chip({ id: "c2", nome: "chip2", estado: "pausado", channel_session_id: "s2" })]}
        conexoes={[conexao("s1"), conexao("s2"), conexao("s3"), conexao("s4", "FAILED")]}
        podeEditar
      />,
    );
    fireEvent.click(within(screen.getByRole("listitem", { name: "chip1" })).getByRole("button", { name: "Pausar" }));
    await waitFor(() => expect(escritas()).toHaveLength(1));
    expect(escritas()[0]).toMatchObject({ url: "/api/v1/disparo/chips/c1", metodo: "PATCH", corpo: { acao: "pausar" } });

    fireEvent.click(within(screen.getByRole("listitem", { name: "chip2" })).getByRole("button", { name: "Retomar" }));
    await waitFor(() => expect(escritas()).toHaveLength(2));
    expect(escritas()[1]).toMatchObject({ url: "/api/v1/disparo/chips/c2", metodo: "PATCH", corpo: { acao: "retomar" } });

    fireEvent.click(within(screen.getByRole("listitem", { name: "chip1" })).getByRole("button", { name: "Retirar" }));
    expect(escritas()).toHaveLength(2); // primeiro só pede confirmação
    fireEvent.click(screen.getByRole("button", { name: "Confirmar: tirar do motor" }));
    await waitFor(() => expect(escritas()).toHaveLength(3));
    expect(escritas()[2]).toMatchObject({ url: "/api/v1/disparo/chips/c1", metodo: "DELETE" });

    // s1 e s2 já estão no motor; s4 caiu: só s3 pode entrar.
    const usar = screen.getAllByRole("button", { name: "Usar no motor" });
    expect(usar).toHaveLength(1);
    fireEvent.click(usar[0]!);
    await waitFor(() => expect(escritas()).toHaveLength(4));
    expect(escritas()[3]).toMatchObject({ url: "/api/v1/disparo/chips", metodo: "POST", corpo: { channel_session_id: "s3" } });
  });

  it("sem permissão de editar, nenhum botão", () => {
    comCliente(<ChipsEditor chips={[chip({})]} conexoes={[conexao("s3")]} podeEditar={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
