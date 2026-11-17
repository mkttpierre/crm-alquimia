import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Item 10 (auditoria 05/11/2026): HTTP 2xx da Evolution SEM `key.id` virava
 * `{ externalId: null }`, indistinguível de "canal não configurado" e tratado como
 * enviado normal. Agora o retorno diz que o envio NÃO tem confirmação verificável
 * (`confirmado: false`), e o adapter não reenvia por conta própria.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/evolution/credentials", () => ({
  resolveEvolutionCreds: async () => ({
    baseUrl: "http://evolution.local:8081",
    apiKey: "k",
    instance: "chip-01",
    source: "session" as const,
  }),
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));

import { evolutionAdapter } from "@/lib/channels/adapters/evolution";

const resposta = (corpo: unknown, status = 201) =>
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status,
    json: async () => corpo,
    text: async () => JSON.stringify(corpo),
  });
const envelope = () =>
  ({ organizationId: "org-1", sessionRef: "chip-01", to: "5581999990000", kind: "text", body: "oi" }) as Parameters<
    typeof evolutionAdapter.send
  >[0];

beforeEach(() => {
  fetchMock.mockReset();
  warn.mockClear();
});

describe("send — resposta 2xx sem key.id", () => {
  it("marca o envio como NÃO confirmado, e diz o motivo", async () => {
    resposta({});
    const r = await evolutionAdapter.send(envelope());
    expect(r).toMatchObject({ externalId: null, confirmado: false, motivo: "resposta_sem_key_id" });
  });

  it("não reenvia sozinho: exatamente uma chamada ao transporte", async () => {
    resposta({});
    await evolutionAdapter.send(envelope());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deixa rastro no log (sem conteúdo da mensagem nem destinatário)", async () => {
    resposta({ status: "PENDING" });
    await evolutionAdapter.send(envelope());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("5581999990000");
  });

  it("com key.id o retorno é o de sempre, sem campos extras", async () => {
    resposta({ key: { id: "3EB0A1" } });
    expect(await evolutionAdapter.send(envelope())).toEqual({ externalId: "3EB0A1" });
    expect(warn).not.toHaveBeenCalled();
  });
});
