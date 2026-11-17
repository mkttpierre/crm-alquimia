import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { dispatchWahaEvent } from "./ingest";

const session = { id: "session", organization_id: "org", is_warmup_complete: true, warmup_started_at: null };
const event = { event: "message", payload: { id: "message-1", from: "15551234567@c.us", body: "oi", fromMe: false } };

describe("falhas de persistência na entrada", () => {
  it.each(["contact", "conversation", "message"])("propaga falha de %s para permitir reentrega", async (stage) => {
    const admin = {
      rpc: async (name: string) => name === "fn_upsert_wa_contact"
        ? stage === "contact" ? { data: null, error: { message: "db failure" } } : { data: "contact", error: null }
        : stage === "conversation" ? { data: null, error: { message: "db failure" } } : { data: "conversation", error: null },
      from: () => ({ insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "XX000", message: "db failure" } }) }) }) }),
    };
    await expect(dispatchWahaEvent(admin as never, session, event, "request")).rejects.toThrow();
  });
});
