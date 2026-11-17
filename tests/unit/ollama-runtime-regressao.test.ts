import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REGRESSÃO DO RUNTIME DEPOIS DA 0260 (credencial do Ollama sem chave).
 *
 * Os três caminhos que leem a credencial para EXECUTAR (o resolvedor do agent-engine,
 * a pilha antiga `gateway-binding`, o ensaio `buildModel`) e o revalidar passaram a
 * conhecer um provedor sem chave. O risco é dos dois lados e os casos abaixo prendem
 * os dois:
 *
 *  - ollama: nada é decifrado (não há o que decifrar) e o endereço da credencial é o
 *    destino; endereço que a política recusa nunca vira chamada;
 *  - TODO OUTRO provedor: a consulta é a de antes, SEM `base_url` — um clone que ainda
 *    não aplicou a 0260 não pode perder o atendimento por causa de uma coluna a mais —
 *    e a chave continua sendo decifrada.
 */

const decifrar = vi.hoisted(() => vi.fn(() => "chave-decifrada"));
const banco = vi.hoisted(() => ({
  /** Linhas por tabela, devolvidas por `maybeSingle()`. */
  linhas: {} as Record<string, Record<string, unknown> | null>,
  /** O argumento de `select()` de cada consulta, na ordem. */
  selects: [] as { tabela: string; colunas: string }[],
}));
const validou = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, models: ["llama3.2:3b"] })));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: decifrar,
  byteaToBuffer: (v: unknown) => v,
  bufToBytea: (v: unknown) => v,
  encryptKey: () => ({ ciphertext: "c", iv: "i", tag: "t", last4: "abcd" }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const chain = {
        select: (colunas: string) => {
          banco.selects.push({ tabela, colunas });
          return chain;
        },
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        update: () => chain,
        single: async () => ({ data: banco.linhas[tabela] ?? null, error: null }),
        maybeSingle: async () => ({ data: banco.linhas[tabela] ?? null, error: null }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/ai/gateway", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, resolveLanguageModel: (m: string) => ({ __padrao: true, modelId: m }) };
});

vi.mock("@/lib/ai/provider-validators", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  validateProviderCredential: validou,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "user-1", idioma: "pt-BR" }, org: { orgId: ORG } }),
}));

const ORG = "33333333-3333-4333-8333-333333333333";
const CRED = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  decifrar.mockClear();
  validou.mockClear();
  banco.linhas = {};
  banco.selects = [];
});

// ───────────────────────── resolveOrgLlmConfig (agent-engine) ─────────────────────────

describe("resolveOrgLlmConfig: base_url só para o provedor sem chave", () => {
  /** Pool falso que guarda o SQL de cada consulta. */
  function pool(llm: unknown, credenciais: unknown[]) {
    const sqls: string[] = [];
    return {
      sqls,
      db: {
        query: async (sql: string) => {
          sqls.push(sql);
          return sqls.length === 1 ? { rows: [{ llm }] } : { rows: credenciais };
        },
      } as never,
    };
  }

  it("provedor com chave NÃO pede base_url e decifra a chave", async () => {
    const { resolveOrgLlmConfig } = await import("@/lib/agent-engine/edge/llm/credentials");
    const { sqls, db } = pool({ provider: "anthropic" }, [
      { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
    ]);
    const out = await resolveOrgLlmConfig(db, {}, ORG);
    expect(sqls[1]).not.toMatch(/base_url/);
    expect(decifrar).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ provider: "anthropic", apiKey: "chave-decifrada", baseUrl: null });
  });

  it("o mesmo vale quando a credencial é a ESCOLHIDA (override) de um provedor com chave", async () => {
    const { resolveOrgLlmConfig } = await import("@/lib/agent-engine/edge/llm/credentials");
    const { sqls, db } = pool({ provider: "anthropic" }, [
      { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
    ]);
    await resolveOrgLlmConfig(db, {}, ORG, { provider: "openai", credentialId: CRED });
    expect(sqls[1]).toMatch(/and id = \$2/);
    expect(sqls[1]).not.toMatch(/base_url/);
  });

  it("ollama pede base_url, NÃO decifra nada e devolve o endereço da credencial", async () => {
    const { resolveOrgLlmConfig } = await import("@/lib/agent-engine/edge/llm/credentials");
    const { sqls, db } = pool({ provider: "ollama" }, [
      { api_key_encrypted: null, api_key_iv: null, api_key_tag: null, base_url: "http://192.168.1.20:11434" },
    ]);
    const out = await resolveOrgLlmConfig(db, {}, ORG);
    expect(sqls[1]).toMatch(/base_url/);
    expect(decifrar).not.toHaveBeenCalled();
    expect(out).toMatchObject({ provider: "ollama", baseUrl: "http://192.168.1.20:11434" });
  });

  it("ollama sem nenhuma credencial NÃO cai em chave de plataforma: LlmNotConfiguredError", async () => {
    const { resolveOrgLlmConfig, LlmNotConfiguredError } = await import(
      "@/lib/agent-engine/edge/llm/credentials"
    );
    const { db } = pool({ provider: "ollama" }, []);
    await expect(
      resolveOrgLlmConfig(db, { anthropicApiKey: "sk-ant-plataforma", openaiApiKey: "sk-plataforma" }, ORG),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});

// ───────────────────────── gateway-binding (pilha antiga) ─────────────────────────

describe("gateway-binding com ollama", () => {
  const PADRAO = "anthropic/claude-haiku-4-5" as never;

  function binding(provider: string, extra: Record<string, unknown> = {}) {
    banco.linhas["ai_purpose_bindings"] = {
      provider,
      credential_id: CRED,
      model_id: "llama3.2:3b",
      base_url: null,
      ...extra,
    };
  }

  it("usa o endereço da credencial, sem decifrar, e sai como binding", async () => {
    const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
    binding("ollama");
    banco.linhas["ai_provider_credentials"] = {
      api_key_encrypted: null,
      api_key_iv: null,
      api_key_tag: null,
      base_url: "http://192.168.1.20:11434",
    };
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, PADRAO);
    expect(r?.origem).toBe("binding");
    expect(r?.modelId).toBe("llama3.2:3b");
    expect((r?.model as { __padrao?: boolean }).__padrao).toBeUndefined();
    expect(decifrar).not.toHaveBeenCalled();
    expect(banco.selects.find((s) => s.tabela === "ai_provider_credentials")?.colunas).toMatch(/base_url/);
  });

  it("endereço recusado pela política (metadata) cai no padrão, sem chamada ao endereço", async () => {
    const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
    binding("ollama");
    banco.linhas["ai_provider_credentials"] = {
      api_key_encrypted: null,
      api_key_iv: null,
      api_key_tag: null,
      base_url: "http://169.254.169.254",
    };
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, PADRAO);
    expect(r?.origem).toBe("padrao");
    expect((r?.model as { __padrao?: boolean }).__padrao).toBe(true);
  });

  it("provedor com chave segue sem pedir base_url e decifrando", async () => {
    const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
    binding("openrouter", { model_id: "meta-llama/llama-3.3-70b-instruct" });
    banco.linhas["ai_provider_credentials"] = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, PADRAO);
    expect(r?.origem).toBe("binding");
    expect(decifrar).toHaveBeenCalledTimes(1);
    expect(banco.selects.find((s) => s.tabela === "ai_provider_credentials")?.colunas).not.toMatch(/base_url/);
  });
});

// ───────────────────────── revalidar ─────────────────────────

describe("POST /api/v1/ai/credentials/:id/revalidate", () => {
  async function chamar() {
    const { POST } = await import("@/app/api/v1/ai/credentials/[id]/revalidate/route");
    return POST(new Request("http://x") as never, { params: Promise.resolve({ id: CRED }) });
  }

  it("ollama: não decifra nada e valida pelo endereço gravado", async () => {
    banco.linhas["ai_provider_credentials"] = {
      id: CRED,
      organization_id: ORG,
      provider: "ollama",
      label: "Local",
      api_key_encrypted: null,
      api_key_iv: null,
      api_key_tag: null,
      is_active: true,
      base_url: "http://192.168.1.20:11434",
    };
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(decifrar).not.toHaveBeenCalled();
    expect(validou).toHaveBeenCalledWith("ollama", { apiKey: null, baseUrl: "http://192.168.1.20:11434" });
  });

  it("provedor com chave: decifra e valida pela chave (nada mudou)", async () => {
    banco.linhas["ai_provider_credentials"] = {
      id: CRED,
      organization_id: ORG,
      provider: "openai",
      label: "Minha",
      api_key_encrypted: "x",
      api_key_iv: "y",
      api_key_tag: "z",
      is_active: true,
      base_url: null,
    };
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(decifrar).toHaveBeenCalledTimes(1);
    expect(validou).toHaveBeenCalledWith("openai", { apiKey: "chave-decifrada", baseUrl: null });
  });
});

// ───────────────────────── buildModel (ensaio do agente) ─────────────────────────

describe("buildModel('ollama') no ensaio do agente", () => {
  it("monta o modelo sem chave, com o endereço da credencial ou o padrão", async () => {
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    expect(buildModel("ollama", "", "llama3.2:3b", "http://192.168.1.20:11434")).toBeDefined();
    expect(buildModel("ollama", "", "llama3.2:3b")).toBeDefined();
    expect(buildModel("ollama", "", "llama3.2:3b", null)).toBeDefined();
  });

  it("endereço que a política recusa lança antes de qualquer rede", async () => {
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    expect(() => buildModel("ollama", "", "m", "http://169.254.169.254")).toThrow(/Ollama recusado/);
    expect(() => buildModel("ollama", "", "m", "http://[fd00:ec2::254]")).toThrow(/Ollama recusado/);
  });

  it("não afrouxou: provedor desconhecido continua recusado", async () => {
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    expect(() => buildModel("provedor-que-nao-existe", "k", "m")).toThrow(/unsupported_provider/);
  });
});
