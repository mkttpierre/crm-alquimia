import { describe, expect, it } from "vitest";

import { itemAtualizarSchema, itemCriarSchema, itemIdQuerySchema } from "./schema-item";

const PROD = "33333333-3333-4333-8333-333333333331";
const ITEM = "44444444-4444-4444-8444-444444444441";

describe("itemCriarSchema", () => {
  it("item do catálogo só precisa de product_id (quantidade 1 e zeros por padrão)", () => {
    const r = itemCriarSchema.parse({ product_id: PROD });
    expect(r).toMatchObject({ product_id: PROD, quantidade: 1, desconto_cents: 0, acrescimo_cents: 0 });
  });

  it("item avulso exige nome e preço", () => {
    const sem = itemCriarSchema.safeParse({ quantidade: 2 });
    expect(sem.success).toBe(false);
    if (!sem.success) expect(Object.keys(sem.error.flatten().fieldErrors).sort()).toEqual(["nome", "preco_unit_cents"]);
    expect(itemCriarSchema.safeParse({ nome: "Frete extra", preco_unit_cents: 1500 }).success).toBe(true);
  });

  it("recusa centavos fracionados, negativos e quantidade zero", () => {
    expect(itemCriarSchema.safeParse({ nome: "x", preco_unit_cents: 10.5 }).success).toBe(false);
    expect(itemCriarSchema.safeParse({ nome: "x", preco_unit_cents: -1 }).success).toBe(false);
    expect(itemCriarSchema.safeParse({ nome: "x", preco_unit_cents: 1, desconto_cents: -5 }).success).toBe(false);
    expect(itemCriarSchema.safeParse({ nome: "x", preco_unit_cents: 1, quantidade: 0 }).success).toBe(false);
  });

  it("não deixa organization_id nem currency entrarem (viram descartados pelo parse)", () => {
    const r = itemCriarSchema.parse({ product_id: PROD, organization_id: "x", currency: "USD" } as never);
    expect(r).not.toHaveProperty("organization_id");
    expect(r).not.toHaveProperty("currency");
  });

  it("aparado: nome com espaços e cupom vazio", () => {
    expect(itemCriarSchema.parse({ nome: "  Kit  ", preco_unit_cents: 1 }).nome).toBe("Kit");
    expect(itemCriarSchema.safeParse({ nome: "Kit", preco_unit_cents: 1, cupom: "   " }).success).toBe(false);
  });
});

describe("itemAtualizarSchema", () => {
  it("exige item_id e ao menos um campo", () => {
    expect(itemAtualizarSchema.safeParse({ item_id: ITEM }).success).toBe(false);
    expect(itemAtualizarSchema.safeParse({ quantidade: 2 }).success).toBe(false);
    expect(itemAtualizarSchema.safeParse({ item_id: ITEM, quantidade: 2 }).success).toBe(true);
  });

  it("cupom pode ser removido com null", () => {
    expect(itemAtualizarSchema.parse({ item_id: ITEM, cupom: null }).cupom).toBeNull();
  });
});

describe("itemIdQuerySchema", () => {
  it("exige uuid", () => {
    expect(itemIdQuerySchema.safeParse({ item_id: "abc" }).success).toBe(false);
    expect(itemIdQuerySchema.safeParse({ item_id: ITEM }).success).toBe(true);
  });
});
