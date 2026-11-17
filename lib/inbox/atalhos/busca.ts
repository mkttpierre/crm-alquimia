/**
 * Busca da barra de atalhos do chat. Puro: o composer passa o que o operador digitou e recebe os cartões.
 * Sem acento, sem diferença de maiúscula, por "contém", em nome, atalho e palavras-chave; a `/` do começo é ignorada.
 */
import { ORDEM_DOS_TIPOS, type ItemDeAtalho, type TipoDeAtalho } from "./tipos";

export function normalizarBusca(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/^\//, "");
}

export function buscarAtalhos(itens: ItemDeAtalho[], texto: string, filtro?: TipoDeAtalho[]): ItemDeAtalho[] {
  const q = normalizarBusca(texto);
  if (!q) return [];
  const casa = (i: ItemDeAtalho) =>
    [i.nome, i.atalho ?? "", ...i.palavrasChave].some((campo) => normalizarBusca(campo).includes(q));
  return itens
    .filter((i) => (!filtro || filtro.includes(i.tipo)) && casa(i))
    .sort(
      (a, b) =>
        Number(b.favorito) - Number(a.favorito) ||
        ORDEM_DOS_TIPOS.indexOf(a.tipo) - ORDEM_DOS_TIPOS.indexOf(b.tipo) ||
        a.nome.localeCompare(b.nome, "pt-BR"),
    );
}
