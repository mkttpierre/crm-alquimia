// @vitest-environment node
/**
 * createLeadHandler acrescenta tag de origem comprovada, nunca remove a
 * existente, e a falha ao ler as regras NÃO impede o lead de nascer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const PIPE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";

function admin(settings: unknown, falha = false) {
  const from = (tabela: string) => {
    const elo: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) elo[m] = () => elo;
    elo.maybeSingle = () =>
      tabela === "organizations"
        ? falha
          ? Promise.reject(new Error("banco fora"))
          : Promise.resolve({ data: { settings }, error: null })
        : Promise.resolve({ data: null, error: null });
    return elo;
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from,
    rpc: () => Promise.resolve({ error: null }),
  } as never);
}

function userDb() {
  const inseridos: Record<string, unknown>[] = [];
  const from = (tabela: string) => {
    const elo: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) elo[m] = () => elo;
    elo.insert = (linha: Record<string, unknown>) => {
      inseridos.push(linha);
      return elo;
    };
    elo.single = () => Promise.resolve({ data: { id: "l1", pipeline_id: PIPE, stage_id: STAGE, title: "T" }, error: null });
    elo.maybeSingle = () =>
      Promise.resolve({
        data: tabela === "crm_stages" ? { id: STAGE, pipeline_id: PIPE, organization_id: ORG } : null,
        error: null,
      });
    return elo;
  };
  return { db: { from } as never, inseridos };
}

const ctx = { organization_id: ORG, actor: { type: "user", id: "u" }, requestId: "r" } as never;
const base = { pipeline_id: PIPE, stage_id: STAGE, title: "T", source: "import_planilha" } as never;

describe("createLeadHandler e a tag de origem", () => {
  beforeEach(() => vi.clearAllMocks());

  it("acrescenta a tag da fonte e preserva as existentes", async () => {
    admin({ origem: { produtos: [], por_fonte: { import_planilha: "ORIGEM FRIA" } } });
    const { db, inseridos } = userDb();
    await createLeadHandler(db, ctx, { ...(base as object), tags: ["quente"] } as never);
    expect(inseridos[0]!.tags).toEqual(["quente", "ORIGEM FRIA"]);
  });

  it("sem regra, não muda as tags", async () => {
    admin({});
    const { db, inseridos } = userDb();
    await createLeadHandler(db, ctx, { ...(base as object), tags: ["quente"] } as never);
    expect(inseridos[0]!.tags).toEqual(["quente"]);
  });

  it("falha ao ler as regras não impede o lead de nascer", async () => {
    admin({}, true);
    const { db, inseridos } = userDb();
    await createLeadHandler(db, ctx, base);
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]!.tags).toEqual([]);
  });
});
