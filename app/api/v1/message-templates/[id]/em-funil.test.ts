// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { repositorioFunisSupabase } from "@/lib/inbox/atalhos/repositorio-funis";
import { createClient } from "@/lib/supabase/server";
import { updateTemplateSchema } from "@/lib/schemas/templates";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/atalhos/repositorio-funis", () => ({ repositorioFunisSupabase: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TPL = "33333333-3333-4333-8333-333333333331";

/** DELETE que o Postgres recusa pela FK do passo de funil (23503). */
const supabaseComFkViolada = {
  from: () => ({
    delete: () => ({
      eq: () => ({
        eq: () => ({
          select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23503", message: "violates foreign key" } }) }),
        }),
      }),
    }),
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u", idioma: "pt-BR" }, org: { orgId: ORG_ID, role: "manager" } } as never);
});

describe("modelo de mensagem usado em funil", () => {
  it("apagar modelo que está num funil responde 409 com o nome do funil", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseComFkViolada as never);
    vi.mocked(repositorioFunisSupabase).mockReturnValue({ funisQueUsam: vi.fn(async () => ["Funil de valores"]) } as never);
    const { DELETE } = await import("./route");
    const res = await DELETE(new NextRequest(`http://localhost/api/v1/message-templates/${TPL}`, { method: "DELETE" }), { params: Promise.resolve({ id: TPL }) });
    expect(res.status).toBe(409);
    const corpo = (await res.json()) as { error: { code: string; details: { funis: string[] } } };
    expect(corpo.error.code).toBe("template_in_funnel");
    expect(corpo.error.details.funis).toEqual(["Funil de valores"]);
  });

  it("o PATCH aceita favorito, palavras-chave e anexo", () => {
    const r = updateTemplateSchema.safeParse({ favorito: true, palavras_chave: ["valores", "preço"], media_id: TPL });
    expect(r.success).toBe(true);
  });
});
