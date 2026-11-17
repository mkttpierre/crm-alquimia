import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PRODUTO_ID = "33333333-3333-4333-8333-333333333333";

/** O que a rota mandou para o `update` — é sobre isto que as asserções falam. */
let atualizado: Record<string, unknown> | null = null;

function supabaseDeMentira() {
  return {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        atualizado = patch;
        const cadeia = {
          eq: () => cadeia,
          select: () => ({ maybeSingle: async () => ({ data: { id: PRODUTO_ID, ...patch }, error: null }) }),
        };
        return cadeia;
      },
    }),
  };
}

function patch(corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/products/${PRODUTO_ID}`, {
    method: "PATCH",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}
const ctx = { params: Promise.resolve({ id: PRODUTO_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  atualizado = null;
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u", idioma: "pt-BR" }, org: { orgId: ORG_ID } } as never);
  vi.mocked(createClient).mockResolvedValue(supabaseDeMentira() as never);
});

describe("PATCH /api/v1/products/:id — muda o que veio e NÃO encosta no resto", () => {
  /**
   * O botão "Desativar" da tela manda `{ ativo: false }`. Com `.partial()` mantendo os `default()` do schema de criação
   * (Zod 4), a rota gravava também `controla_estoque: true`, `quantidade: 0` e `so_interno`: desativar um produto zerava
   * o estoque dele e ligava o controle de estoque de um produto que não controla.
   */
  it("{ ativo: false } grava SÓ ativo (não reescreve controla_estoque nem quantidade nem so_interno)", async () => {
    const { PATCH } = await import("./route");
    const r = await PATCH(patch({ ativo: false }), ctx);
    expect(r.status).toBe(200);
    expect(atualizado).toEqual({ ativo: false });
  });

  it("reativar também: { ativo: true } grava só ativo", async () => {
    const { PATCH } = await import("./route");
    await PATCH(patch({ ativo: true }), ctx);
    expect(atualizado).toEqual({ ativo: true });
  });

  it("mudar só o preço não reescreve nada além do preço", async () => {
    const { PATCH } = await import("./route");
    await PATCH(patch({ preco_cents: 12345 }), ctx);
    expect(atualizado).toEqual({ preco_cents: 12345 });
  });

  it("o que veio é o que vale: estoque e so_interno explícitos são gravados", async () => {
    const { PATCH } = await import("./route");
    await PATCH(patch({ controla_estoque: false, quantidade: 7, so_interno: true }), ctx);
    expect(atualizado).toEqual({ controla_estoque: false, quantidade: 7, so_interno: true });
  });

  it("corpo vazio continua sendo 422", async () => {
    const { PATCH } = await import("./route");
    expect((await PATCH(patch({}), ctx)).status).toBe(422);
    expect(atualizado).toBeNull();
  });
});
