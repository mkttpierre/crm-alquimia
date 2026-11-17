/**
 * Histórico de compra de um contato (aba "Compras" da tela do contato): negócios ganhos + pedidos da loja pagos.
 * Funções puras — a rota busca as linhas (com a org da sessão) e esta camada só calcula.
 */
import { MOEDA_PADRAO, pedidoTemReceita } from "./receita";

export interface NegocioGanho {
  lead_id: string;
  titulo: string;
  closed_at: string;
  value_cents: number | null;
  currency: string | null;
  itens: Array<{ nome: string; quantidade: number; total_cents: number }>;
}

export interface PedidoDaLoja {
  id: string;
  external_id: string;
  ordered_at: string;
  total_cents: number;
  currency: string;
  status: string;
}

export interface Compra {
  tipo: "negocio" | "pedido";
  id: string;
  titulo: string;
  data: string;
  total_cents: number;
  itens: Array<{ nome: string; quantidade: number; total_cents: number }>;
}

export interface HistoricoDeCompras {
  compras: Compra[];
  total_gasto_cents: number;
  numero_de_compras: number;
  ultima_compra: string | null;
  /** Média de dias entre uma compra e a seguinte; `null` com menos de duas compras. */
  ciclo_medio_dias: number | null;
  ignoradas_outra_moeda: number;
  currency: string;
}

const DIA_MS = 86_400_000;

export function cicloMedioEmDias(datas: string[]): number | null {
  const ms = datas.map((d) => new Date(d).getTime()).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (ms.length < 2) return null;
  let soma = 0;
  for (let i = 1; i < ms.length; i += 1) soma += ms[i]! - ms[i - 1]!;
  const media = soma / (ms.length - 1) / DIA_MS;
  return Math.round(media * 10) / 10;
}

export function montarHistoricoDeCompras(
  entrada: { negocios: NegocioGanho[]; pedidos: PedidoDaLoja[] },
  moeda: string = MOEDA_PADRAO,
): HistoricoDeCompras {
  let ignoradas = 0;
  const compras: Compra[] = [];

  for (const n of entrada.negocios) {
    if ((n.currency ?? moeda) !== moeda) {
      ignoradas += 1;
      continue;
    }
    compras.push({
      tipo: "negocio",
      id: n.lead_id,
      titulo: n.titulo,
      data: new Date(n.closed_at).toISOString(),
      total_cents: n.value_cents ?? 0,
      itens: n.itens,
    });
  }
  for (const p of entrada.pedidos) {
    if (!pedidoTemReceita(p.status)) continue;
    if (p.currency !== moeda) {
      ignoradas += 1;
      continue;
    }
    compras.push({ tipo: "pedido", id: p.id, titulo: `Pedido ${p.external_id}`, data: new Date(p.ordered_at).toISOString(), total_cents: p.total_cents, itens: [] });
  }

  compras.sort((a, b) => b.data.localeCompare(a.data));
  return {
    compras,
    total_gasto_cents: compras.reduce((s, c) => s + c.total_cents, 0),
    numero_de_compras: compras.length,
    ultima_compra: compras[0]?.data ?? null,
    ciclo_medio_dias: cicloMedioEmDias(compras.map((c) => c.data)),
    ignoradas_outra_moeda: ignoradas,
    currency: moeda,
  };
}
