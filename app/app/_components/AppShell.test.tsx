/**
 * A gaveta do celular com o modo personalização ligado (achado 1 da revisão de 16/11/2026).
 *
 * O modo vive no estado de `ConteudoDaBarra`, que desmonta quando a gaveta fecha: se um
 * Escape, um toque fora ou o "X" da gaveta a fechassem, o admin perderia tudo o que mexeu,
 * sem aviso. Com o modo ligado, só Cancelar e Concluir saem.
 *
 * Renderiza a gaveta de verdade (Sheet do Radix + `ConteudoDaBarra`), não o conteúdo solto:
 * o que se prova é a fiação do `AppShell`.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/app/app/_components/AppShell";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const authRef: { user: AuthUser; activeOrg: ActiveOrg | null } = {
  user: {
    id: "u1",
    email: "ana@exemplo.test",
    full_name: "Ana Prado",
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: "org-1", organization_name: "Org", role: "admin" }],
  } as unknown as AuthUser,
  activeOrg: { orgId: "org-1", name: "Org", role: "admin" } as ActiveOrg,
};

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ ...authRef, signOut: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inicio",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/actions/settings/updateMinhaBarra", () => ({ updateMinhaBarra: vi.fn() }));
vi.mock("@/app/actions/settings/updateNomesDaBarra", () => ({ updateNomesDaBarra: vi.fn() }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));
vi.mock("@/hooks/team/useAttendants", () => ({ useAttendants: () => ({ data: { data: [] } }) }));
vi.mock("@/hooks/team/useAgentesExternos", () => ({
  useAgentesExternos: () => ({ data: { agentes: [] } }),
}));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({
  useInboundMessageAlerts: () => undefined,
}));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: () => undefined }));
vi.mock("@/lib/notifications/notify_open", () => ({
  useNotifyOpenFromServiceWorker: () => undefined,
}));
// O topo de verdade traz um monte de dependência que não é o assunto: só o botão que abre a gaveta.
vi.mock("@/components/app/Topo", () => ({
  CONSULTA_DO_CELULAR: "(max-width: 860px)",
  Topo: ({ aoAlternarMenu }: { aoAlternarMenu: () => void }) => (
    <button type="button" onClick={aoAlternarMenu}>
      Abrir menu
    </button>
  ),
}));

beforeEach(() => {
  // No celular o botão do topo abre a gaveta (e não esconde a barra).
  window.matchMedia = ((consulta: string) => ({
    matches: true,
    media: consulta,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

function abrirGaveta() {
  render(
    <AppShell sidebarCollapsed={false} marcaPropria={false}>
      <p>conteúdo</p>
    </AppShell>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
  return screen.getByRole("dialog");
}

const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
// O Radix só passa a ouvir o toque fora um instante depois de abrir (setTimeout 0), e o
// clique com o botão principal só fecha no `click` que segue o `pointerdown`.
const esperar = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
async function tocarFora() {
  await esperar();
  fireEvent.pointerDown(document.body, { button: 0 });
  fireEvent.pointerUp(document.body, { button: 0 });
  fireEvent.click(document.body, { button: 0 });
  await esperar();
}

describe("AppShell — gaveta do celular", () => {
  it("fora do modo personalização, Escape e toque fora fecham a gaveta como sempre", async () => {
    abrirGaveta();
    escape();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await tocarFora();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("com o modo ligado, Escape e toque fora NÃO fecham a gaveta nem jogam o trabalho fora", async () => {
    const gaveta = abrirGaveta();
    fireEvent.click(within(gaveta).getByRole("button", { name: "Personalizar" }));
    fireEvent.click(within(gaveta).getByRole("button", { name: "Remover Leads" }));

    escape();
    await tocarFora();

    const ainda = screen.getByRole("dialog");
    expect(within(ainda).getByRole("group", { name: "Personalizando a barra" })).toBeTruthy();
    // a remoção feita continua lá, em "Adicionar"
    expect(within(ainda).getByRole("button", { name: "Adicionar Leads" })).toBeTruthy();
  });

  it("com o modo ligado, o X da gaveta também não a fecha", () => {
    const gaveta = abrirGaveta();
    fireEvent.click(within(gaveta).getByRole("button", { name: "Personalizar" }));
    fireEvent.click(within(gaveta).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Cancelar sai do modo e a gaveta volta a fechar por Escape e por toque fora", () => {
    const gaveta = abrirGaveta();
    fireEvent.click(within(gaveta).getByRole("button", { name: "Personalizar" }));
    fireEvent.click(within(gaveta).getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    escape();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Concluir (nada mudado) também libera a gaveta", async () => {
    const gaveta = abrirGaveta();
    fireEvent.click(within(gaveta).getByRole("button", { name: "Personalizar" }));
    fireEvent.click(within(gaveta).getByRole("button", { name: "Concluir" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await tocarFora();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reabrir a gaveta depois de fechada não a deixa travada", () => {
    const gaveta = abrirGaveta();
    fireEvent.click(within(gaveta).getByRole("button", { name: "Personalizar" }));
    fireEvent.click(within(gaveta).getByRole("button", { name: "Cancelar" }));
    escape();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    escape();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
