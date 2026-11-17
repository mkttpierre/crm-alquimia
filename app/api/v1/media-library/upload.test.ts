// @vitest-environment node
// Multipart real precisa do realm do Node (ver app/api/v1/products/import/route.test.ts).
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

type Linha = { id: string; organization_id: string; kind: string; name: string; mime: string; size_bytes: number; sha256: string; storage_path: string };

let linhas: Linha[] = [];
let uploads: string[] = [];

function adminFalso() {
  return {
    storage: {
      from: () => ({
        upload: async (caminho: string) => {
          uploads.push(caminho);
          return { data: { path: caminho }, error: null };
        },
      }),
    },
    from: () => ({
      select: () => {
        const filtro: Record<string, string> = {};
        const q = {
          eq: (col: string, v: string) => {
            filtro[col] = v;
            return q;
          },
          maybeSingle: async () => ({
            data: linhas.find((l) => Object.entries(filtro).every(([k, v]) => (l as Record<string, unknown>)[k] === v)) ?? null,
            error: null,
          }),
        };
        return q;
      },
      insert: (row: Omit<Linha, "id">) => ({
        select: () => ({
          single: async () => {
            const nova = { ...row, id: `id-${linhas.length + 1}` } as Linha;
            linhas.push(nova);
            return { data: nova, error: null };
          },
        }),
      }),
    }),
  };
}

function pedido(arquivo: File, extra: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.set("file", arquivo);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new NextRequest("http://localhost/api/v1/media-library", { method: "POST", body: form });
}

const mp3 = () => new File([new Uint8Array([1, 2, 3, 4])], "valores.mp3", { type: "audio/mpeg" });

beforeEach(() => {
  vi.clearAllMocks();
  linhas = [];
  uploads = [];
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER_ID }, org: { orgId: ORG_ID } } as never);
  vi.mocked(createAdminClient).mockReturnValue(adminFalso() as never);
});

describe("POST /api/v1/media-library — subir arquivo", () => {
  it("mp3 vira áudio, sobe no caminho da org e responde 201", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido(mp3()));
    expect(res.status).toBe(201);
    const corpo = (await res.json()) as { data: { kind: string; name: string; size_bytes: number } };
    expect(corpo.data).toMatchObject({ kind: "audio", name: "valores.mp3", size_bytes: 4 });
    const sha = createHash("sha256").update(new Uint8Array([1, 2, 3, 4])).digest("hex");
    expect(uploads).toEqual([`${ORG_ID}/biblioteca/${sha}.mp3`]);
  });

  it("o mesmo arquivo de novo responde 200 com o mesmo id, sem subir outra vez", async () => {
    const { POST } = await import("./route");
    const r1 = (await (await POST(pedido(mp3()))).json()) as { data: { id: string } };
    const res2 = await POST(pedido(mp3()));
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { data: { id: string } }).data.id).toBe(r1.data.id);
    expect(uploads).toHaveLength(1);
  });

  it("acima de 50 MB é recusado com 413", async () => {
    const { POST } = await import("./route");
    const grande = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "grande.mp4", { type: "video/mp4" });
    expect((await POST(pedido(grande))).status).toBe(413);
  });

  it("exige papel agent (viewer recebe a resposta do gate)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const { POST } = await import("./route");
    expect((await POST(pedido(mp3()))).status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
  });

  it("a organização vem da sessão, nunca do corpo", async () => {
    const { POST } = await import("./route");
    await POST(pedido(mp3(), { organization_id: "99999999-9999-4999-8999-999999999999" }));
    expect(linhas[0]?.organization_id).toBe(ORG_ID);
    expect(uploads[0]?.startsWith(`${ORG_ID}/`)).toBe(true);
  });

  it("pdf vira documento", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido(new File([new Uint8Array([9])], "contrato.pdf", { type: "application/pdf" })));
    expect(((await res.json()) as { data: { kind: string } }).data.kind).toBe("document");
  });
});
