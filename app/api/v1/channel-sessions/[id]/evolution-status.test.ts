import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({ remote: "", patch: {} as Record<string, unknown> }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({}), resolveActiveOrg: async () => ({ orgId: "org" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => null, wahaFriendlyError: (s: string) => s }));
vi.mock("@/lib/channels/evolution/client", () => ({ estadoDaInstancia: async () => state.remote }));
vi.mock("@/lib/channels/evolution/credentials", () => ({ resolveEvolutionCreds: async () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => ({ select: () => { const q = { eq: () => q, maybeSingle: async () => ({ data: { id: "session", provider: "evolution", evolution_instance_name: "instance", status: "WORKING", phone_number: null } }) }; return q; }, update: (patch: Record<string, unknown>) => { state.patch = patch; const q = { eq: () => q, then: (resolve: (v: unknown) => void) => resolve({ error: null }) }; return q; } }) }) }));
import { GET } from "./route";

describe("estado Evolution consultado ao vivo", () => {
  it.each([["close", "STOPPED"], ["connecting", "STARTING"]])("reflete %s em vez de manter WORKING", async (remote, expected) => {
    state.remote = remote;
    state.patch = {};
    const response = await GET(new NextRequest("http://localhost/api/v1/channel-sessions/session"), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe(expected);
    expect(state.patch.status).toBe(expected);
  });
});
