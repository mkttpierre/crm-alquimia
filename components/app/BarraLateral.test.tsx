/**
 * A barra lateral do protótipo A. O que estes testes prendem:
 *
 *  - os três blocos na ordem do protótipo (sem título → Prospecção → Gestão),
 *    com os itens do dia a dia na ordem combinada;
 *  - o submenu de Configurações é o INVENTÁRIO do grupo no catálogo (nenhuma
 *    tela de Configurações ficou sem porta ao sair do hub para a barra);
 *  - a regra de papel continua a do catálogo: `agent` não vê Disparo nem
 *    Conexões, e uma subpágina permitida não some junto com a linha proibida;
 *  - NENHUM destino do catálogo sumiu: tudo tem linha ou submenu, e a exceção
 *    está escrita em `FORA_DA_BARRA`.
 *
 * Quem-vê-o-quê é regra do registro (`navegacao-registry.test.ts`); aqui é a
 * superfície e a projeção da barra.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BarraLateral, ConteudoDaBarra } from "@/components/app/BarraLateral";
import type { ActiveOrg, AuthUser, Role } from "@/lib/auth/types";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { canSee, type InterfaceSettings } from "@/lib/navigation/interface";
import { CHAVE_TRAVADA, type PersonalizacaoDaBarra } from "@/lib/navigation/personalizar";
import {
  barraLateral,
  FORA_DA_BARRA,
  FORA_DO_SUBMENU,
  hubSections,
  NAV_DESTINATIONS,
  NAV_GROUPS,
  searchable,
} from "@/lib/navigation/registry";

const authRef: { user: AuthUser; activeOrg: ActiveOrg | null } = {
  user: {
    id: "u1",
    email: "ana@exemplo.test",
    full_name: "Ana Prado",
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: "org-1", organization_name: "Org", role: "admin" }],
  } as unknown as AuthUser,
  activeOrg: null,
};

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ ...authRef, signOut: vi.fn() }) }));
const { refresh, push, caminho, minha, nomes, toast } = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  caminho: { atual: "/app/settings/marca" },
  minha: vi.fn(),
  nomes: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => caminho.atual,
  useRouter: () => ({ refresh, push }),
}));
vi.mock("@/app/actions/settings/updateMinhaBarra", () => ({ updateMinhaBarra: minha }));
vi.mock("@/app/actions/settings/updateNomesDaBarra", () => ({ updateNomesDaBarra: nomes }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));
vi.mock("@/hooks/team/useAttendants", () => ({
  useAttendants: () => ({
    data: {
      data: [
        {
          user_id: "a",
          name: "Carla Dias",
          email: "c@x.test",
          is_available: false,
          current_load: 0,
        },
        {
          user_id: "b",
          name: "Bruno Lima",
          email: "b@x.test",
          is_available: true,
          current_load: 3,
        },
      ],
    },
  }),
}));

// Agentes externos: entram na mesma lista, depois das pessoas; revogado não aparece.
vi.mock("@/hooks/team/useAgentesExternos", () => ({
  useAgentesExternos: () => ({
    data: {
      agentes: [
        { id: "g1", nome: "Head", tipo: "openbot", online: true, ultima_acao: "crm_disparo_pausar_chip", revogado_em: null },
        { id: "g2", nome: "Velho", tipo: "codex", online: false, ultima_acao: null, revogado_em: "2026-11-01T00:00:00Z" },
      ],
    },
  }),
}));

function comoPapel(role: Role) {
  authRef.activeOrg = { orgId: "org-1", name: "Org", role } as ActiveOrg;
}

function renderBarra() {
  return render(<BarraLateral escondida={false} marcaPropria={false} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  caminho.atual = "/app/settings/marca";
  minha.mockResolvedValue({ ok: true });
  nomes.mockResolvedValue({ ok: true });
  authRef.user = {
    ...authRef.user,
    support: undefined,
    is_platform_admin: false,
    organizations: [{ organization_id: "org-1", organization_name: "Org", role: "admin" }],
  } as unknown as AuthUser;
});
afterEach(cleanup);

describe("BarraLateral", () => {
  it("os três blocos, na ordem do protótipo", () => {
    comoPapel("admin");
    renderBarra();
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(
      within(nav)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Prospecção", "Gestão"]);
    expect(within(nav).getAllByRole("region")).toHaveLength(3);

    const [diaADia, prospeccao, gestao] = within(nav).getAllByRole("region");
    expect(diaADia!.getAttribute("aria-label")).toBe("Dia a dia");
    expect(
      within(diaADia!)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Início", "Inbox", "Funis", "Leads", "Contatos", "Tarefas", "Agenda"]);
    expect(
      within(prospeccao!)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Disparo", "Conexões", "Atalhos"]);
    // Agente de IA, Análise e Configurações abrem submenu; Produtos é link.
    const linhasDeGestao = within(gestao!)
      .getAllByRole("listitem")
      .filter((li) => li.parentElement?.parentElement === gestao)
      .map((li) => li.querySelector("button, a")?.textContent);
    expect(linhasDeGestao).toEqual(["Agente de IA", "Análise", "Produtos", "Configurações"]);
  });

  it("Equipe agora mostra quem atende, online primeiro, com a carga ou 'ausente'", () => {
    comoPapel("admin");
    renderBarra();
    const equipe = screen.getByRole("region", { name: "Equipe agora" });
    const linhas = within(equipe)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(linhas[0]).toContain("Bruno");
    expect(linhas[0]).toContain("3 conversas");
    expect(linhas[1]).toContain("Carla");
    expect(linhas[1]).toContain("ausente");
    // O agente externo vem depois das pessoas, online, com a última ação no lugar da carga.
    expect(linhas[2]).toContain("Head");
    expect(linhas[2]).toContain("crm_disparo_pausar_chip");
    expect(linhas).toHaveLength(3);
  });

  it("o submenu de Configurações lista os destinos do catálogo, e abre sozinho na tela de dentro dele", () => {
    comoPapel("admin");
    renderBarra();
    // A rota atual (/app/settings/marca) é de Configurações: o submenu já nasce aberto.
    const botao = screen.getByRole("button", { name: /Configurações/ });
    expect(botao.getAttribute("aria-expanded")).toBe("true");
    const sub = document.getElementById(botao.getAttribute("aria-controls")!)!;
    // Personalizar tem o botão do rodapé: fora do submenu, mas no hub de Configurações e no ⌘K.
    const esperados = [
      "Visão geral",
      ...NAV_DESTINATIONS.filter(
        (d) => d.group === "organizacao" && canSee(d, false, "admin") && !(d.href in FORA_DO_SUBMENU),
      ).map((d) => d.label),
    ];
    expect(
      within(sub)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(esperados);
    expect(within(sub).getByRole("link", { name: "Marca" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(sub).queryByRole("link", { name: "Personalizar" })).toBeNull();
    // e fecha no clique
    fireEvent.click(botao);
    expect(botao.getAttribute("aria-expanded")).toBe("false");
  });

  it("item sem permissão some para agent", () => {
    comoPapel("agent");
    renderBarra();
    expect(screen.queryByRole("link", { name: "Disparo" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Conexões" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Webhooks" })).toBeNull();
    expect(screen.getByRole("link", { name: "Atalhos" })).toBeTruthy();
    // Configurações continua (Perfil e Segurança são de todos), mas sem as telas de admin.
    // A rota (/app/settings/marca) cai na visão geral de Configurações para ele: o submenu já abre.
    expect(
      screen.getByRole("button", { name: /Configurações/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("link", { name: "Perfil" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Marca" })).toBeNull();
    expect(screen.queryByRole("link", { name: "API Tokens" })).toBeNull();
  });
});

describe("BarraLateral — personalização (Configurações › Personalizar)", () => {
  function comPersonalizacao(role: Role, barra: PersonalizacaoDaBarra) {
    authRef.activeOrg = { orgId: "org-1", name: "Org", role, barra } as ActiveOrg;
  }
  const linksDe = (idx: number) => {
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    return within(within(nav).getAllByRole("region")[idx]!)
      .getAllByRole("link")
      .map((a) => a.textContent);
  };

  it("tópico oculto some da barra, e a ordem pessoal vale dentro do bloco", () => {
    comPersonalizacao("admin", {
      preferencias: { ocultos: ["/app/leads"], ordem: ["/app/agenda", "/app/tasks"] },
    });
    renderBarra();
    expect(linksDe(0)).toEqual(["Agenda", "Tarefas", "Início", "Inbox", "Funis", "Contatos"]);
  });

  it("⭐ Configurações continua na barra mesmo com a escolha de ocultá-la gravada", () => {
    comPersonalizacao("admin", { preferencias: { ocultos: ["grupo:organizacao", "/app/products"], ordem: [] } });
    renderBarra();
    expect(screen.getByRole("button", { name: /Configurações/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Produtos" })).toBeNull();
  });

  it("nome dado pelo admin aparece como foi escrito, e não passa pela tradução", () => {
    // "Salvar" tem tradução ("Guardar"): se o nome próprio passasse por t(), sairia "Guardar".
    comPersonalizacao("admin", { nomes: { "/app/inicio": "Salvar" } });
    render(
      <IdiomaProvider locale="es">
        <BarraLateral escondida={false} marcaPropria={false} />
      </IdiomaProvider>,
    );
    expect(screen.getByRole("link", { name: "Salvar" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Guardar" })).toBeNull();
    // e o que NÃO foi renomeado continua traduzido
    expect(screen.getByRole("link", { name: "Contactos" })).toBeTruthy();
  });

  it("nome dado a uma linha de grupo vira o texto do botão e o rótulo da seta", () => {
    comPersonalizacao("admin", { nomes: { "grupo:ia": "Robôs", "/app/kanban": "Vendas" } });
    renderBarra();
    expect(screen.getByRole("button", { name: /Robôs/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Agente de IA/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Mais em Vendas" })).toBeTruthy();
  });

  it("sem personalização a barra é a de sempre", () => {
    comoPapel("admin");
    renderBarra();
    expect(linksDe(0)).toEqual(["Início", "Inbox", "Funis", "Leads", "Contatos", "Tarefas", "Agenda"]);
  });
});

describe("Personalizar: fora do submenu, mas a tela segue alcançável", () => {
  it("segue no hub de Configurações e na busca (⌘K), para qualquer papel", () => {
    for (const papel of ["viewer", "agent", "admin"] as const) {
      const noHub = hubSections("organizacao", false, papel).flatMap((x) =>
        x.items.map((i) => i.href),
      );
      expect(noHub, papel).toContain("/app/settings/personalizar");
      expect(
        searchable(false, papel).map((d) => d.href),
        papel,
      ).toContain("/app/settings/personalizar");
    }
  });

  it("nenhuma linha nem submenu da barra aponta para ela; só o botão do rodapé", () => {
    const na = barraLateral(true, null).flatMap((s) =>
      s.itens.flatMap((i) => [i.href, ...i.submenu.map((x) => x.href)]),
    );
    expect(na).not.toContain("/app/settings/personalizar");
  });
});

describe("BarraLateral — modo personalização", () => {
  const GRUPO = "Personalizando a barra";
  const grupo = () => screen.getByRole("group", { name: GRUPO });
  const chaves = () =>
    within(grupo())
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-chave"))
      .filter((c): c is string => !!c);
  const linha = (chave: string) => grupo().querySelector<HTMLElement>(`[data-chave="${chave}"]`)!;
  const clicar = (nome: string | RegExp) =>
    fireEvent.click(screen.getByRole("button", { name: nome }));
  const entrar = () => clicar("Personalizar");
  const PADRAO = [
    "/app/inicio",
    "/app/inbox",
    "/app/kanban",
    "/app/leads",
    "/app/contacts",
    "/app/tasks",
    "/app/agenda",
  ];
  const diaADia = () => {
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    return within(within(nav).getAllByRole("region")[0]!)
      .getAllByRole("link")
      .map((a) => a.textContent);
  };
  const DIA_A_DIA_PADRAO = ["Início", "Inbox", "Funis", "Leads", "Contatos", "Tarefas", "Agenda"];
  function como(role: Role, barra: PersonalizacaoDaBarra = {}) {
    authRef.activeOrg = { orgId: "org-1", name: "Org", role, barra } as ActiveOrg;
  }

  it("o botão Personalizar é um ícone (lápis) NA LINHA do usuário, com rótulo e dica; o modo está desligado", () => {
    como("admin");
    renderBarra();
    const botao = screen.getByRole("button", { name: "Personalizar" });
    const usuario = screen.getByRole("button", { name: "Menu do usuário" });
    // Mesma linha: o rodapé não ganha uma linha própria (achado 2 da revisão).
    expect(botao.parentElement).toBe(usuario.parentElement);
    expect(botao.getAttribute("title")).toBe("Personalizar a barra");
    // Só ícone: o rótulo acessível não aparece como texto.
    expect(botao.textContent).toBe("");
    expect(screen.queryByRole("group", { name: GRUPO })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Navegação principal" })).toBeTruthy();
  });

  // Achado 3: o botão não depende da interface do vínculo, para NENHUM dos 4 papéis.
  const INTERFACES: Array<[string, InterfaceSettings | undefined]> = [
    ["completa (padrão)", undefined],
    ["simplificada", { preset: "simplificada" }],
    ["lista de destinos", { preset: "completa", destinos: ["/app/inbox", "/app/kanban"] }],
  ];
  const PAPEIS: Role[] = ["viewer", "agent", "manager", "admin"];
  it.each(INTERFACES.flatMap(([i, s]) => PAPEIS.map((p) => [i, p, s] as const)))(
    "interface %s, papel %s: o botão Personalizar segue lá e abre o modo",
    (_nome, role, settings) => {
      authRef.activeOrg = { orgId: "org-1", name: "Org", role, interface_settings: settings } as ActiveOrg;
      renderBarra();
      expect(screen.getByRole("button", { name: "Personalizar" })).toBeTruthy();
      entrar();
      expect(screen.getByRole("group", { name: GRUPO })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Concluir" })).toBeTruthy();
    },
  );

  it("entra no modo: a navegação dá lugar à edição, com Concluir, Cancelar e Mais opções", () => {
    como("admin");
    renderBarra();
    entrar();
    expect(screen.queryByRole("navigation", { name: "Navegação principal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Personalizar" })).toBeNull();
    expect(chaves().slice(0, 7)).toEqual(PADRAO);
    expect(screen.getByRole("button", { name: "Concluir" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mais opções" }).getAttribute("href")).toBe(
      "/app/settings/personalizar",
    );
  });

  it("Cancelar sai do modo e desfaz tudo o que foi mexido, sem gravar nada", () => {
    como("admin");
    renderBarra();
    entrar();
    clicar("Remover Leads");
    clicar("Descer Início");
    clicar("Cancelar");
    expect(screen.queryByRole("group", { name: GRUPO })).toBeNull();
    expect(diaADia()).toEqual(DIA_A_DIA_PADRAO);
    expect(minha).not.toHaveBeenCalled();
    expect(nomes).not.toHaveBeenCalled();
    // voltar ao modo recomeça do que a barra mostra
    entrar();
    expect(chaves().slice(0, 7)).toEqual(PADRAO);
  });

  it("remover tira o tópico da lista e o põe em Adicionar; um clique devolve ao mesmo lugar", () => {
    como("admin");
    renderBarra();
    entrar();
    expect(screen.queryByRole("region", { name: "Adicionar" })).toBeNull();
    clicar("Remover Leads");
    expect(chaves()).not.toContain("/app/leads");
    const adicionar = screen.getByRole("region", { name: "Adicionar" });
    expect(within(adicionar).getByText("Leads")).toBeTruthy();
    fireEvent.click(within(adicionar).getByRole("button", { name: "Adicionar Leads" }));
    expect(chaves().slice(0, 7)).toEqual(PADRAO);
    expect(screen.queryByRole("region", { name: "Adicionar" })).toBeNull();
  });

  it("subir e descer por botões; as pontas ficam desabilitadas; Configurações não se move nem sai", () => {
    como("admin");
    renderBarra();
    entrar();
    expect(
      (screen.getByRole("button", { name: "Subir Início" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    clicar("Descer Início");
    expect(chaves().slice(0, 3)).toEqual(["/app/inbox", "/app/inicio", "/app/kanban"]);
    clicar("Subir Agenda");
    expect(chaves().slice(4, 7)).toEqual(["/app/contacts", "/app/agenda", "/app/tasks"]);
    // o último do bloco de gestão não desce por cima de Configurações
    expect(
      (screen.getByRole("button", { name: "Descer Produtos" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Configurações: sem remover, subir nem descer, e sempre por último no bloco
    for (const acao of ["Remover", "Subir", "Descer"])
      expect(screen.queryByRole("button", { name: `${acao} Configurações` })).toBeNull();
    expect(chaves().at(-1)).toBe(CHAVE_TRAVADA);
  });

  it("arrastar muda a ordem dentro do bloco, e soltar em outro bloco não faz nada", () => {
    como("admin");
    renderBarra();
    entrar();
    const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(linha("/app/inicio"), { dataTransfer });
    fireEvent.dragOver(linha("/app/contacts"), { dataTransfer });
    fireEvent.drop(linha("/app/contacts"), { dataTransfer });
    fireEvent.dragEnd(linha("/app/inicio"), { dataTransfer });
    expect(chaves().slice(0, 5)).toEqual([
      "/app/inbox",
      "/app/kanban",
      "/app/leads",
      "/app/contacts",
      "/app/inicio",
    ]);
    // outro bloco: ignorado
    fireEvent.dragStart(linha("/app/inbox"), { dataTransfer });
    fireEvent.drop(linha("/app/disparo"), { dataTransfer });
    expect(chaves().slice(0, 2)).toEqual(["/app/inbox", "/app/kanban"]);
    // Configurações não é arrastável
    expect(linha(CHAVE_TRAVADA).getAttribute("draggable")).toBe("false");
    expect(linha("/app/inbox").getAttribute("draggable")).toBe("true");
  });

  it("só o admin renomeia: o nome vira campo, Enter confirma, vazio volta ao padrão", () => {
    como("admin");
    renderBarra();
    entrar();
    clicar("Renomear Inbox");
    const campo = screen.getByRole("textbox", { name: "Nome do tópico" }) as HTMLInputElement;
    expect(campo.maxLength).toBe(40);
    expect(campo.value).toBe("Inbox");
    fireEvent.change(campo, { target: { value: "  Conversas " } });
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(within(linha("/app/inbox")).getByText("Conversas")).toBeTruthy();
    // vazio volta ao padrão
    clicar("Renomear Conversas");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(within(linha("/app/inbox")).getByText("Inbox")).toBeTruthy();
    // Escape descarta
    clicar("Renomear Inbox");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Outra" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(within(linha("/app/inbox")).getByText("Inbox")).toBeTruthy();
    // Configurações também se renomeia (a tela de Personalizar já deixava)
    expect(screen.getByRole("button", { name: "Renomear Configurações" })).toBeTruthy();
  });

  it("quem não é admin não renomeia, só remove e reordena", () => {
    como("agent");
    renderBarra();
    entrar();
    expect(screen.queryByRole("button", { name: /^Renomear/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Remover Inbox" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descer Inbox" })).toBeTruthy();
  });

  it("Concluir sem nada mudado só sai do modo", () => {
    como("admin");
    renderBarra();
    entrar();
    clicar("Concluir");
    expect(screen.queryByRole("group", { name: GRUPO })).toBeNull();
    expect(minha).not.toHaveBeenCalled();
    expect(nomes).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Concluir grava a preferência com o payload da tela, preservando o que a barra não mostra", async () => {
    // Disparo é de `manager`: o agent não o vê, mas a escolha gravada dele não pode se perder.
    como("agent", { preferencias: { ocultos: ["/app/disparo"], ordem: ["/app/disparo"] } });
    renderBarra();
    entrar();
    clicar("Remover Leads");
    clicar("Concluir");
    await waitFor(() => expect(minha).toHaveBeenCalledTimes(1));
    const enviado = minha.mock.calls[0]![0] as { ocultos: string[]; ordem: string[] };
    expect(enviado.ocultos).toEqual(["/app/leads", "/app/disparo"]);
    expect(enviado.ordem[0]).toBe("/app/inicio");
    expect(enviado.ordem).toContain(CHAVE_TRAVADA);
    expect(enviado.ordem.at(-1)).toBe("/app/disparo");
    // Configurações nunca vai em ocultos
    expect(enviado.ocultos).not.toContain(CHAVE_TRAVADA);
    // os nomes não mudaram: a action do admin nem roda
    expect(nomes).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("Sua barra foi salva.");
  });

  it("Concluir grava os nomes do admin (com os já gravados que a barra não lista) e só eles", async () => {
    como("admin", { nomes: { "/app/inicio": "Painel", "/app/fora-da-barra": "Guardado" } });
    renderBarra();
    entrar();
    clicar("Renomear Inbox");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Conversas" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    clicar("Concluir");
    await waitFor(() => expect(nomes).toHaveBeenCalledTimes(1));
    expect(nomes).toHaveBeenCalledWith({
      "/app/fora-da-barra": "Guardado",
      "/app/inicio": "Painel",
      "/app/inbox": "Conversas",
    });
    expect(minha).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Os nomes foram salvos.");
  });

  it("é otimista: a barra já mostra o resultado antes da gravação responder", async () => {
    let responder!: (v: { ok: true }) => void;
    minha.mockReturnValue(new Promise((r) => (responder = r)));
    como("admin");
    renderBarra();
    entrar();
    clicar("Remover Leads");
    clicar("Concluir");
    expect(screen.queryByRole("link", { name: "Leads" })).toBeNull();
    expect(diaADia()).toEqual(["Início", "Inbox", "Funis", "Contatos", "Tarefas", "Agenda"]);
    expect(refresh).not.toHaveBeenCalled();
    responder({ ok: true });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("link", { name: "Leads" })).toBeNull();
  });

  it("se a action falha, a barra volta atrás e avisa; sem router.refresh", async () => {
    minha.mockResolvedValue({ ok: false, error: "nao_gravou" });
    como("admin");
    renderBarra();
    entrar();
    clicar("Remover Leads");
    clicar("Concluir");
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      "A alteração não chegou ao banco — nada foi mudado. Tente de novo.",
    );
    await waitFor(() => expect(diaADia()).toEqual(DIA_A_DIA_PADRAO));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falha por exceção (rede) também volta atrás", async () => {
    minha.mockRejectedValue(new Error("rede"));
    como("admin");
    renderBarra();
    entrar();
    clicar("Remover Leads");
    clicar("Concluir");
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("link", { name: "Leads" })).toBeTruthy());
  });

  it("falha só nos nomes: a ordem gravada fica, os nomes voltam", async () => {
    nomes.mockResolvedValue({ ok: false, error: "forbidden_role" });
    como("admin");
    renderBarra();
    entrar();
    clicar("Remover Leads");
    clicar("Renomear Inbox");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Conversas" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    clicar("Concluir");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Só quem administra esta empresa pode mudar os nomes."),
    );
    await waitFor(() => expect(screen.getByRole("link", { name: "Inbox" })).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Leads" })).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("em suporte não há barra própria: sem remover nem reordenar, só renomear", () => {
    como("admin");
    authRef.user = { ...authRef.user, support: { id: "s1" } } as unknown as AuthUser;
    renderBarra();
    entrar();
    expect(screen.queryByRole("button", { name: /^Remover/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Subir|Descer)/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Renomear Inbox" })).toBeTruthy();
  });

  it("na gaveta do celular é o mesmo conteúdo; Mais opções SEM mudança sai do modo e fecha a gaveta", () => {
    como("admin");
    const aoNavegar = vi.fn();
    render(<ConteudoDaBarra aoNavegar={aoNavegar} marcaPropria={false} />);
    entrar();
    fireEvent.click(screen.getByRole("link", { name: "Mais opções" }));
    expect(aoNavegar).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: GRUPO })).toBeNull();
    expect(minha).not.toHaveBeenCalled();
    expect(nomes).not.toHaveBeenCalled();
    // sem mudança o link navega sozinho: nada de push à mão
    expect(push).not.toHaveBeenCalled();
  });

  // Achado 4: o trabalho feito não se perde ao ir para a tela de Personalizar.
  it("Mais opções COM mudança pendente salva antes de navegar (mesma gravação do Concluir)", async () => {
    como("admin");
    const aoNavegar = vi.fn();
    let responder!: (v: { ok: true }) => void;
    minha.mockReturnValue(new Promise((r) => (responder = r)));
    render(<ConteudoDaBarra aoNavegar={aoNavegar} marcaPropria={false} />);
    entrar();
    clicar("Remover Leads");
    clicar("Renomear Inbox");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Conversas" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("link", { name: "Mais opções" }));
    // o modo fecha, grava, e SÓ DEPOIS da resposta navega (e fecha a gaveta)
    expect(screen.queryByRole("group", { name: GRUPO })).toBeNull();
    await waitFor(() => expect(minha).toHaveBeenCalledTimes(1));
    const enviado = minha.mock.calls[0]![0] as { ocultos: string[] };
    expect(enviado.ocultos).toEqual(["/app/leads"]);
    expect(push).not.toHaveBeenCalled();
    expect(aoNavegar).not.toHaveBeenCalled();
    responder({ ok: true });
    await waitFor(() => expect(nomes).toHaveBeenCalledTimes(1));
    expect(nomes).toHaveBeenCalledWith({ "/app/inbox": "Conversas" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/settings/personalizar"));
    expect(aoNavegar).toHaveBeenCalledTimes(1);
  });

  // Achado 5: o Escape descarta mesmo quando o navegador dispara `blur` ao tirar o campo da tela.
  it("Escape no campo de nome descarta, mesmo que o blur chegue com o valor digitado ainda à vista", () => {
    como("admin");
    renderBarra();
    entrar();
    clicar("Renomear Inbox");
    const campo = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(campo, { target: { value: "Outra" } });
    // Num navegador, o campo em foco que sai da tela dispara blur ANTES de o React trocar o
    // handler: os dois eventos chegam ao mesmo render. O jsdom não faz isso sozinho.
    act(() => {
      fireEvent.keyDown(campo, { key: "Escape" });
      fireEvent.blur(campo);
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(within(linha("/app/inbox")).getByText("Inbox")).toBeTruthy();
    // e o cancelamento não vaza para a próxima edição
    clicar("Renomear Inbox");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Conversas" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(within(linha("/app/inbox")).getByText("Conversas")).toBeTruthy();
  });

  // Achado 8: o modo não fica morto.
  it("em suporte sem poder renomear nem reordenar (papel viewer), o botão nem aparece", () => {
    como("viewer");
    authRef.user = { ...authRef.user, support: { id: "s1" } } as unknown as AuthUser;
    renderBarra();
    expect(screen.queryByRole("button", { name: "Personalizar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Menu do usuário" })).toBeTruthy();
  });

  it("dono da plataforma sem vínculo na organização: renomeia, mas não remove nem reordena", () => {
    authRef.user = {
      ...authRef.user,
      is_platform_admin: true,
      organizations: [{ organization_id: "outra-org", organization_name: "Outra", role: "admin" }],
    } as unknown as AuthUser;
    authRef.activeOrg = { orgId: "org-1", name: "Org", role: "viewer" } as ActiveOrg;
    renderBarra();
    entrar();
    expect(screen.queryByRole("button", { name: /^(Remover|Subir|Descer)/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Renomear Inbox" })).toBeTruthy();
    // a dica é só do que ele pode fazer
    expect(screen.getByText("Clique no nome para renomear.")).toBeTruthy();
    expect(screen.queryByText(/Arraste os tópicos/)).toBeNull();
  });

  it("dica: quem só reordena (não admin) não lê 'Clique no nome para renomear'", () => {
    como("agent");
    renderBarra();
    entrar();
    expect(screen.getByText("Arraste os tópicos para mudar a ordem, ou use as setas.")).toBeTruthy();
    expect(screen.queryByText(/Clique no nome/)).toBeNull();
  });

  it("dica: o admin que também reordena lê as duas", () => {
    como("admin");
    renderBarra();
    entrar();
    expect(screen.getByText(/Arraste os tópicos para mudar a ordem/)).toBeTruthy();
    expect(screen.getByText(/Clique no nome para renomear\./)).toBeTruthy();
  });

  // Achado 9: o foco do teclado nunca cai no <body>.
  describe("foco do teclado", () => {
    const focado = () => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label");

    it("ao entrar no modo, o foco vai para o primeiro controle", () => {
      como("admin");
      renderBarra();
      entrar();
      expect(focado()).toBe("Renomear Início");
      cleanup();
      como("agent");
      renderBarra();
      entrar();
      // Subir Início está desabilitado (ponta): o primeiro controle utilizável é Descer
      expect(focado()).toBe("Descer Início");
    });

    it("ao remover, o foco vai para o vizinho de baixo; sem vizinho, o de cima", () => {
      como("admin");
      renderBarra();
      entrar();
      clicar("Remover Leads");
      expect(focado()).toBe("Remover Contatos");
      clicar("Remover Agenda");
      expect(focado()).toBe("Remover Tarefas");
    });

    it("ao devolver um tópico em Adicionar, o foco vai para o 'Remover' dele", () => {
      como("admin");
      renderBarra();
      entrar();
      clicar("Remover Leads");
      clicar("Adicionar Leads");
      expect(focado()).toBe("Remover Leads");
    });

    it("ao Concluir ou Cancelar, o foco volta ao botão Personalizar", () => {
      como("admin");
      renderBarra();
      entrar();
      clicar("Cancelar");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Personalizar" }));
      entrar();
      clicar("Concluir");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Personalizar" }));
    });
  });

  // Achado 11: no celular os botões do modo têm 32 px.
  it("na gaveta os botões do modo têm 32 px; na barra fixa, 24 px", () => {
    como("admin");
    render(<ConteudoDaBarra naGaveta aoNavegar={vi.fn()} marcaPropria={false} />);
    entrar();
    for (const nome of ["Subir Inbox", "Descer Inbox", "Remover Inbox"]) {
      const classe = screen.getByRole("button", { name: nome }).className;
      expect(classe, nome).toContain("h-8 w-8");
      expect(classe, nome).not.toContain("h-6");
    }
    cleanup();
    renderBarra();
    entrar();
    expect(screen.getByRole("button", { name: "Remover Inbox" }).className).toContain("h-6 w-6");
  });

  // Achado 10: o leitor de tela não anuncia a página errada.
  it("em /app/settings/personalizar nenhuma linha da barra é anunciada como a página atual", () => {
    caminho.atual = "/app/settings/personalizar";
    como("admin");
    renderBarra();
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    // controle: numa tela que TEM linha, o destaque continua
    cleanup();
    caminho.atual = "/app/settings";
    renderBarra();
    expect(
      screen
        .getByRole("navigation", { name: "Navegação principal" })
        .querySelectorAll('[aria-current="page"]'),
    ).toHaveLength(1);
  });

  it("os textos do modo passam pelo dicionário em espanhol", () => {
    como("admin");
    render(
      <IdiomaProvider locale="es">
        <BarraLateral escondida={false} marcaPropria={false} />
      </IdiomaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.getByRole("group", { name: "Personalizando la barra" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finalizar" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Más opciones" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quitar Contactos" })).toBeTruthy();
  });
});

describe("barraLateral() — nenhum destino sumiu", () => {
  const alcancaveis = (role: Role | null, platform: boolean) =>
    new Set(
      barraLateral(platform, role).flatMap((s) =>
        s.itens.flatMap((i) => [i.href, ...i.submenu.map((x) => x.href)]),
      ),
    );

  it("todo destino do catálogo tem linha ou submenu (fora a exceção escrita)", () => {
    const na = alcancaveis(null, true);
    const faltando = NAV_DESTINATIONS.map((d) => d.href).filter(
      (h) => !na.has(h) && !(h in FORA_DA_BARRA),
    );
    expect(faltando, "destino sem porta na barra — ponha numa linha ou num submenu").toEqual([]);
  });

  it("todo hub de grupo continua alcançável pela barra", () => {
    const na = alcancaveis(null, true);
    const hubs = NAV_GROUPS.flatMap((g) => (g.hub ? [g.hub.href] : []));
    expect(hubs.filter((h) => !na.has(h))).toEqual([]);
  });

  it("a exceção não guarda destino que já tem porta, nem destino que não existe", () => {
    const na = alcancaveis(null, true);
    const hrefs = new Set(NAV_DESTINATIONS.map((d) => d.href));
    for (const h of Object.keys(FORA_DA_BARRA)) {
      expect(hrefs.has(h), h).toBe(true);
      expect(na.has(h), h).toBe(false);
    }
  });

  // Achado 12: tirar uma tela do submenu de um grupo é decisão com lista PRÓPRIA, separada de
  // "destino sem linha na barra". Quem entra aqui continua no hub de Configurações e no ⌘K.
  describe("FORA_DO_SUBMENU", () => {
    const todosOsSubmenus = () =>
      [null, "viewer", "agent", "manager", "admin"].flatMap((papel) =>
        barraLateral(papel === null, papel as Role | null).flatMap((s) =>
          s.itens.flatMap((i) => i.submenu.map((x) => x.href)),
        ),
      );

    it("não está vazia e cada entrada tem motivo escrito", () => {
      expect(Object.keys(FORA_DO_SUBMENU).length).toBeGreaterThan(0);
      for (const [href, motivo] of Object.entries(FORA_DO_SUBMENU))
        expect((motivo ?? "").length, href).toBeGreaterThan(20);
    });

    it("só guarda destino que existe e que também não tem linha própria na barra", () => {
      const hrefs = new Set(NAV_DESTINATIONS.map((d) => d.href));
      const comLinha = new Set(
        barraLateral(true, null).flatMap((s) => s.itens.map((i) => i.href)),
      );
      for (const h of Object.keys(FORA_DO_SUBMENU)) {
        expect(hrefs.has(h), `${h} não existe no catálogo`).toBe(true);
        expect(comLinha.has(h), `${h} tem linha: não precisa sair do submenu`).toBe(false);
        expect(h in FORA_DA_BARRA, `${h} precisa constar em FORA_DA_BARRA (não tem porta própria)`).toBe(
          true,
        );
      }
    });

    it("some de todo submenu da barra, e só ela: o resto do grupo segue listado", () => {
      const nos = new Set(todosOsSubmenus());
      for (const h of Object.keys(FORA_DO_SUBMENU)) expect(nos.has(h), h).toBe(false);
      // as demais telas de Configurações ainda estão lá
      expect(nos.has("/app/settings/marca")).toBe(true);
      expect(nos.has("/app/settings/profile")).toBe(true);
    });

    it("segue no hub do grupo e no ⌘K", () => {
      for (const h of Object.keys(FORA_DO_SUBMENU)) {
        const d = NAV_DESTINATIONS.find((x) => x.href === h)!;
        const hub = hubSections(d.group, false, "admin").flatMap((s) => s.items.map((i) => i.href));
        expect(hub, h).toContain(h);
        expect(searchable(false, "admin").map((x) => x.href), h).toContain(h);
      }
    });
  });

  it("interface só com Produtos: a linha de Produtos e o hub do CRM, nada de Funis", () => {
    const secoes = barraLateral(false, "agent", {
      preset: "completa",
      destinos: ["/app/products"],
    });
    const hrefs = secoes.flatMap((s) => s.itens.map((i) => i.href));
    expect(hrefs).toContain("/app/products");
    expect(hrefs).toContain("/app/crm");
    expect(hrefs).not.toContain("/app/kanban");
  });

  it("subpágina permitida não some com a linha proibida (manager vê Webhooks sem Conexões)", () => {
    const secoes = barraLateral(false, "manager");
    const prospeccao = secoes.find((s) => s.secao.id === "prospeccao")!;
    expect(prospeccao.itens.map((i) => i.label)).toEqual(["Disparo", "Webhooks", "Atalhos"]);
  });
});
