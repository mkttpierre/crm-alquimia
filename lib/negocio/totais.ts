/**
 * Contas do item e do negócio. O banco calcula `total_cents` (coluna gerada) com a MESMA fórmula; estas funções existem
 * para a tela mostrar o total antes de salvar e para validar o que o banco recusaria (total negativo).
 * Dinheiro em centavos inteiros, sempre (CLAUDE.md: `_cents` + `currency`).
 */

export interface ItemParaTotal {
  quantidade: number;
  preco_unit_cents: number;
  desconto_cents: number;
  acrescimo_cents: number;
}

/** quantidade × preço − desconto + acréscimo. Lança se o resultado for negativo (o CHECK do banco recusaria). */
export function totalDoItem(item: ItemParaTotal): number {
  const total = item.quantidade * item.preco_unit_cents - item.desconto_cents + item.acrescimo_cents;
  if (total < 0) throw new RangeError("Total do item negativo: o desconto passa do valor da linha.");
  return total;
}

export interface SomaDoNegocio {
  total_cents: number;
  itens: number;
  ignorados_outra_moeda: number;
}

/** Soma os itens da moeda do negócio. Item em outra moeda não entra (o trigger do banco faz o mesmo). */
export function somaDoNegocio(itens: ReadonlyArray<{ total_cents: number; currency: string }>, moeda: string): SomaDoNegocio {
  let total = 0;
  let contados = 0;
  for (const i of itens) {
    if (i.currency === moeda) {
      total += i.total_cents;
      contados += 1;
    }
  }
  return { total_cents: total, itens: contados, ignorados_outra_moeda: itens.length - contados };
}
