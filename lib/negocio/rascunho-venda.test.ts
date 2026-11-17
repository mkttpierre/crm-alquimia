import { describe, expect, it } from "vitest";

import { lerRascunho, linhaAvulsa, linhaDoProduto, totalDoRascunho } from "./rascunho-venda";

const P1 = { id: "11111111-1111-4111-8111-111111111111", nome: "1 MÊS (BETA)", preco_cents: 12000 };
const P2 = { id: "22222222-2222-4222-8222-222222222222", nome: "3 MESES (BETA)", preco_cents: 18200 };
const CONTATO = "33333333-3333-4333-8333-333333333333";

describe("rascunho da venda", () => {
  it("leva o negócio PREVISTO que o quadro mostrou (id ou \"novo\") para o servidor conferir", () => {
    const l = linhaDoProduto(P1, "a");
    const LEAD = "44444444-4444-4444-8444-444444444444";
    const a = lerRascunho([l], "", { contactId: CONTATO, negocioPrevisto: LEAD });
    expect(a.ok && a.corpo.negocio_previsto).toBe(LEAD);
    const b = lerRascunho([l], "", { contactId: CONTATO, negocioPrevisto: "novo" });
    expect(b.ok && b.corpo.negocio_previsto).toBe("novo");
    const c = lerRascunho([l], "", { contactId: CONTATO });
    expect(c.ok && c.corpo.negocio_previsto).toBeUndefined();
  });

  it("ao escolher o produto o valor vem preenchido (em reais, com vírgula) e fica editável", () => {
    const l = linhaDoProduto(P1, "a");
    expect(l).toMatchObject({ produtoId: P1.id, nome: P1.nome, preco: "120,00", quantidade: "1", desconto: "" });
  });

  it("o valor editado na linha é o que vira o corpo, não o do cadastro", () => {
    const l = { ...linhaDoProduto(P1, "a"), preco: "99,90" };
    const r = lerRascunho([l], "", { contactId: CONTATO });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.corpo.itens[0]).toMatchObject({ product_id: P1.id, preco_unit_cents: 9990 });
  });

  it("várias linhas, quantidade e desconto; total ao vivo", () => {
    const a = linhaDoProduto(P1, "a");
    const b = { ...linhaDoProduto(P2, "b"), quantidade: "2", desconto: "10,00" };
    expect(totalDoRascunho([a, b])).toBe(12000 + 2 * 18200 - 1000);
    const r = lerRascunho([a, b], "2026-11-05", { contactId: CONTATO });
    expect(r.ok && r.total_cents).toBe(47400);
    if (r.ok) expect(r.corpo).toMatchObject({ contact_id: CONTATO, data_venda: "2026-11-05" });
  });

  it("aceita 'R$ 1.299,90' e '1299,9'", () => {
    expect(totalDoRascunho([{ ...linhaDoProduto(P1, "a"), preco: "R$ 1.299,90" }])).toBe(129990);
    expect(totalDoRascunho([{ ...linhaDoProduto(P1, "a"), preco: "1299,9" }])).toBe(129990);
  });

  it("recusa em vez de adivinhar: valor ilegível, quantidade zero, desconto maior que a linha, sem linhas", () => {
    const ok = linhaDoProduto(P1, "a");
    expect(lerRascunho([], "", { contactId: CONTATO })).toEqual({ ok: false, erro: "sem_linhas" });
    expect(lerRascunho([{ ...ok, preco: "doze" }], "", { contactId: CONTATO })).toEqual({ ok: false, erro: "valor_invalido" });
    expect(lerRascunho([{ ...ok, preco: "" }], "", { contactId: CONTATO })).toEqual({ ok: false, erro: "valor_invalido" });
    expect(lerRascunho([{ ...ok, quantidade: "0" }], "", { contactId: CONTATO })).toEqual({ ok: false, erro: "quantidade_invalida" });
    expect(lerRascunho([{ ...ok, desconto: "500,00" }], "", { contactId: CONTATO })).toEqual({ ok: false, erro: "desconto_invalido" });
  });

  it("item avulso precisa de nome; com nome vai sem product_id", () => {
    const sem = linhaAvulsa("x");
    expect(lerRascunho([{ ...sem, preco: "10,00" }], "", { contactId: CONTATO })).toEqual({ ok: false, erro: "nome_vazio" });
    const r = lerRascunho([{ ...sem, nome: "Brinde", preco: "10,00" }], "", { contactId: CONTATO });
    expect(r.ok && r.corpo.itens[0]).toMatchObject({ nome: "Brinde", preco_unit_cents: 1000 });
    expect(r.ok && r.corpo.itens[0]).not.toHaveProperty("product_id");
  });

  it("venda de dentro do dossiê leva o negócio; a data vazia vira hoje (campo omitido)", () => {
    const r = lerRascunho([linhaDoProduto(P1, "a")], "", { contactId: CONTATO, leadId: "44444444-4444-4444-8444-444444444444" });
    expect(r.ok && r.corpo).toMatchObject({ lead_id: "44444444-4444-4444-8444-444444444444" });
    expect(r.ok && r.corpo).not.toHaveProperty("data_venda");
  });

  it("total ao vivo ignora a linha ilegível em vez de quebrar a tela", () => {
    expect(totalDoRascunho([linhaDoProduto(P1, "a"), { ...linhaDoProduto(P2, "b"), preco: "??" }])).toBe(12000);
  });
});
