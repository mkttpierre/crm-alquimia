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
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BarraLateral } from "@/components/app/BarraLateral";
import type { ActiveOrg, AuthUser, Role } from "@/lib/auth/types";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { canSee } from "@/lib/navigation/interface";
import type { PersonalizacaoDaBarra } from "@/lib/navigation/personalizar";
import {
  barraLateral,
  FORA_DA_BARRA,
  NAV_DESTINATIONS,
  NAV_GROUPS,
} from "@/lib/navigation/registry";

const authRef: { user: AuthUser; activeOrg: ActiveOrg | null } = {
  user: {
    id: "u1",
    email: "ana@exemplo.test",
    full_name: "Ana Prado",
    avatar_url: null,
    is_platform_admin: false,
    organizations: [],
  } as unknown as AuthUser,
  activeOrg: null,
};

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ ...authRef, signOut: vi.fn() }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/settings/marca" }));
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
    const esperados = [
      "Visão geral",
      ...NAV_DESTINATIONS.filter((d) => d.group === "organizacao" && canSee(d, false, "admin")).map(
        (d) => d.label,
      ),
    ];
    expect(
      within(sub)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(esperados);
    expect(within(sub).getByRole("link", { name: "Marca" }).getAttribute("aria-current")).toBe(
      "page",
    );
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
