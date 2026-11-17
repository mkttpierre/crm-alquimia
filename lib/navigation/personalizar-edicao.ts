/**
 * Personalizar a barra — as operações de EDIÇÃO, puras, que a tela
 * (`Configurações › Personalizar › Sua barra`) e o modo personalização da própria
 * barra lateral (`components/app/EdicaoDaBarra.tsx`) usam. Existem aqui, e não em
 * cada componente, para haver UMA regra de ocultar, mover e montar o que se grava:
 * duas cópias divergem, e a barra gravaria uma preferência que a tela lê diferente.
 *
 * Os contratos de DADOS (formato, limites, linha travada) são de `personalizar.ts`;
 * a projeção da barra é de `registry.ts`. Nada aqui lê banco nem React.
 */
import {
  CHAVE_TRAVADA,
  LIMITE_DE_CHAVES,
  lerNomesDaBarra,
  lerPreferenciasDaBarra,
  moverItem,
  type NomesDaBarra,
  type PersonalizacaoDaBarra,
  type PreferenciasDaBarra,
} from "./personalizar";
import { chavesConhecidasDaBarra } from "./registry";

/** O mínimo que as operações precisam saber de uma linha em edição. */
export interface LinhaOperavel {
  chave: string;
  oculto: boolean;
}

export interface BlocoOperavel<L extends LinhaOperavel> {
  id: string;
  itens: L[];
}

/** Liga ou desliga o "oculto" de uma linha. Configurações (a travada) nunca é ocultada. */
export function alternarOculto<L extends LinhaOperavel, B extends BlocoOperavel<L>>(
  blocos: readonly B[],
  chave: string,
): B[] {
  if (chave === CHAVE_TRAVADA) return [...blocos];
  return blocos.map((b) => ({
    ...b,
    itens: b.itens.map((i) => (i.chave === chave ? { ...i, oculto: !i.oculto } : i)),
  }));
}

/**
 * Aplica `nova` (a ordem das linhas VISÍVEIS) nos lugares que as visíveis ocupavam:
 * as ocultas ficam onde estão. É o que faz "subir" e "arrastar" valerem entre o que
 * a pessoa VÊ, sem trocar de lugar com uma linha que nem aparece.
 */
function refazerComVisiveis<T extends { oculto: boolean }>(
  itens: readonly T[],
  nova: readonly T[],
): T[] {
  let k = 0;
  return itens.map((i) => (i.oculto ? i : nova[k++]!));
}

/**
 * Sobe (`-1`) ou desce (`+1`) uma linha entre as VISÍVEIS do bloco. Usa `moverItem`
 * (a regra da tela): ponta, linha travada e vizinho travado não mexem em nada.
 */
export function moverEntreVisiveis<T extends LinhaOperavel>(
  itens: readonly T[],
  chave: string,
  delta: -1 | 1,
): T[] {
  const visiveis = itens.filter((i) => !i.oculto);
  return refazerComVisiveis(itens, moverItem(visiveis, chave, delta));
}

/**
 * Arrastar: a linha `chave` assume o lugar de `alvo`, entre as VISÍVEIS do bloco.
 * Soltar sobre Configurações põe a linha logo ANTES dela (a travada fica sempre
 * por último). Configurações não é arrastada; soltar em si mesmo, ou sobre uma
 * chave que não está visível, não muda nada.
 */
export function moverParaOLugarDe<T extends LinhaOperavel>(
  itens: readonly T[],
  chave: string,
  alvo: string,
): T[] {
  const visiveis = itens.filter((i) => !i.oculto);
  const de = visiveis.findIndex((i) => i.chave === chave);
  const para = visiveis.findIndex((i) => i.chave === alvo);
  if (de < 0 || para < 0 || de === para || chave === CHAVE_TRAVADA) return [...itens];
  const novo = [...visiveis];
  const [movida] = novo.splice(de, 1);
  // O alvo travado é o último: depois da retirada ele fica em `length - 1`, e a
  // linha entra antes dele. Para qualquer outro alvo, vale o índice original.
  const destino = alvo === CHAVE_TRAVADA ? novo.length - 1 : para;
  novo.splice(destino, 0, movida!);
  return refazerComVisiveis(itens, novo);
}

/**
 * O que `updateMinhaBarra` recebe: ocultos e ordem da tela, mais o que está
 * gravado e NÃO aparece agora (`preservados`), para um "Salvar" de hoje não apagar
 * a escolha de uma linha que o admin pode liberar amanhã. Limitado ao que o banco aceita.
 */
export function montarPreferencias<L extends LinhaOperavel>(
  blocos: readonly BlocoOperavel<L>[],
  preservados: PreferenciasDaBarra,
): PreferenciasDaBarra {
  return {
    ocultos: [
      ...blocos.flatMap((b) => b.itens.filter((i) => i.oculto).map((i) => i.chave)),
      ...preservados.ocultos,
    ].slice(0, LIMITE_DE_CHAVES),
    ordem: [...blocos.flatMap((b) => b.itens.map((i) => i.chave)), ...preservados.ordem].slice(
      0,
      LIMITE_DE_CHAVES,
    ),
  };
}

/** O que `updateNomesDaBarra` recebe: os nomes da tela (vazio = padrão, não grava) mais os preservados. */
export function montarNomes(
  linhas: readonly { chave: string; nome: string }[],
  preservados: NomesDaBarra,
): NomesDaBarra {
  const editados = Object.fromEntries(
    linhas.map((l) => [l.chave, l.nome.trim()] as const).filter(([, nome]) => nome !== ""),
  );
  return { ...preservados, ...editados };
}

/**
 * O que está gravado e NÃO aparece agora — a interface do vínculo ou o papel
 * tiraram a linha — e por isso volta no envio. Chave que saiu do catálogo se
 * perde de propósito, para o gravado não crescer sem fim.
 */
export function preservadosDaPersonalizacao(
  personalizacao: PersonalizacaoDaBarra | undefined,
  chavesListadas: ReadonlySet<string>,
): { preferencias: PreferenciasDaBarra; nomes: NomesDaBarra } {
  const preferencias = lerPreferenciasDaBarra(personalizacao?.preferencias);
  const conhecidas = chavesConhecidasDaBarra();
  const mantem = (chave: string) => conhecidas.has(chave) && !chavesListadas.has(chave);
  const nomes = lerNomesDaBarra(personalizacao?.nomes);
  return {
    preferencias: {
      ocultos: preferencias.ocultos.filter(mantem),
      ordem: preferencias.ordem.filter(mantem),
    },
    nomes: Object.fromEntries(
      Object.entries(nomes).filter(([chave]) => !chavesListadas.has(chave)),
    ),
  };
}

/** Mensagem (já em português, para passar por `t()`) por código de recusa da gravação PESSOAL. */
export const ERRO_DA_BARRA_PESSOAL: Record<string, string> = {
  validation_failed: "Algum campo não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo para salvar.",
  forbidden_tenant: "Não consegui identificar sua empresa. Recarregue a página.",
  forbidden_role: "Você não tem permissão para fazer esta alteração.",
  // NUNCA "salvo com uma ressalva": a gravação não casou nenhuma linha.
  nao_gravou: "A alteração não chegou ao banco — nada foi mudado. Tente de novo.",
};

/** Idem, para os NOMES (admin). */
export const ERRO_DOS_NOMES: Record<string, string> = {
  validation_failed: "Algum nome não está no formato esperado (até 40 caracteres).",
  unauthenticated: "Sua sessão expirou. Entre de novo para salvar.",
  forbidden_tenant: "Não consegui identificar sua empresa. Recarregue a página.",
  forbidden_role: "Só quem administra esta empresa pode mudar os nomes.",
  mfa_required: "Confirme o código do seu aplicativo de duas etapas e tente de novo.",
  nao_gravou: "A alteração não chegou ao banco — nada foi mudado. Tente de novo.",
};

export const ERRO_GENERICO = "Não foi possível salvar. Tente de novo.";
