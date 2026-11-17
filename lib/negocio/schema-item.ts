import { z } from "zod";

/** Limites que o banco também confere (migration 0249). */
const CENTS_MAX = 100_000_000_00; // R$ 100 milhões por campo: acima disso é digitação errada, e cabe em bigint com folga.

const centavos = z.number().int().min(0).max(CENTS_MAX);

/**
 * Corpo do POST. Dois jeitos de criar a linha:
 *   · do catálogo: `product_id` — nome, sku e preço são COPIADOS do produto (snapshot) quando não vierem no corpo;
 *   · avulso: sem `product_id` — `nome` e `preco_unit_cents` obrigatórios.
 * A moeda e a organização NUNCA vêm do corpo: a rota usa a do negócio e a do usuário autenticado.
 */
export const itemCriarSchema = z
  .object({
    product_id: z.string().uuid().optional(),
    nome: z.string().trim().min(1).max(200).optional(),
    sku: z.string().trim().min(1).max(80).nullable().optional(),
    quantidade: z.number().int().min(1).max(100_000).default(1),
    preco_unit_cents: centavos.optional(),
    desconto_cents: centavos.default(0),
    acrescimo_cents: centavos.default(0),
    cupom: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.product_id) {
      if (!v.nome) ctx.addIssue({ code: "custom", path: ["nome"], message: "Informe o nome do item ou escolha um produto do catálogo." });
      if (v.preco_unit_cents === undefined) ctx.addIssue({ code: "custom", path: ["preco_unit_cents"], message: "Informe o preço unitário." });
    }
  });
export type ItemCriarInput = z.infer<typeof itemCriarSchema>;

/** Corpo do PATCH: `item_id` + ao menos um campo. Trocar de produto não existe: apague a linha e crie outra. */
export const itemAtualizarSchema = z
  .object({
    item_id: z.string().uuid(),
    nome: z.string().trim().min(1).max(200).optional(),
    sku: z.string().trim().min(1).max(80).nullable().optional(),
    quantidade: z.number().int().min(1).max(100_000).optional(),
    preco_unit_cents: centavos.optional(),
    desconto_cents: centavos.optional(),
    acrescimo_cents: centavos.optional(),
    cupom: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "item_id"), { message: "Nada para alterar." });
export type ItemAtualizarInput = z.infer<typeof itemAtualizarSchema>;

export const itemIdQuerySchema = z.object({ item_id: z.string().uuid() });
