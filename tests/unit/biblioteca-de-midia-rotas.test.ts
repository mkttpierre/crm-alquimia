/**
 * A biblioteca de mídia (migration 0240): a rota que abre o arquivo só assina o que é da org ativa.
 *
 * Contrato que estes casos prendem: o arquivo de OUTRA organização nunca chega a ganhar URL assinada
 * (404 antes do admin client), um caminho fora de `<org>/biblioteca/` é recusado mesmo que a linha
 * exista, e o caso feliz é um 302 para a URL assinada do bucket privado.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";

const usuario = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@x.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "X", role: "agent" }],
} as AuthUser;
const orgAtiva: ActiveOrg = { orgId: ORG, name: "X", role: "agent" };

const consulta = vi.hoisted(() => ({ linha: null as null | { storage_path: string }, orgFiltrada: "" as string }));
const assinar = vi.hoisted(() => vi.fn(async (_path: string, _ttl: number) => ({ data: { signedUrl: "http://storage.local/assinada?token=x" }, error: null })));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: (col: string, val: string) => {
          if (col === "organization_id") consulta.orgFiltrada = val;
          return q;
        },
        // a RLS de verdade devolve nada para outra org; o dublê imita isso pelo filtro explícito
        maybeSingle: async () => ({ data: consulta.orgFiltrada === ORG ? consulta.linha : null, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: assinar }) } }),
}));

function pedido(): NextRequest {
  return new NextRequest(`https://crm.exemplo/api/v1/media-library/${ITEM}/file`);
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  consulta.linha = { storage_path: `${ORG}/biblioteca/obj-ta-caro-abc.ogg` };
  consulta.orgFiltrada = "";
  assinar.mockClear();
});

describe("GET /api/v1/media-library/[id]/file", () => {
  it("302 para a URL assinada quando o arquivo é da org ativa", async () => {
    const { GET } = await import("@/app/api/v1/media-library/[id]/file/route");
    const res = await GET(pedido(), ctx(ITEM));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://storage.local/assinada?token=x");
    expect(assinar).toHaveBeenCalledWith(`${ORG}/biblioteca/obj-ta-caro-abc.ogg`, 600);
  });

  it("filtra pela org ATIVA (cookie), nunca por algo do pedido", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: { ...orgAtiva, orgId: OUTRA } });
    const { GET } = await import("@/app/api/v1/media-library/[id]/file/route");
    const res = await GET(pedido(), ctx(ITEM));
    expect(res.status).toBe(404);
    expect(assinar).not.toHaveBeenCalled();
  });

  it("recusa caminho fora de <org>/biblioteca/ mesmo com a linha existindo", async () => {
    consulta.linha = { storage_path: `${OUTRA}/biblioteca/dela.ogg` };
    const { GET } = await import("@/app/api/v1/media-library/[id]/file/route");
    const res = await GET(pedido(), ctx(ITEM));
    expect(res.status).toBe(404);
    expect(assinar).not.toHaveBeenCalled();
  });

  it("422 para id que não é uuid, sem tocar no banco", async () => {
    const { GET } = await import("@/app/api/v1/media-library/[id]/file/route");
    const res = await GET(pedido(), ctx("../../x"));
    expect(res.status).toBe(422);
    expect(assinar).not.toHaveBeenCalled();
  });

  it("devolve a resposta de negação do requireRole sem assinar nada", async () => {
    const negado = new Response(null, { status: 403 });
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: negado as never });
    const { GET } = await import("@/app/api/v1/media-library/[id]/file/route");
    const res = await GET(pedido(), ctx(ITEM));
    expect(res.status).toBe(403);
    expect(assinar).not.toHaveBeenCalled();
  });
});
