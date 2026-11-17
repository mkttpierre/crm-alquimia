import { describe, expect, it } from "vitest";
import { proximoPollDoRascunho, TETO_RASCUNHO_MS } from "./poll-do-rascunho";

describe("proximoPollDoRascunho", () => {
  it("sem rascunho ou parado não faz polling", () => {
    for (const s of [undefined, "pending", "stale", "rejected", "sent", "failed"]) {
      expect(proximoPollDoRascunho(s, null, 1000)).toBe(false);
    }
  });
  it("gerando ou aprovado faz polling a cada 4s", () => {
    expect(proximoPollDoRascunho("generating", 0, 1000)).toBe(4000);
    expect(proximoPollDoRascunho("approved", null, 1000)).toBe(4000);
  });
  it("para ao passar do teto", () => {
    expect(proximoPollDoRascunho("generating", 0, TETO_RASCUNHO_MS)).toBe(4000);
    expect(proximoPollDoRascunho("generating", 0, TETO_RASCUNHO_MS + 1)).toBe(false);
  });
});
