/**
 * O que conta como dinheiro que entrou. UMA definição para o histórico de compra do contato e para o dashboard de
 * faturamento — duas telas com régua diferente contariam histórias diferentes sobre o mesmo cliente.
 *
 *   · negócio do CRM: `status = 'won'`, na data `closed_at`, pelo `value_cents` (que o banco mantém igual à soma dos
 *     itens quando há itens — migration 0249);
 *   · pedido da loja (`orders`): pago ou além (`paid`, `fulfilled`, `shipped`, `delivered`), na data `ordered_at`.
 *     `pending` ainda não pagou; `cancelled` e `refunded` devolveram o dinheiro.
 *
 * Um mesmo pedido da loja pode ter também um negócio ganho no CRM. Os dois são somados porque o CRM não liga um ao
 * outro; por isso as telas mostram a origem (negócio × pedido) separada, e quem opera vê se há sobreposição.
 */
export const STATUS_DE_PEDIDO_COM_RECEITA = ["paid", "fulfilled", "shipped", "delivered"] as const;

export const pedidoTemReceita = (status: string): boolean => (STATUS_DE_PEDIDO_COM_RECEITA as readonly string[]).includes(status);

export const MOEDA_PADRAO = "BRL";
