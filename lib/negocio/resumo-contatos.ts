import { montarHistoricoDeCompras, type NegocioGanho, type PedidoDaLoja, type HistoricoDeCompras } from "./historico-compras";
import { MOEDA_PADRAO, pedidoTemReceita } from "./receita";

export function resumirComprasPorContato(ids: string[], entrada: { negocios: (NegocioGanho & { contact_id: string; order_ids?: string[] })[]; pedidos: (PedidoDaLoja & { contact_id: string })[] }): Record<string, HistoricoDeCompras> {
  const grupos = new Map(ids.map((id) => [id, { negocios: [] as (NegocioGanho & { order_ids?: string[] })[], pedidos: [] as PedidoDaLoja[] }]));
  for (const negocio of entrada.negocios) grupos.get(negocio.contact_id)?.negocios.push(negocio);
  for (const pedido of entrada.pedidos) grupos.get(pedido.contact_id)?.pedidos.push(pedido);
  return Object.fromEntries([...grupos].map(([id, grupo]) => {
    const pedidosContados = new Set(grupo.pedidos.filter((p) => pedidoTemReceita(p.status) && p.currency === MOEDA_PADRAO).map((p) => p.id));
    const negocios = grupo.negocios.filter((n) => !n.order_ids?.some((orderId) => pedidosContados.has(orderId)));
    return [id, montarHistoricoDeCompras({ negocios, pedidos: grupo.pedidos })];
  }));
}
