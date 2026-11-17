/**
 * A tela Configurações › Personalizar: o que cada PAPEL vê, e o que os controles
 * mandam para as Server Actions.
 *
 * Roda a página de servidor de verdade (`await PersonalizarPage()`) com a sessão,
 * a personalização gravada, as actions e o bloco da marca substituídos — o que se
 * prova é a decisão de desenhar (papel, interface do vínculo, o que está oculto)
 * e o contrato com as actions, não o Postgres.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Role } from "@/lib/auth/types";
import type { InterfaceSettings } from "@/lib/navigation/interface";
import type { PersonalizacaoDaBarra } from "@/lib/navigation/personalizar";

// `vi.mock` é içado acima dos `const`: o que as fábricas leem na carga do módulo vem de `vi.hoisted`.
const { refresh, toast, updateMinhaBarra, updateNomesDaBarra, carregar } = vi.hoisted(() => ({
  carregar: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  updateMinhaBarra: vi.fn(async (_: unknown) => ({ ok: true }) as { ok: boolean; error?: string }),
  updateNomesDaBarra: vi.fn(
    async (_: unknown) => ({ ok: true }) as { ok: boolean; error?: string },
  ),
}));

let papel: Role = "viewer";
let platformAdmin = false;
let interfaceDoVinculo: InterfaceSettings | undefined;
let gravada: PersonalizacaoDaBarra = {};
let suporte: { id: string; access_mode: string } | null = null;

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh }),
  usePathname: () => "/app/settings/personalizar",
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/actions/settings/updateMinhaBarra", () => ({ updateMinhaBarra }));
vi.mock("@/app/actions/settings/updateNomesDaBarra", () => ({ updateNomesDaBarra }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({
    id: "u1",
    idioma: "pt-BR",
    is_platform_admin: platformAdmin,
    support: suporte,
  }),
  resolveActiveOrg: async () => ({
    orgId: "org-1",
    name: "Org",
    role: papel,
    interface_settings: interfaceDoVinculo,
  }),
}));
vi.mock("@/lib/navigation/personalizar-carregar", () => ({
  carregarPersonalizacaoDaBarra: carregar,
}));
vi.mock("../marca/_bloco", () => ({
  BlocoDaMarcaDaOrganizacao: ({ orgId }: { orgId: string }) => (
    <div data-testid="bloco-da-marca">{orgId}</div>
  ),
}));

import PersonalizarPage from "./page";

async function abrir() {
  render(await PersonalizarPage());
}

const interruptor = (nome: string) => screen.getByRole("switch", { name: `Mostrar ${nome}` });

beforeEach(() => {
  papel = "viewer";
  platformAdmin = false;
  interfaceDoVinculo = undefined;
  gravada = {};
  suporte = null;
  carregar.mockReset();
  carregar.mockImplementation(async () => gravada);
  refresh.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  updateMinhaBarra.mockClear();
  updateNomesDaBarra.mockClear();
});
afterEach(cleanup);

describe("os blocos por papel", () => {
  it("⭐ viewer, agent e manager veem só 'Sua barra'", async () => {
    for (const p of ["viewer", "agent", "manager"] as Role[]) {
      papel = p;
      await abrir();
      expect(screen.getByRole("heading", { name: "Sua barra" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Nomes dos tópicos" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Marca da empresa" })).toBeNull();
      expect(screen.queryByTestId("bloco-da-marca")).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      cleanup();
    }
  });

  it("admin vê os três blocos, e o da marca recebe a organização da sessão", async () => {
    papel = "admin";
    await abrir();
    expect(screen.getByRole("heading", { name: "Sua barra" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Nomes dos tópicos" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Marca da empresa" })).toBeTruthy();
    expect(screen.getByTestId("bloco-da-marca").textContent).toBe("org-1");
  });

  it("platform admin também vê os blocos de administração", async () => {
    papel = "viewer";
    platformAdmin = true;
    await abrir();
    expect(screen.getByRole("heading", { name: "Nomes dos tópicos" })).toBeTruthy();
  });

  it("o bloco 'Sua barra' lista os blocos da barra, com título, na ordem dela", async () => {
    papel = "admin";
    await abrir();
    const secao = screen.getByRole("region", { name: "Sua barra" });
    expect(
      within(secao)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Dia a dia", "Prospecção", "Gestão"]);
    expect(within(secao).getAllByRole("switch").length).toBeGreaterThan(10);
  });

  it("a restrição do admin vale aqui: o que o vínculo não tem nem aparece", async () => {
    papel = "admin";
    interfaceDoVinculo = { preset: "completa", destinos: ["/app/inbox", "/app/kanban"] };
    await abrir();
    expect(interruptor("Inbox")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Mostrar Leads" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Mostrar Disparo" })).toBeNull();
  });

  it("o papel também: agent não vê Disparo", async () => {
    papel = "agent";
    await abrir();
    expect(screen.queryByRole("switch", { name: "Mostrar Disparo" })).toBeNull();
    expect(interruptor("Inbox")).toBeTruthy();
  });
});

describe("Sua barra — controles", () => {
  it("⭐ Configurações aparece travada: sem interruptor e sem subir ou descer", async () => {
    await abrir();
    expect(screen.queryByRole("switch", { name: "Mostrar Configurações" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Subir Configurações" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Descer Configurações" })).toBeNull();
    expect(screen.getByText("Sempre visível")).toBeTruthy();
  });

  it("o que está oculto vem desligado, e o resto ligado", async () => {
    gravada = { preferencias: { ocultos: ["/app/leads"], ordem: [] } };
    await abrir();
    expect(interruptor("Leads").getAttribute("aria-checked")).toBe("false");
    expect(interruptor("Inbox").getAttribute("aria-checked")).toBe("true");
  });

  it("todo botão e todo interruptor tem nome acessível", async () => {
    papel = "admin";
    await abrir();
    for (const el of [...screen.getAllByRole("button"), ...screen.getAllByRole("switch")]) {
      expect(el.getAttribute("aria-label") || el.textContent?.trim(), el.outerHTML).toBeTruthy();
    }
  });

  it("subir e descer têm aria-label por tópico, e as pontas ficam desligadas", async () => {
    await abrir();
    expect(
      (screen.getByRole("button", { name: "Subir Início" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Subir Inbox" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // O último movível do bloco de Gestão é Produtos: depois dele vem Configurações, travada.
    expect(
      (screen.getByRole("button", { name: "Descer Produtos" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("⭐ Salvar manda ocultos e a ordem completa, e atualiza a barra", async () => {
    await abrir();
    const salvar = screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    expect(salvar.disabled).toBe(true); // nada mudou ainda

    fireEvent.click(interruptor("Leads"));
    fireEvent.click(screen.getByRole("button", { name: "Subir Agenda" }));
    expect(salvar.disabled).toBe(false);
    fireEvent.click(salvar);

    await waitFor(() => expect(updateMinhaBarra).toHaveBeenCalledTimes(1));
    const enviado = updateMinhaBarra.mock.calls[0]![0] as { ocultos: string[]; ordem: string[] };
    expect(enviado.ocultos).toEqual(["/app/leads"]);
    // Agenda subiu uma posição (de último para penúltimo) no bloco do dia a dia.
    expect(enviado.ordem.slice(0, 7)).toEqual([
      "/app/inicio",
      "/app/inbox",
      "/app/kanban",
      "/app/leads",
      "/app/contacts",
      "/app/agenda",
      "/app/tasks",
    ]);
    // Configurações vai na ordem (por último no bloco) e nunca nos ocultos.
    expect(enviado.ordem).toContain("grupo:organizacao");
    expect(enviado.ocultos).not.toContain("grupo:organizacao");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalled();
  });

  it("Restaurar padrão só liga com escolha gravada, e manda null", async () => {
    await abrir();
    expect(
      (screen.getByRole("button", { name: "Restaurar padrão" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    gravada = { preferencias: { ocultos: ["/app/leads"], ordem: [] } };
    await abrir();
    const botao = screen.getByRole("button", { name: "Restaurar padrão" }) as HTMLButtonElement;
    expect(botao.disabled).toBe(false);
    fireEvent.click(botao);
    await waitFor(() => expect(updateMinhaBarra).toHaveBeenCalledWith(null));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("recusa da action vira aviso de erro e NÃO atualiza a barra", async () => {
    updateMinhaBarra.mockResolvedValueOnce({ ok: false, error: "nao_gravou" });
    await abrir();
    fireEvent.click(interruptor("Leads"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("Nomes dos tópicos (admin)", () => {
  beforeEach(() => {
    papel = "admin";
  });

  it("um campo por linha de topo, com o nome de fábrica de placeholder e limite de 40", async () => {
    await abrir();
    const caixa = screen.getByRole("textbox", { name: "Inbox" }) as HTMLInputElement;
    expect(caixa.placeholder).toBe("Inbox");
    expect(caixa.maxLength).toBe(40);
    expect(caixa.value).toBe("");
    expect(screen.getByRole("textbox", { name: "Agente de IA" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Configurações" })).toBeTruthy();
  });

  it("mostra o nome já gravado, e a barra de 'Sua barra' o usa como rótulo", async () => {
    gravada = { nomes: { "/app/inbox": "Conversas" } };
    await abrir();
    expect((screen.getByRole("textbox", { name: "Inbox" }) as HTMLInputElement).value).toBe(
      "Conversas",
    );
    expect(screen.getByRole("switch", { name: "Mostrar Conversas" })).toBeTruthy();
  });

  it("⭐ Salvar nomes corta os espaços, ignora campo vazio e preserva o nome de linha que o admin não enxerga", async () => {
    interfaceDoVinculo = { preset: "completa", destinos: ["/app/inbox", "/app/kanban"] };
    gravada = { nomes: { "/app/leads": "Clientes" } }; // /app/leads não está na interface deste admin
    await abrir();
    expect(screen.queryByRole("textbox", { name: "Leads" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Inbox" }), {
      target: { value: "  Atendimento  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar nomes" }));

    await waitFor(() => expect(updateNomesDaBarra).toHaveBeenCalledTimes(1));
    expect(updateNomesDaBarra).toHaveBeenCalledWith({
      "/app/leads": "Clientes",
      "/app/inbox": "Atendimento",
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("Salvar nomes só liga depois de mudar; Restaurar nomes só liga com nome gravado e manda null", async () => {
    await abrir();
    expect(
      (screen.getByRole("button", { name: "Salvar nomes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Restaurar nomes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    gravada = { nomes: { "/app/inbox": "Conversas" } };
    await abrir();
    fireEvent.click(screen.getByRole("button", { name: "Restaurar nomes" }));
    await waitFor(() => expect(updateNomesDaBarra).toHaveBeenCalledWith(null));
  });

  it("recusa da action vira aviso de erro", async () => {
    updateNomesDaBarra.mockResolvedValueOnce({ ok: false, error: "forbidden_role" });
    await abrir();
    fireEvent.change(screen.getByRole("textbox", { name: "Inbox" }), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar nomes" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("modo suporte (a pessoa da plataforma dentro da organização do cliente)", () => {
  beforeEach(() => {
    papel = "admin"; // suporte "full" vira admin em resolveActiveOrg
    suporte = { id: "s1", access_mode: "full" };
    gravada = {
      nomes: {
        "/app/inbox": "Conversas",
        "/app/leads": "Clientes",
        "/app/rota-que-saiu": "Fantasma",
      },
    };
  });

  it("⭐ lê a personalização pela organização, sem id de pessoa (não há vínculo próprio)", async () => {
    await abrir();
    expect(carregar).toHaveBeenCalledWith(null, "org-1");
  });

  it("⭐ mostra os nomes que a organização já gravou", async () => {
    await abrir();
    expect((screen.getByRole("textbox", { name: "Inbox" }) as HTMLInputElement).value).toBe(
      "Conversas",
    );
    expect((screen.getByRole("textbox", { name: "Leads" }) as HTMLInputElement).value).toBe(
      "Clientes",
    );
  });

  it("⭐ esconde 'Sua barra': não há linha da pessoa naquela organização para gravar", async () => {
    await abrir();
    expect(screen.queryByRole("heading", { name: "Sua barra" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("heading", { name: "Nomes dos tópicos" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Marca da empresa" })).toBeTruthy();
  });

  it("⭐ salvar os nomes em suporte full NÃO perde nenhuma chave já gravada", async () => {
    await abrir();
    fireEvent.change(screen.getByRole("textbox", { name: "Agenda" }), {
      target: { value: "Marcações" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar nomes" }));
    await waitFor(() => expect(updateNomesDaBarra).toHaveBeenCalledTimes(1));
    expect(updateNomesDaBarra).toHaveBeenCalledWith({
      "/app/inbox": "Conversas",
      "/app/leads": "Clientes",
      "/app/rota-que-saiu": "Fantasma",
      "/app/agenda": "Marcações",
    });
  });
});

describe("Sua barra — o que não aparece agora não se perde ao salvar", () => {
  it("⭐ ocultos e ordem de linhas fora da interface do vínculo voltam no envio; chave que saiu do catálogo, não", async () => {
    papel = "admin";
    interfaceDoVinculo = { preset: "completa", destinos: ["/app/inbox", "/app/kanban"] };
    gravada = {
      preferencias: {
        ocultos: ["/app/leads", "/app/rota-que-saiu"],
        ordem: ["/app/agenda", "/app/inbox", "grupo:fantasma"],
      },
    };
    await abrir();
    expect(screen.queryByRole("switch", { name: "Mostrar Leads" })).toBeNull();
    fireEvent.click(interruptor("Funis"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(updateMinhaBarra).toHaveBeenCalledTimes(1));
    const enviado = updateMinhaBarra.mock.calls[0]![0] as { ocultos: string[]; ordem: string[] };
    expect(enviado.ocultos).toEqual(["/app/kanban", "/app/leads"]);
    expect(enviado.ordem).toEqual([
      "/app/inbox",
      "/app/kanban",
      "grupo:organizacao",
      "/app/agenda",
    ]);
  });
});

describe("Sua barra — foco e aviso", () => {
  it("⭐ o foco não se perde quando subir chega ao topo: vai para o botão descer da mesma linha", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("button", { name: "Subir Inbox" }));
    expect(
      (screen.getByRole("button", { name: "Subir Inbox" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Descer Inbox" }));
  });

  it("o foco não se perde quando descer chega à ponta (antes de Configurações): vai para o botão subir", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("button", { name: "Descer Análise" }));
    expect(
      (screen.getByRole("button", { name: "Descer Análise" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Subir Análise" }));
  });

  it("enquanto o botão segue habilitado, o foco fica nele", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("button", { name: "Descer Início" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Descer Início" }));
  });

  it("⭐ avisa que ocultar uma linha oculta também o submenu dela", async () => {
    await abrir();
    expect(screen.getByText(/oculta também o submenu dela/i)).toBeTruthy();
  });
});
