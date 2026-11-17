/**
 * O filtro de intervalo (`de`/`ate`) da tela de Leads, para a exportação.
 *
 * "Última compra entre `de` e `ate`" é um valor CALCULADO do histórico de compras do contato (negócios ganhos + pedidos
 * pagos), que só existe depois de `carregarLeads` montar as linhas da tela. Em vez de reescrever essa conta, a
 * exportação chama a mesma leitura e a mesma regra (`ultimaCompraNoIntervalo`) e guarda só os IDS dos contatos que
 * passam; as linhas de negócio são então filtradas por `contact_id` durante o streaming.
 *
 * Custo: a leitura inteira da tela (contatos, negócios e pedidos, no máximo 20 mil linhas por tabela, como a tela) fica
 * na memória durante a preparação, mas só quando o intervalo está ativo; sem `de`/`ate` nada disto roda. Os funis e as tags
 * da organização (que só a tela usa) não são lidos. Passou do teto, a leitura falha com `LimiteDeLeituraExcedido`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { carregarLeads, type FiltrosDoServidor } from "@/lib/negocio/repositorio-leads";
import { ultimaCompraNoIntervalo } from "@/lib/negocio/selecionar-leads";

export interface FiltrosDeIntervalo extends FiltrosDoServidor {
  de?: string;
  ate?: string;
}

/** Os contatos (ids) cuja última compra cai no intervalo, com busca, etiqueta e funil aplicados como na tela. */
export async function idsDeContatosNoIntervalo(
  db: SupabaseClient,
  orgId: string,
  filtros: FiltrosDeIntervalo,
): Promise<Set<string>> {
  const { de, ate, ...doServidor } = filtros;
  const { linhas } = await carregarLeads(db, orgId, doServidor, { semAuxiliares: true });
  return new Set(linhas.filter((l) => ultimaCompraNoIntervalo(l.ultima, de, ate)).map((l) => l.id));
}
