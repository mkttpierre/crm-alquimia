/**
 * O rascunho do quadro "Registrar venda": texto digitado → corpo do POST. Funções puras, testadas sem tela.
 * Dinheiro digitado em reais ("120,00", "R$ 1.299,90") é lido por `precoParaCentavos`, que FALHA FECHADO: valor ilegível
 * vira erro na tela, nunca um número plausível e errado.
 */
import { precoParaCentavos } from "@/lib/schemas/produtos";

import { totalDaVenda, vendaCriarSchema, type VendaCriarInput } from "./venda";

export interface LinhaRascunho {
  /** Identidade só da tela (chave do React); não vai ao servidor. */
  chave: string;
  /** Vazio = item avulso. */
  produtoId: string;
  nome: string;
  preco: string;
  quantidade: string;
  desconto: string;
}

export const emReais = (cents: number): string => (cents / 100).toFixed(2).replace(".", ",");

export function linhaDoProduto(p: { id: string; nome: string; preco_cents: number }, chave: string): LinhaRascunho {
  return { chave, produtoId: p.id, nome: p.nome, preco: emReais(p.preco_cents), quantidade: "1", desconto: "" };
}

export function linhaAvulsa(chave: string): LinhaRascunho {
  return { chave, produtoId: "", nome: "", preco: "", quantidade: "1", desconto: "" };
}

interface Lida {
  quantidade: number;
  preco_unit_cents: number;
  desconto_cents: number;
}

export type ErroDoRascunho = "sem_linhas" | "valor_invalido" | "quantidade_invalida" | "desconto_invalido" | "nome_vazio" | "venda_invalida";

type LeituraDaLinha = { ok: true; linha: Lida } | { ok: false; erro: ErroDoRascunho };

function lerLinha(l: LinhaRascunho): LeituraDaLinha {
  const preco = l.preco.trim() === "" ? null : precoParaCentavos(l.preco);
  if (preco === null) return { ok: false, erro: "valor_invalido" };
  const quantidade = Number(l.quantidade);
  if (!Number.isInteger(quantidade) || quantidade < 1) return { ok: false, erro: "quantidade_invalida" };
  const desconto = l.desconto.trim() === "" ? 0 : precoParaCentavos(l.desconto);
  if (desconto === null || desconto > quantidade * preco) return { ok: false, erro: "desconto_invalido" };
  return { ok: true, linha: { quantidade, preco_unit_cents: preco, desconto_cents: desconto } };
}

/** Total ao vivo: soma as linhas legíveis (a ilegível não entra; a tela marca o erro quando se tenta confirmar). */
export function totalDoRascunho(linhas: ReadonlyArray<LinhaRascunho>): number {
  return totalDaVenda(
    linhas.flatMap((l) => {
      const r = lerLinha(l);
      return r.ok ? [r.linha] : [];
    }),
  );
}

export type ResultadoDoRascunho = { ok: true; corpo: VendaCriarInput; total_cents: number } | { ok: false; erro: ErroDoRascunho };

export function lerRascunho(
  linhas: ReadonlyArray<LinhaRascunho>,
  dataVenda: string,
  alvo: { contactId?: string | null; leadId?: string | null; negocioPrevisto?: string | null },
): ResultadoDoRascunho {
  if (linhas.length === 0) return { ok: false, erro: "sem_linhas" };
  const itens: unknown[] = [];
  for (const l of linhas) {
    const lida = lerLinha(l);
    if (!lida.ok) return lida;
    if (!l.produtoId && l.nome.trim() === "") return { ok: false, erro: "nome_vazio" };
    itens.push({ ...(l.produtoId ? { product_id: l.produtoId } : { nome: l.nome.trim() }), ...lida.linha });
  }
  const parsed = vendaCriarSchema.safeParse({
    ...(alvo.contactId ? { contact_id: alvo.contactId } : {}),
    ...(alvo.leadId ? { lead_id: alvo.leadId } : {}),
    ...(alvo.negocioPrevisto ? { negocio_previsto: alvo.negocioPrevisto } : {}),
    ...(dataVenda ? { data_venda: dataVenda } : {}),
    itens,
  });
  if (!parsed.success) return { ok: false, erro: "venda_invalida" };
  return { ok: true, corpo: parsed.data, total_cents: totalDaVenda(parsed.data.itens) };
}
