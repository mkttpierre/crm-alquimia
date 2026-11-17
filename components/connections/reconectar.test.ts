import { expect, it } from "vitest";
import * as connections from "./ConnectionsClient";

it("oferece reconexão para Evolution e WAHA, mas não para o canal oficial", () => {
  const regra = (connections as unknown as { podeReconectar: (c: { provider: string; waha_session_name: string | null }) => boolean }).podeReconectar;
  expect(regra({ provider: "evolution", waha_session_name: null })).toBe(true);
  expect(regra({ provider: "waha", waha_session_name: "sessao" })).toBe(true);
  expect(regra({ provider: "meta_cloud", waha_session_name: null })).toBe(false);
});
