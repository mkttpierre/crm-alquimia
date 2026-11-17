/**
 * Personalizar a barra lateral — o contrato dos DADOS (migration 0261).
 *
 * Duas camadas com donos diferentes, as duas só de APRESENTAÇÃO:
 *
 *  - da PESSOA (`user_organizations.preferencias_da_barra`): quais linhas ela
 *    oculta e em que ordem vê as que ficam. Vale só para a barra dela;
 *  - da ORGANIZAÇÃO (`organizations.nomes_da_barra`): o nome que o admin deu a
 *    cada linha de topo. Vale para todos.
 *
 * Ocultar NÃO é permissão: a tela ocultada continua abrindo pelo link e pelo ⌘K,
 * e a restrição do admin (`interface.ts`) vem primeiro — nada daqui devolve uma
 * linha que o papel ou a interface do vínculo já tirou.
 *
 * ── A chave de uma linha ────────────────────────────────────────────────────
 * É o `href`, quando a linha é um destino, ou `grupo:<id>`, quando a linha abre
 * um grupo. O banco confere só a FORMA (o catálogo evolui no TypeScript), então
 * uma chave que saiu do catálogo continua gravada e é IGNORADA na leitura, sem
 * erro: é o que `lerPreferenciasDaBarra`/`lerNomesDaBarra` e a projeção fazem.
 *
 * Este arquivo é puro (sem servidor, sem React): o servidor, o cliente e as
 * Server Actions leem as MESMAS regras daqui.
 */
import { z } from "zod";

import { GRUPO_NO_RODAPE, type NavGroupId } from "./catalogo";

/** Tamanho máximo do nome dado pelo admin (o CHECK da 0261 repete este número). */
export const LIMITE_DO_NOME = 40;
/** Quantas chaves cabem em `ocultos` e em `ordem` (o CHECK da 0261 repete este número). */
export const LIMITE_DE_CHAVES = 200;
const LIMITE_DA_CHAVE = 120;

/** A chave da linha que abre um grupo. */
export function chaveDoGrupo(id: NavGroupId): string {
  return `grupo:${id}`;
}

/**
 * A linha que nunca some: Configurações. Sem ela a pessoa perderia o caminho de
 * volta para esta tela. Fica também sempre por último no bloco dela.
 */
export const CHAVE_TRAVADA = chaveDoGrupo(GRUPO_NO_RODAPE);

export interface PreferenciasDaBarra {
  /** Chaves das linhas que a pessoa ocultou. */
  ocultos: string[];
  /** Ordem preferida (chaves). Quem não está aqui entra no fim do bloco. */
  ordem: string[];
}

/** Mapa `chave -> nome` dado pelo admin. */
export type NomesDaBarra = Record<string, string>;

export interface PersonalizacaoDaBarra {
  preferencias?: PreferenciasDaBarra;
  nomes?: NomesDaBarra;
}

export const PREFERENCIAS_VAZIAS: PreferenciasDaBarra = { ocultos: [], ordem: [] };

const eObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function chavesDe(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const vistas = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const chave = v.trim();
    if (chave === "" || chave.length > LIMITE_DA_CHAVE) continue;
    vistas.add(chave);
    if (vistas.size >= LIMITE_DE_CHAVES) break;
  }
  return [...vistas];
}

/** Leitura que tolera QUALQUER coisa vinda do banco: nunca lança, nunca devolve lixo. */
export function lerPreferenciasDaBarra(raw: unknown): PreferenciasDaBarra {
  if (!eObjeto(raw)) return { ocultos: [], ordem: [] };
  return {
    ocultos: chavesDe(raw.ocultos).filter((c) => c !== CHAVE_TRAVADA),
    ordem: chavesDe(raw.ordem),
  };
}

/** Nome de verdade: texto aparado, não vazio, até `LIMITE_DO_NOME`. Qualquer outra coisa é ignorada. */
export function lerNomesDaBarra(raw: unknown): NomesDaBarra {
  if (!eObjeto(raw)) return {};
  const nomes: NomesDaBarra = {};
  for (const [chave, valor] of Object.entries(raw)) {
    if (typeof valor !== "string") continue;
    const nome = valor.trim();
    if (nome === "" || nome.length > LIMITE_DO_NOME) continue;
    nomes[chave] = nome;
  }
  return nomes;
}

/** Tem alguma coisa que mude a barra em relação ao padrão? */
export function preferenciasTemEscolha(p: PreferenciasDaBarra): boolean {
  return p.ocultos.length > 0 || p.ordem.length > 0;
}

/**
 * Reordena UM bloco: quem está em `ordem` vem primeiro, na ordem salva; quem não
 * está (item novo do catálogo) vai para o fim, na ordem padrão. A linha travada
 * fica sempre por último. Função genérica sobre qualquer coisa com `chave`.
 */
export function ordenarBloco<T extends { chave: string }>(
  itens: readonly T[],
  ordem: readonly string[],
): T[] {
  const posicao = new Map(ordem.map((c, i) => [c, i] as const));
  const travadas = itens.filter((i) => i.chave === CHAVE_TRAVADA);
  const livres = itens.filter((i) => i.chave !== CHAVE_TRAVADA);
  const salvos = livres
    .filter((i) => posicao.has(i.chave))
    .sort((a, b) => posicao.get(a.chave)! - posicao.get(b.chave)!);
  const novos = livres.filter((i) => !posicao.has(i.chave));
  return [...salvos, ...novos, ...travadas];
}

/**
 * Sobe (`-1`) ou desce (`+1`) UMA linha dentro do bloco. Não faz nada quando a
 * linha já está na ponta, quando é a travada (Configurações não se move) ou
 * quando o vizinho é a travada (ninguém passa dela: ela fica sempre por último).
 * É o que os botões "subir" e "descer" da tela chamam.
 */
export function moverItem<T extends { chave: string }>(
  itens: readonly T[],
  chave: string,
  delta: -1 | 1,
): T[] {
  const de = itens.findIndex((i) => i.chave === chave);
  const para = de + delta;
  if (de < 0 || para < 0 || para >= itens.length) return [...itens];
  if (itens[de]!.chave === CHAVE_TRAVADA || itens[para]!.chave === CHAVE_TRAVADA) return [...itens];
  const novo = [...itens];
  [novo[de], novo[para]] = [novo[para]!, novo[de]!];
  return novo;
}

// ---------------------------------------------------------------------------
// Entrada das Server Actions (Zod em todo input externo)
// ---------------------------------------------------------------------------

/** O formato de uma chave: o que o catálogo produz (`/app/...`) ou `grupo:<id>`. A 0261 repete esta regex. */
const REGEX_DA_CHAVE = /^(\/app\/[a-z0-9/_-]+|grupo:[a-z0-9_-]+)$/;
const chaveSchema = z.string().max(LIMITE_DA_CHAVE).regex(REGEX_DA_CHAVE);

const semRepetidas = (chaves: string[]) => [...new Set(chaves)];

export const preferenciasDaBarraSchema = z
  .strictObject({
    ocultos: z.array(chaveSchema).max(LIMITE_DE_CHAVES),
    ordem: z.array(chaveSchema).max(LIMITE_DE_CHAVES),
  })
  .transform((p): PreferenciasDaBarra => ({
    // Configurações não pode ser ocultada: a escolha é descartada na gravação,
    // não devolvida como erro (a tela já a mostra travada).
    ocultos: semRepetidas(p.ocultos).filter((c) => c !== CHAVE_TRAVADA),
    ordem: semRepetidas(p.ordem),
  }));

export const nomesDaBarraSchema = z
  .record(chaveSchema, z.string().trim().max(LIMITE_DO_NOME))
  // Vazio volta ao padrão: a chave simplesmente não é gravada.
  .transform((nomes): NomesDaBarra =>
    Object.fromEntries(Object.entries(nomes).filter(([, n]) => n !== "")),
  )
  .refine((nomes) => Object.keys(nomes).length <= LIMITE_DE_CHAVES);
