import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { type Role } from "@/lib/auth/types";
import {
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  CheckSquare,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  House,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  Lightning,
  ListChecks,
  Lock,
  Megaphone,
  Package,
  Palette,
  PaperPlaneTilt,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  SlidersHorizontal,
  Storefront,
  UserCircle,
  UserPlus,
  Users,
  UsersThree,
  WebhooksLogo,
} from "@/lib/ui/icons";

import {
  BARRA_LATERAL,
  FORA_DO_SUBMENU,
  NAV_CATALOG,
  NAV_GROUPS,
  type IconeDaBarra,
  type NavMetadata,
  type NavGroup,
  type NavGroupId,
  type SecaoDaBarra,
} from "./catalogo";
import { destinosDaInterface, type InterfaceSettings } from "./interface";
import {
  CHAVE_TRAVADA,
  chaveDoGrupo,
  lerNomesDaBarra,
  lerPreferenciasDaBarra,
  ordenarBloco,
  type PersonalizacaoDaBarra,
} from "./personalizar";
export {
  NAV_GROUPS,
  GRUPO_NO_RODAPE,
  BARRA_LATERAL,
  FORA_DA_BARRA,
  FORA_DO_SUBMENU,
} from "./catalogo";
export type { NavGroup, NavGroupId } from "./catalogo";
const ICONS = {
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  House,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  PaperPlaneTilt,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  SlidersHorizontal,
  Storefront,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
};
export interface NavDestination extends Omit<NavMetadata, "icon"> {
  icon: PhosphorIcon;
}
export const NAV_DESTINATIONS: NavDestination[] = NAV_CATALOG.map((d) => ({
  ...d,
  icon: ICONS[d.icon],
}));
/**
 * Único ponto de decisão de permissão da navegação.
 *
 * É o que dispensa os sete `usePermission()` que o Sidebar chamava em sequência
 * — hooks não rodam em laço condicional, então cada permissão exigia sua linha.
 * Como função pura, um `.filter()` resolve todas.
 */
export { canSee } from "./interface";

/** Projeção do sidebar: só o uso diário, agrupado, sem grupo vazio. */
export function sidebarGroups(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): Array<{ group: NavGroup; items: NavDestination[] }> {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  return NAV_GROUPS.map((group) => ({
    group,
    items: NAV_DESTINATIONS.filter(
      (d) => d.group === group.id && (d.sidebar || (!group.hub && !!settings?.destinos)) && visible.has(d.href),
    ),
  })).filter(
    (g) =>
      g.items.length > 0 ||
      (g.group.hub && NAV_DESTINATIONS.some((d) => d.group === g.group.id && visible.has(d.href))),
  );
}

/**
 * Projeção do hub: TODAS as telas do grupo — inclusive as que já estão no
 * sidebar. O hub é inventário, não sobra; é onde se descobre o que existe.
 *
 * A ordem das seções é a de primeira aparição no registro, então reordenar a
 * jornada é reordenar o array — não há uma segunda lista para manter em sincronia.
 */
export function hubSections(
  group: NavGroupId,
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): Array<{ section: string; items: NavDestination[] }> {
  const porSecao = new Map<string, NavDestination[]>();
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  for (const d of NAV_DESTINATIONS) {
    if (d.group !== group || !visible.has(d.href)) continue;
    const secao = d.section ?? "";
    const atual = porSecao.get(secao);
    if (atual) atual.push(d);
    else porSecao.set(secao, [d]);
  }
  return [...porSecao.entries()].map(([section, items]) => ({ section, items }));
}

/** Projeção do ⌘K: todo destino visível, do sidebar ou não. */
export function searchable(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): NavDestination[] {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  return NAV_DESTINATIONS.filter((d) => visible.has(d.href));
}

const ICONES_DA_BARRA: Record<IconeDaBarra, PhosphorIcon> = {
  House,
  Inbox,
  Kanban,
  UserPlus,
  Users,
  CheckSquare,
  CalendarBlank,
  PaperPlaneTilt,
  Plugs,
  Lightning,
  Robot,
  ChartBar,
  Package,
  SlidersHorizontal,
};

export interface ItemDoSubmenu {
  href: string;
  label: string;
}

export interface ItemDaBarra {
  /**
   * A chave ESTÁVEL da linha — o que a personalização grava: o `href` (destino)
   * ou `grupo:<id>` (grupo). Ver `lib/navigation/personalizar.ts`.
   */
  chave: string;
  /** `destino`: a linha é um link (e a seta abre o submenu); `grupo`: a linha abre o submenu. */
  tipo: "destino" | "grupo";
  /** Destino: a tela. Grupo: o hub, ou a primeira tela visível quando o grupo não tem hub. */
  href: string;
  label: string;
  /**
   * O `label` é um NOME PRÓPRIO dado pelo admin: vai para a tela como está, sem
   * passar pela tradução (o dicionário só conhece os nomes padrão).
   */
  nomeProprio: boolean;
  icon: PhosphorIcon;
  healthDot: boolean;
  submenu: ItemDoSubmenu[];
}

/** Uma linha como a tela de Personalizar a vê: a da barra, mais o que ela precisa para editar. */
export interface ItemParaPersonalizar extends ItemDaBarra {
  /** O nome de fábrica (placeholder do campo de nome do admin). */
  nomePadrao: string;
  /** A pessoa ocultou esta linha. Nunca é `true` para a travada. */
  oculto: boolean;
  /** Configurações: não se oculta nem se move. */
  fixo: boolean;
}

/** O rótulo do primeiro item do submenu de um grupo: o hub dele. */
export const ROTULO_DA_VISAO_GERAL = "Visão geral";

/**
 * Projeção da BARRA LATERAL: os blocos de `BARRA_LATERAL`, cada linha filtrada
 * pelo papel e pela interface do vínculo — a MESMA regra (`destinosDaInterface`)
 * do menu antigo, do hub e do ⌘K. Não decide nada sobre permissão.
 *
 * Linha de destino que o papel não vê, mas com subpágina que ele vê (Conexões é
 * `admin`, Webhooks é `manager`), não leva a subpágina junto para o sumiço: a
 * subpágina sobe a linha própria, com o ícone dela — e o hub do grupo também
 * (interface que só mostra Produtos chega ao "Ver tudo em CRM").
 *
 * PERSONALIZAÇÃO (`personalizacao`, migration 0261), aplicada DEPOIS de tudo
 * isso e nesta ordem: os nomes da organização, os ocultos e a ordem pessoais.
 * Como a restrição do admin já rodou, a preferência só age sobre o que a pessoa
 * já tem direito de ver — ela esconde e reordena, nunca traz de volta. Ocultar
 * NÃO é permissão: a tela segue abrindo pelo link e pelo ⌘K. Chave que não existe
 * mais no catálogo é ignorada; linha nova fica no fim do bloco dela; Configurações
 * nunca some e fica por último.
 */
export function barraLateral(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  personalizacao?: PersonalizacaoDaBarra,
): Array<{ secao: Pick<SecaoDaBarra, "id" | "titulo">; itens: ItemDaBarra[] }> {
  return barraParaPersonalizar(isPlatformAdmin, role, settings, personalizacao)
    .map(({ secao, itens }) => ({
      secao,
      itens: itens
        .filter((i) => !i.oculto)
        .map(
          (i): ItemDaBarra => ({
            chave: i.chave,
            tipo: i.tipo,
            href: i.href,
            label: i.label,
            nomeProprio: i.nomeProprio,
            icon: i.icon,
            healthDot: i.healthDot,
            submenu: i.submenu,
          }),
        ),
    }))
    .filter((s) => s.itens.length > 0);
}

/**
 * A mesma projeção, mas COM as linhas ocultas (marcadas `oculto`) e com o que a
 * tela de Personalizar precisa: o nome de fábrica e a marca de linha fixa. É a
 * fonte única — `barraLateral()` é só esta função sem as ocultas — então a tela
 * e a barra nunca discordam sobre o que existe, a ordem ou o nome.
 */
export function barraParaPersonalizar(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  personalizacao?: PersonalizacaoDaBarra,
): Array<{ secao: Pick<SecaoDaBarra, "id" | "titulo">; itens: ItemParaPersonalizar[] }> {
  const preferencias = lerPreferenciasDaBarra(personalizacao?.preferencias);
  const nomes = lerNomesDaBarra(personalizacao?.nomes);
  const ocultos = new Set(preferencias.ocultos);
  const visivel = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  const destino = new Map(NAV_DESTINATIONS.map((d) => [d.href, d] as const));
  const grupo = new Map(NAV_GROUPS.map((g) => [g.id, g] as const));

  // O que já tem lugar numa linha de destino não se repete no submenu de grupo.
  const comLugar = new Set<string>();
  for (const s of BARRA_LATERAL)
    for (const e of s.entradas)
      if (e.tipo === "destino") [e.href, ...(e.subpaginas ?? [])].forEach((h) => comLugar.add(h));

  // `FORA_DO_SUBMENU` fora do submenu: Personalizar tem o botão da linha do usuário (o hub
  // de Configurações, o ⌘K e o "Mais opções" continuam levando à tela).
  const doGrupo = (id: NavGroupId) =>
    NAV_DESTINATIONS.filter(
      (d) => d.group === id && visivel.has(d.href) && !(d.href in FORA_DO_SUBMENU),
    );
  const hubDe = (id: NavGroupId): ItemDoSubmenu[] => {
    const hub = grupo.get(id)?.hub;
    return hub && doGrupo(id).length > 0 ? [{ href: hub.href, label: hub.label }] : [];
  };

  return BARRA_LATERAL.map((secao) => {
    const itens: ItemBase[] = [];
    for (const e of secao.entradas) {
      if (e.tipo === "destino") {
        const sub: ItemDoSubmenu[] = [
          ...(e.subpaginas ?? [])
            .filter((h) => visivel.has(h))
            .map((h) => ({ href: h, label: destino.get(h)!.label })),
          ...(e.hubDoGrupo ? hubDe(e.hubDoGrupo) : []),
        ];
        const d = destino.get(e.href)!;
        if (visivel.has(e.href)) {
          itens.push({
            chave: e.href,
            tipo: "destino",
            href: e.href,
            label: d.label,
            icon: ICONES_DA_BARRA[e.icone],
            healthDot: !!d.healthDot,
            submenu: sub,
          });
        } else {
          for (const h of (e.subpaginas ?? []).filter((x) => visivel.has(x))) {
            const s = destino.get(h)!;
            itens.push({ chave: h, tipo: "destino", href: h, label: s.label, icon: s.icon, healthDot: !!s.healthDot, submenu: [] });
          }
          // O hub do grupo também não some junto: quem só tem Produtos no CRM
          // (interface granular) chega ao inventário do CRM por esta linha.
          for (const hub of e.hubDoGrupo ? hubDe(e.hubDoGrupo) : []) {
            itens.push({ chave: hub.href, tipo: "destino", href: hub.href, label: hub.label, icon: ICONES_DA_BARRA[e.icone], healthDot: false, submenu: [] });
          }
        }
        continue;
      }
      const telas = doGrupo(e.grupo).filter((d) => !comLugar.has(d.href));
      if (telas.length === 0) continue;
      const hub = grupo.get(e.grupo)?.hub;
      itens.push({
        chave: chaveDoGrupo(e.grupo),
        tipo: "grupo",
        href: hub?.href ?? telas[0]!.href,
        label: e.rotulo,
        icon: ICONES_DA_BARRA[e.icone],
        healthDot: false,
        submenu: [
          ...(hub ? [{ href: hub.href, label: ROTULO_DA_VISAO_GERAL }] : []),
          ...telas.map((d) => ({ href: d.href, label: d.label })),
        ],
      });
    }
    const personalizados: ItemParaPersonalizar[] = itens.map((i) => {
      const nome = nomes[i.chave];
      return {
        ...i,
        label: nome ?? i.label,
        nomeProprio: nome !== undefined,
        nomePadrao: i.label,
        fixo: i.chave === CHAVE_TRAVADA,
        oculto: i.chave !== CHAVE_TRAVADA && ocultos.has(i.chave),
      };
    });
    return { secao: { id: secao.id, titulo: secao.titulo }, itens: ordenarBloco(personalizados, preferencias.ordem) };
  }).filter((s) => s.itens.length > 0);
}

/**
 * Toda chave que uma linha da barra pode ter, SEM olhar papel nem interface:
 * os destinos do catálogo, o hub de cada grupo e `grupo:<id>` das linhas de grupo.
 * Serve para separar, nas preferências gravadas, a linha que só não aparece AGORA
 * (restrição do admin, papel) — que se preserva ao salvar — da chave que saiu do
 * catálogo — que se descarta, para o que está gravado não crescer sem fim.
 */
export function chavesConhecidasDaBarra(): Set<string> {
  const chaves = new Set<string>(NAV_DESTINATIONS.map((d) => d.href));
  for (const g of NAV_GROUPS) if (g.hub) chaves.add(g.hub.href);
  for (const s of BARRA_LATERAL)
    for (const e of s.entradas) if (e.tipo === "grupo") chaves.add(chaveDoGrupo(e.grupo));
  return chaves;
}

/** A linha antes da personalização: o que o papel e a interface do vínculo deixam ver. */
type ItemBase = Omit<ItemParaPersonalizar, "nomeProprio" | "nomePadrao" | "oculto" | "fixo">;
