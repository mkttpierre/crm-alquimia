/** Formato de resposta e mapeamento de erro do Postgres das rotas de itens do negócio (`app/api/v1/leads/[id]/items`). */
import { fail } from "@/lib/api/wrappers";

import type { ItemDoNegocio } from "./repositorio-itens";
import { somaDoNegocio } from "./totais";

export function paraRespostaLista(itens: ItemDoNegocio[], moeda: string, valorDoNegocio: number | null) {
  const soma = somaDoNegocio(itens, moeda);
  return {
    itens,
    currency: moeda,
    total_cents: soma.total_cents,
    ignorados_outra_moeda: soma.ignorados_outra_moeda,
    /** O que está em `crm_leads.value_cents` agora (o banco o mantém igual à soma enquanto houver item na moeda). */
    valor_do_negocio_cents: valorDoNegocio,
  };
}

export function erroDoItem(e: unknown, requestId: string): Response {
  const code = (e as { code?: string } | null)?.code;
  if (code === "23514") return fail("validation_failed", "Valores fora da regra: o desconto não pode passar do valor da linha.", 422, { requestId });
  if (code === "23503") return fail("validation_failed", "O negócio ou o produto não existe mais.", 422, { requestId });
  if (code === "42501") return fail("forbidden", "Você não pode alterar este negócio.", 403, { requestId });
  return fail("internal_error", "Erro ao gravar o item do negócio.", 500, { requestId });
}
