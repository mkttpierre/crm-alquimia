"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";

import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { VersionFooter } from "@/components/shell/VersionFooter";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DO_PAPEL } from "@/lib/auth/types";
import { barraLateral, type ItemDaBarra } from "@/lib/navigation/registry";
import { CaretDown } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { EquipeAgora } from "./EquipeAgora";
import { MarcaDoProduto } from "./MarcaDoProduto";
import { AvatarDoUsuario, MenuDoUsuario } from "./MenuDoUsuario";

/** O destino que casa com a rota atual — o MAIS longo, para `/app/settings` não acender junto com `/app/settings/marca`. */
function casamento(pathname: string, hrefs: string[]): string | null {
  let melhor: string | null = null;
  for (const h of hrefs) {
    if ((pathname === h || pathname.startsWith(h + "/")) && (!melhor || h.length > melhor.length))
      melhor = h;
  }
  return melhor;
}

/** Nome próprio dado pelo admin vai como está; o padrão passa pela tradução. */
function rotuloDaLinha(item: ItemDaBarra, t: (texto: string) => string): string {
  return item.nomeProprio ? item.label : t(item.label);
}

const LINHA =
  "flex items-center gap-[11px] rounded-md px-[10px] py-2 text-[14px] font-medium transition-colors";
const LINHA_ESTADO = (ativa: boolean) =>
  ativa
    ? "bg-lateral-ativo text-lateral-texto"
    : "text-lateral-item hover:bg-lateral-hover hover:text-lateral-texto";

/**
 * O conteúdo da barra lateral (protótipo A): marca, os três blocos de navegação,
 * "Equipe agora" e quem está logado. Serve à barra fixa do computador e à gaveta
 * do celular (`components/app/Topo.tsx` abre a gaveta), para as duas nunca
 * divergirem.
 *
 * Não decide permissão: `barraLateral()` (lib/navigation/registry.ts) projeta o
 * catálogo pelo papel e pela interface do vínculo; isto aqui só desenha.
 */
export function ConteudoDaBarra({
  aoNavegar,
  marcaPropria,
}: {
  aoNavegar?: () => void;
  /** Ver `MarcaDoProduto`: resolvido no servidor. */
  marcaPropria: boolean;
}) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const { user, activeOrg } = useAuth();
  const secoes = barraLateral(
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
    activeOrg?.barra,
  );

  // Todos os hrefs da barra, para o casamento mais longo valer entre linhas e submenus.
  const todos = secoes.flatMap((s) =>
    s.itens.flatMap((i) => [i.href, ...i.submenu.map((x) => x.href)]),
  );
  const ativo = casamento(pathname, todos);
  // Ids por instância (`useId`): com a gaveta do celular aberta, a barra existe
  // duas vezes no documento, e um id fixo repetido quebra `aria-labelledby`.
  const base = useId();

  // A barra é preta nos dois temas: o que vem de fora e pinta com os tokens de
  // texto (o rodapé de versão) passa a ler as cores da barra dentro dela.
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 px-[10px] py-[14px] [--color-text-muted:var(--color-lateral-suave)] [--color-text:var(--color-lateral-texto)]">
      <MarcaDoProduto marcaPropria={marcaPropria} />
      <div className="flex min-h-0 flex-1 [scrollbar-width:thin] [scrollbar-color:var(--color-lateral-ativo)_transparent] flex-col gap-[14px] overflow-y-auto">
        <nav aria-label={t("Navegação principal")} className="flex flex-col gap-[14px]">
          {secoes.map(({ secao, itens }) => {
            const tituloId = `${base}-secao-${secao.id}`;
            return (
              <section
                key={secao.id}
                aria-labelledby={secao.titulo ? tituloId : undefined}
                aria-label={secao.titulo ? undefined : t("Dia a dia")}
              >
                {secao.titulo && (
                  <h2
                    id={tituloId}
                    className="px-[10px] pb-1.5 text-[11px] leading-none font-medium tracking-[0.06em] text-lateral-apagado uppercase"
                  >
                    {t(secao.titulo)}
                  </h2>
                )}
                <ul className="flex flex-col gap-px">
                  {itens.map((item) => (
                    <LinhaDaBarra
                      key={item.href + item.label}
                      item={item}
                      ativo={ativo}
                      aoNavegar={aoNavegar}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </nav>
        <EquipeAgora />
      </div>
      <VersionFooter collapsed={false} onNavigate={aoNavegar} />
      <MenuDoUsuario lado="top" alinhamento="start">
        <button
          type="button"
          aria-label={t("Menu do usuário")}
          className="flex w-full items-center gap-2.5 border-t border-lateral-linha px-2 pt-2.5 pb-1 text-left hover:bg-lateral-hover"
        >
          <AvatarDoUsuario />
          <span className="min-w-0">
            <b className="block truncate text-[13px] font-semibold text-lateral-texto">
              {user.full_name ?? user.email}
            </b>
            {activeOrg?.role && (
              <span className="block truncate text-[12px] text-lateral-suave">
                {t(ROTULO_DO_PAPEL[activeOrg.role])}
              </span>
            )}
          </span>
        </button>
      </MenuDoUsuario>
    </div>
  );
}

function LinhaDaBarra({
  item,
  ativo,
  aoNavegar,
}: {
  item: ItemDaBarra;
  ativo: string | null;
  aoNavegar?: () => void;
}) {
  const t = useT();
  const dentro = !!ativo && (ativo === item.href || item.submenu.some((s) => s.href === ativo));
  // Abre sozinho quando a tela atual mora no submenu; depois, o clique manda.
  const [aberto, setAberto] = useState(() => dentro && item.submenu.some((s) => s.href === ativo));
  const submenuId = useId();
  const Icone = item.icon;
  const temSubmenu = item.submenu.length > 0;

  const submenu = temSubmenu && aberto && (
    <ul
      id={submenuId}
      className="mt-0.5 mb-1 ml-[19px] flex flex-col gap-px border-l border-lateral-linha pl-2"
    >
      {item.submenu.map((s) => (
        <li key={s.href}>
          <Link
            href={s.href}
            prefetch={false}
            onClick={aoNavegar}
            aria-current={ativo === s.href ? "page" : undefined}
            className={cn(
              "block truncate rounded-md px-[10px] py-1.5 text-[13px] transition-colors",
              LINHA_ESTADO(ativo === s.href),
            )}
          >
            {t(s.label)}
          </Link>
        </li>
      ))}
    </ul>
  );

  if (item.tipo === "grupo") {
    return (
      <li>
        <button
          type="button"
          aria-expanded={aberto}
          aria-controls={submenuId}
          onClick={() => setAberto((v) => !v)}
          className={cn(LINHA, "w-full text-left", LINHA_ESTADO(dentro && !aberto))}
        >
          <Icone size={18} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{rotuloDaLinha(item, t)}</span>
          <CaretDown
            size={14}
            aria-hidden
            className={cn(
              "shrink-0 text-lateral-apagado transition-transform",
              !aberto && "-rotate-90",
            )}
          />
        </button>
        {submenu}
      </li>
    );
  }

  const linhaAtiva = ativo === item.href;
  return (
    <li>
      <div className={cn("group flex items-center rounded-md", LINHA_ESTADO(linhaAtiva))}>
        <Link
          href={item.href}
          prefetch={false}
          onClick={aoNavegar}
          aria-current={linhaAtiva ? "page" : undefined}
          className={cn(LINHA, "min-w-0 flex-1 hover:bg-transparent")}
        >
          <Icone size={18} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{rotuloDaLinha(item, t)}</span>
          {item.healthDot && <ConnectionHealthDot className="ml-auto" />}
        </Link>
        {temSubmenu && (
          <button
            type="button"
            aria-expanded={aberto}
            aria-controls={submenuId}
            aria-label={`${t("Mais em")} ${rotuloDaLinha(item, t)}`}
            onClick={() => setAberto((v) => !v)}
            className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-lateral-apagado hover:bg-lateral-ativo hover:text-lateral-texto"
          >
            <CaretDown
              size={14}
              aria-hidden
              className={cn("transition-transform", !aberto && "-rotate-90")}
            />
          </button>
        )}
      </div>
      {submenu}
    </li>
  );
}

/**
 * A barra fixa do computador (≥ 861px). No celular ela não existe: a mesma
 * `ConteudoDaBarra` abre numa gaveta pelo botão do topo.
 *
 * Duas caixas, UMA medida (ver `tests/unit/barra-lateral-nao-flutua.test.ts`):
 *  - um lugar reservado no fluxo (`shrink-0`, porque item de flex encolhe por
 *    padrão) — é ele que afasta o conteúdo, sem margem do lado de lá;
 *  - dentro dele, a barra `fixed`, presa na tela.
 * As duas leem `LARGURA_DA_BARRA`, então não há como discordarem (o defeito
 * antigo era uma margem em OUTRO componente, e a barra cobria a lista do inbox).
 *
 * Por que não `sticky` (15/11/2026): ao abrir um seletor ou diálogo, o Radix
 * trava a rolagem pondo `overflow: hidden` no body; o body vira o contêiner de
 * rolagem e a barra sticky subia junto com a página. `fixed` não depende disso.
 */
const LARGURA_DA_BARRA = "w-[264px]";

export function BarraLateral({
  escondida,
  marcaPropria,
}: {
  escondida: boolean;
  marcaPropria: boolean;
}) {
  return (
    <div
      data-lugar-da-barra=""
      className={cn(
        "hidden shrink-0",
        LARGURA_DA_BARRA,
        escondida ? "min-[861px]:hidden" : "min-[861px]:block",
      )}
    >
      <aside
        data-escondida={escondida ? "" : undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex h-screen flex-col border-r border-lateral-linha bg-lateral text-lateral-texto",
          LARGURA_DA_BARRA,
        )}
      >
        <ConteudoDaBarra marcaPropria={marcaPropria} />
      </aside>
    </div>
  );
}
