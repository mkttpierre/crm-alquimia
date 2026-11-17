import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * O GET é pollado pela Central de Conexões. Gravar `last_health_check_at` em
 * toda chamada custava ~89 ms de UPDATE (medido em produção) e ainda disparava
 * evento de Realtime. O carimbo só é regravado quando algo mudou de verdade ou
 * quando o gravado tem mais de 60 s.
 */
const banco = vi.hoisted(() => ({
  remote: "open",
  linha: {} as Record<string, unknown>,
  escritas: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({}), resolveActiveOrg: async () => ({ orgId: "org" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => null, wahaFriendlyError: (s: string) => s }));
vi.mock("@/lib/channels/evolution/client", () => ({ estadoDaInstancia: async () => banco.remote }));
vi.mock("@/lib/channels/evolution/credentials", () => ({ resolveEvolutionCreds: async () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => {
        const q = { eq: () => q, maybeSingle: async () => ({ data: { ...banco.linha } }) };
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        banco.escritas.push(patch);
        banco.linha = { ...banco.linha, ...patch };
        const q = { eq: () => q, then: (resolve: (v: unknown) => void) => resolve({ error: null }) };
        return q;
      },
    }),
  }),
}));
import { GET } from "./route";

const chamar = () =>
  GET(new NextRequest("http://localhost/api/v1/channel-sessions/session"), { params: Promise.resolve({ id: "session" }) });

describe("carimbo de saúde do GET de canal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    banco.remote = "open";
    banco.escritas = [];
    banco.linha = {
      id: "session",
      provider: "evolution",
      evolution_instance_name: "instance",
      waha_session_name: null,
      display_name: "Chip",
      phone_number: null,
      status: "WORKING",
      last_health_check_at: null,
    };
  });
  afterEach(() => vi.useRealTimers());

  it("dois GETs seguidos sem mudança gravam no máximo uma vez", async () => {
    await chamar();
    vi.advanceTimersByTime(3_000);
    const segunda = await chamar();
    expect(segunda.status).toBe(200);
    expect(banco.escritas).toHaveLength(1);
    // A resposta devolve o carimbo que está no banco, não um novo.
    expect((await segunda.json()).data.last_health_check_at).toBe("2026-11-10T12:00:00.000Z");
  });

  it("carimbo com mais de 60 s é regravado", async () => {
    await chamar();
    vi.advanceTimersByTime(61_000);
    await chamar();
    expect(banco.escritas).toHaveLength(2);
  });

  it("mudança de status grava mesmo com o carimbo fresco", async () => {
    await chamar();
    banco.remote = "close";
    vi.advanceTimersByTime(3_000);
    await chamar();
    expect(banco.escritas).toHaveLength(2);
    expect(banco.escritas[1]).toMatchObject({ status: "STOPPED" });
  });
});
