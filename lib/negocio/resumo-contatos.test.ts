import { describe, expect, it } from "vitest";
import { resumirComprasPorContato } from "./resumo-contatos";

describe("resumo de compras por contato", () => {
  it("conta apenas o pedido pago quando há vínculo explícito com negócio ganho", () => {
    const resultado = resumirComprasPorContato(["a"], {
      negocios: [{ contact_id: "a", lead_id: "n", titulo: "Venda", closed_at: "2026-01-01T00:00:00Z", value_cents: 10000, currency: "BRL", itens: [], order_ids: ["p"] }],
      pedidos: [{ contact_id: "a", id: "p", external_id: "1", ordered_at: "2026-01-02T00:00:00Z", total_cents: 10000, currency: "BRL", status: "paid" }],
    });
    expect(resultado.a).toMatchObject({ total_gasto_cents: 10000, numero_de_compras: 1 });
  });
  it("separa contatos e aplica as mesmas regras de receita e ciclo do historico", () => {
    const resumo = resumirComprasPorContato(["a", "b", "sem"], {
      negocios: [
        { contact_id: "a", lead_id: "n", titulo: "Venda", closed_at: "2026-01-01T00:00:00Z", value_cents: 10000, currency: "BRL", itens: [] },
        { contact_id: "b", lead_id: "x", titulo: "Exterior", closed_at: "2026-01-01T00:00:00Z", value_cents: 999, currency: "USD", itens: [] },
      ],
      pedidos: [
        { contact_id: "a", id: "p", external_id: "1", ordered_at: "2026-01-11T00:00:00Z", total_cents: 5000, currency: "BRL", status: "paid" },
        { contact_id: "a", id: "p2", external_id: "2", ordered_at: "2026-01-20T00:00:00Z", total_cents: 4000, currency: "BRL", status: "pending" },
      ],
    });
    expect(resumo.a).toMatchObject({ total_gasto_cents: 15000, numero_de_compras: 2, ciclo_medio_dias: 10, ultima_compra: "2026-01-11T00:00:00.000Z" });
    expect(resumo.b).toMatchObject({ total_gasto_cents: 0, numero_de_compras: 0, ignoradas_outra_moeda: 1 });
    expect(resumo.sem).toMatchObject({ numero_de_compras: 0, ciclo_medio_dias: null, ultima_compra: null });
  });
});
