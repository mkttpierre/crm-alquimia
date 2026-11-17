import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Credenciais do canal Evolution: sessão primeiro, env como fallback, e a busca
 * SEMPRE escopada por organização (issue #236).
 */
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async (_a: unknown, c: string) => (c === "cifra-ruim" ? null : `plain:${c}`),
}));

import {
  evolutionCredsForInstance,
  evolutionCredsFromEnv,
  resolveEvolutionCreds,
} from "@/lib/channels/evolution/credentials";

const ORG = "org-1";

function adminCom(linha: Record<string, unknown> | null, erro: { code?: string; message?: string } | null = null) {
  const filtros: Array<[string, unknown]> = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (c: string, v: unknown) => (filtros.push([c, v]), q);
  q.is = (c: string, v: unknown) => (filtros.push([c, v]), q);
  q.maybeSingle = async () => ({ data: linha, error: erro });
  return { admin: { from: () => q } as never, filtros };
}

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.EVOLUTION_API_BASE_URL;
  delete process.env.EVOLUTION_API_KEY;
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("evolutionCredsFromEnv", () => {
  it("exige URL, chave e instância", () => {
    expect(evolutionCredsFromEnv("chip")).toBeNull();
    process.env.EVOLUTION_API_BASE_URL = "http://evo:8081/";
    expect(evolutionCredsFromEnv("chip")).toBeNull();
    process.env.EVOLUTION_API_KEY = "k";
    expect(evolutionCredsFromEnv("chip")).toEqual({
      baseUrl: "http://evo:8081",
      apiKey: "k",
      instance: "chip",
      source: "env",
    });
    expect(evolutionCredsFromEnv("")).toBeNull();
  });

  it("env VAZIO (como o .env.example entrega) não vira URL sem host", () => {
    process.env.EVOLUTION_API_BASE_URL = "   ";
    process.env.EVOLUTION_API_KEY = "k";
    expect(evolutionCredsFromEnv("chip")).toBeNull();
  });
});

describe("evolutionCredsForInstance", () => {
  it("filtra por ORGANIZAÇÃO e por instância ativa", async () => {
    const { admin, filtros } = adminCom({
      evolution_instance_name: "chip",
      evolution_base_url: "http://evo-x1:8081/",
      evolution_token_encrypted: "cifra",
    });
    const c = await evolutionCredsForInstance(admin, { organizationId: ORG, instance: "chip" });
    expect(c).toEqual({ baseUrl: "http://evo-x1:8081", apiKey: "plain:cifra", instance: "chip", source: "session" });
    expect(filtros).toContainEqual(["organization_id", ORG]);
    expect(filtros).toContainEqual(["evolution_instance_name", "chip"]);
    expect(filtros).toContainEqual(["archived_at", null]);
  });

  it("chave na sessão e URL só no env: usa a URL do env", async () => {
    process.env.EVOLUTION_API_BASE_URL = "http://evo-env:8080";
    const { admin } = adminCom({
      evolution_instance_name: "chip",
      evolution_base_url: null,
      evolution_token_encrypted: "cifra",
    });
    expect((await evolutionCredsForInstance(admin, { organizationId: ORG, instance: "chip" }))?.baseUrl).toBe(
      "http://evo-env:8080",
    );
  });

  it("sem chave gravada → null (o chamador cai no env)", async () => {
    const { admin } = adminCom({ evolution_instance_name: "chip", evolution_token_encrypted: null });
    expect(await evolutionCredsForInstance(admin, { organizationId: ORG, instance: "chip" })).toBeNull();
  });

  it("decifra que falha → null, em vez de derrubar o envio", async () => {
    const { admin } = adminCom({ evolution_instance_name: "chip", evolution_token_encrypted: "cifra-ruim" });
    expect(await evolutionCredsForInstance(admin, { organizationId: ORG, instance: "chip" })).toBeNull();
  });

  it("erro de consulta LANÇA — descartá-lo mandaria o envio para a conta do .env (#236)", async () => {
    const { admin } = adminCom(null, { code: "PGRST116", message: "2 rows" });
    await expect(evolutionCredsForInstance(admin, { organizationId: ORG, instance: "chip" })).rejects.toThrow(
      /evolution_creds_lookup_failed: PGRST116/,
    );
  });

  it("sem organização ou instância nem consulta", async () => {
    const { admin } = adminCom(null);
    expect(await evolutionCredsForInstance(admin, { organizationId: "", instance: "chip" })).toBeNull();
  });
});

describe("resolveEvolutionCreds", () => {
  it("sessão ganha do env", async () => {
    process.env.EVOLUTION_API_BASE_URL = "http://evo-env:8080";
    process.env.EVOLUTION_API_KEY = "k-env";
    const { admin } = adminCom({
      evolution_instance_name: "chip",
      evolution_base_url: "http://evo-sessao:8081",
      evolution_token_encrypted: "cifra",
    });
    expect((await resolveEvolutionCreds(admin, { organizationId: ORG, instance: "chip" }))?.source).toBe("session");
  });

  it("sem nada na sessão, cai no env", async () => {
    process.env.EVOLUTION_API_BASE_URL = "http://evo-env:8080";
    process.env.EVOLUTION_API_KEY = "k-env";
    const { admin } = adminCom(null);
    expect((await resolveEvolutionCreds(admin, { organizationId: ORG, instance: "chip" }))?.source).toBe("env");
  });
});
