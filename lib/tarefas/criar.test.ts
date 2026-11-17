// @vitest-environment node
/**
 * A pessoa responsável pela tarefa é conferida SEM a RLS de quem cria.
 *
 * A policy de SELECT de `user_organizations` é self-OU-admin: um atendente (`agent`) só lê a PRÓPRIA linha. Conferir
 * `assigned_to` com o cliente da sessão recusava toda tarefa que um atendente atribuía a um colega ("a pessoa
 * vinculada não existe"). O dublê da sessão imita essa RLS (só a linha de quem chama); o do admin vê a organização
 * inteira. A conferência continua filtrada por organização e por convite não revogado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { bancoDuble } from "@/tests/helpers/disparo-db-double";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "44444444-4444-4444-8444-444444444444";
const CAIO = "55555555-5555-4555-8555-555555555555";
const DORA = "66666666-6666-4666-8666-666666666666";

const membro = (user_id: string, organization_id: string, revoked_at: string | null = null) => ({
  user_id,
  organization_id,
  role: "agent",
  revoked_at,
});

let sessao: ReturnType<typeof bancoDuble>;
let admin: ReturnType<typeof bancoDuble>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ANA, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as never);
  const membros = [membro(ANA, ORG), membro(BETO, ORG), membro(CAIO, OUTRA), membro(DORA, ORG, "2026-11-01T00:00:00Z")];
  // A sessão do atendente: a RLS só deixa ver a própria linha de `user_organizations`.
  sessao = bancoDuble({ user_organizations: membros.filter((m) => m.user_id === ANA) });
  admin = bancoDuble({ user_organizations: membros });
  vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
  vi.mocked(createAdminClient).mockReturnValue(admin.cliente as never);
});

const post = (corpo: unknown) =>
  new NextRequest("http://localhost/api/v1/tasks", { method: "POST", body: JSON.stringify(corpo), headers: { "content-type": "application/json" } });

describe("POST /api/v1/tasks — atendente atribui a um colega", () => {
  it("papel agent atribui a um colega ativo da organização: 201", async () => {
    const { POST } = await import("@/app/api/v1/tasks/route");
    const res = await POST(post({ title: "Ligar de volta", assigned_to: BETO }));
    expect(res.status).toBe(201);
    expect(sessao.linhas("crm_tasks")).toHaveLength(1);
    expect(sessao.linhas("crm_tasks")[0]).toMatchObject({ organization_id: ORG, assigned_to: BETO, created_by: ANA });
  });

  it("pessoa de outra organização ou com convite revogado: 422 e nada gravado", async () => {
    const { POST } = await import("@/app/api/v1/tasks/route");
    expect((await POST(post({ title: "x", assigned_to: CAIO }))).status).toBe(422);
    expect((await POST(post({ title: "x", assigned_to: DORA }))).status).toBe(422);
    expect(sessao.linhas("crm_tasks")).toHaveLength(0);
  });
});
