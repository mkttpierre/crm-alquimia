"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { AlertsBell } from "@/components/shell/AlertsBell";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { SeletorDeIdioma } from "@/components/shell/SeletorDeIdioma";
import { TenantSwitcher } from "@/components/shell/TenantSwitcher";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useTheme } from "@/lib/theme";
import { NAV_DESTINATIONS, NAV_GROUPS } from "@/lib/navigation/registry";
import { MagnifyingGlass, SidebarSimple } from "@/lib/ui/icons";

import { AvatarDoUsuario, MenuDoUsuario, primeiroNome } from "./MenuDoUsuario";

/** Largura a partir da qual a barra é fixa; abaixo dela, é gaveta (protótipo A: 860px). */
export const CONSULTA_DO_CELULAR = "(max-width: 860px)";

const BOTAO =
  "relative grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/** O nome da tela atual, pelo destino do catálogo que casa com a rota (o mais longo). */
export function tituloDaTela(pathname: string): string | null {
  const candidatos = [
    ...NAV_DESTINATIONS.map((d) => ({ href: d.href, label: d.label })),
    // O hub se chama pelo grupo ("Agente de IA", "Análise"), exceto o de
    // Organização, cuja tela o usuário conhece por "Configurações" (é o rótulo do hub).
    ...NAV_GROUPS.flatMap((g) =>
      g.hub ? [{ href: g.hub.href, label: g.id === "organizacao" ? g.hub.label : g.label }] : [],
    ),
  ];
  let melhor: { href: string; label: string } | null = null;
  for (const c of candidatos) {
    if (
      (pathname === c.href || pathname.startsWith(c.href + "/")) &&
      (!melhor || c.href.length > melhor.href.length)
    ) {
      melhor = c;
    }
  }
  return melhor?.label ?? null;
}

/**
 * O topo da casca (60px, protótipo A): mostrar/esconder o menu, o título da
 * tela ("Olá, <primeiro nome>" na Início), e à direita a busca (a paleta ⌘K que
 * já existia), o sino da Central de avisos e o avatar com o menu da pessoa.
 *
 * Também ficam aqui, porque já moravam no topo e quem precisa deles não os acha
 * em outro lugar: a troca de organização (só aparece para quem tem mais de uma)
 * e o idioma (ver o porquê em `components/shell/SeletorDeIdioma.tsx`).
 *
 * A faixa de conexão caída NÃO é daqui: ela fica acima de tudo, no layout de
 * `/app` (`ConexaoCaidaBanner`).
 */
export function Topo({ aoAlternarMenu }: { aoAlternarMenu: () => void }) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const { user } = useAuth();
  const [buscando, setBuscando] = useState(false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setBuscando(true), { preventDefault: true, enableOnFormTags: true });
  // O atalho de tema que o botão antigo registrava (⌘⇧L): claro → escuro → sistema.
  const { theme, setTheme } = useTheme();
  useHotkeys(
    "mod+shift+l",
    () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light"),
    { preventDefault: true },
    [theme],
  );

  const naInicio = pathname === "/app/inicio" || pathname.startsWith("/app/inicio/");
  const nomeDaTela = tituloDaTela(pathname);
  const titulo = naInicio
    ? `${t("Olá")}, ${primeiroNome(user.full_name, user.email)}`
    : nomeDaTela
      ? t(nomeDaTela)
      : "";

  return (
    <header className="sticky top-0 z-20 flex h-[60px] shrink-0 items-center gap-3 border-b border-border bg-background px-4 max-[520px]:gap-2 max-[520px]:px-3">
      <button
        type="button"
        onClick={aoAlternarMenu}
        aria-label={t("Mostrar ou esconder o menu")}
        className={BOTAO}
      >
        <SidebarSimple size={18} aria-hidden />
      </button>
      <p className="min-w-0 truncate text-[17px] font-semibold max-[520px]:text-[15px]">{titulo}</p>
      <div className="ml-auto flex shrink-0 items-center gap-1 max-[520px]:gap-0.5">
        <TenantSwitcher />
        <SeletorDeIdioma />
        <button
          type="button"
          onClick={() => setBuscando(true)}
          aria-label={t("Buscar")}
          title="⌘K"
          className={BOTAO}
        >
          <MagnifyingGlass size={18} aria-hidden />
        </button>
        <AlertsBell />
        <MenuDoUsuario>
          <button type="button" aria-label={t("Menu do usuário")} className="ml-1.5 rounded-full max-[520px]:ml-0.5">
            <AvatarDoUsuario />
          </button>
        </MenuDoUsuario>
      </div>
      <CommandPalette open={buscando} onOpenChange={setBuscando} />
    </header>
  );
}
