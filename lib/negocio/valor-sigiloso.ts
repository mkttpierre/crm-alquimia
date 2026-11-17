/**
 * VALOR SIGILOSO (migration 0251): o `value_cents` de um negócio com linha de produto interno, ou nascido de "Registrar
 * venda", é a COMISSÃO do operador. A marca é a coluna `crm_leads.valor_sigiloso` (pegajosa, do banco). Este módulo é o que
 * as SAÍDAS PARA FORA da instalação compartilham (webhooks de saída, filtro das ferramentas de IA) para decidir se o dinheiro
 * de um negócio pode sair.
 */

/**
 * Nomes de campo que carregam dinheiro (sem diferenciar maiúsculas). Além dos nomes de preço (cents, amount, price,
 * preco, valor, total), os que a comissão e a conta do dono costumam levar em campo personalizado ou de integração:
 * comissao/comissão, desconto, custo, receita, lucro, margem. `custo` não casa `custom_fields` nem `customer_*`.
 */
export const CAMPO_DE_DINHEIRO = /(cents|amount|price|preco|valor|total|comiss(ao|ão)|desconto|custo(?!m)|receita|lucro|margem)/i;

/** A linha é de um negócio de valor sigiloso? Só a marca do banco (`valor_sigiloso`) decide; a chave de idempotência vive em `crm_venda_chaves` e não é sigilo. */
export function ehNegocioSigiloso(lead: unknown): boolean {
  if (!lead || typeof lead !== "object") return false;
  const l = lead as Record<string, unknown>;
  return l.valor_sigiloso === true;
}

/** Cópia rasa sem os campos de dinheiro (para o payload de um evento de negócio sigiloso). */
export function semCamposDeDinheiro(payload: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (!CAMPO_DE_DINHEIRO.test(k)) saida[k] = v;
  return saida;
}
