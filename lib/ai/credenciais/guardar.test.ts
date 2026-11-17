import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Validadores from "@/lib/ai/provider-validators";

/**
 * Guardar a credencial: com chave (cifrada) ou sem chave (Ollama, só o endereço).
 * O banco, a cifra e o validador são falsos — o que se prende é QUAIS colunas
 * vão para o INSERT e quem pode gravar endereço interno.
 */

const inserts: Record<string, unknown>[] = [];
const validado = vi.fn(async () => ({ ok: true as const, models: ["llama3.2:3b"] }));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: (k: string) => ({
    ciphertext: Buffer.from("c"),
    iv: Buffer.from("i"),
    tag: Buffer.from("t"),
    last4: k.slice(-4),
  }),
  bufToBytea: (b: Buffer) => "hex:" + b.toString("hex"),
}));
vi.mock("@/lib/ai/provider-validators", async (importOriginal) => ({
  ...(await importOriginal<typeof Validadores>()),
  validateProviderCredential: (...a: unknown[]) => validado(...(a as [])),
}));

const { guardarCredencial } = await import("@/lib/ai/credenciais/guardar");

function admin(erro: { code?: string; message?: string } | null = null) {
  const update = vi.fn(() => ({ eq: () => ({ eq: async () => ({ error: null }) }) }));
  return {
    from: () => ({
      insert: (linha: Record<string, unknown>) => {
        inserts.push(linha);
        return { select: () => ({ single: async () => (erro ? { data: null, error: erro } : { data: { id: "cred-1" }, error: null }) }) };
      },
      update,
    }),
  } as never;
}

const base = { orgId: "org-1", userId: "user-1", label: "Local" };
const interno = async () => ["192.168.1.20"];

beforeEach(() => {
  inserts.length = 0;
  validado.mockClear();
});

describe("guardarCredencial — ollama (sem chave)", () => {
  it("grava as quatro colunas do segredo como NULL e o endereço normalizado", async () => {
    const r = await guardarCredencial({
      ...base,
      admin: admin(),
      provider: "ollama",
      baseUrl: "http://localhost:11434/",
      porAdmin: true,
    });
    expect(r).toMatchObject({ ok: true, id: "cred-1" });
    expect(inserts[0]).toMatchObject({
      provider: "ollama",
      api_key_encrypted: null,
      api_key_iv: null,
      api_key_tag: null,
      api_key_last4: null,
      base_url: "http://localhost:11434",
    });
    await vi.waitFor(() => expect(validado).toHaveBeenCalledTimes(1));
    expect(validado).toHaveBeenCalledWith("ollama", { apiKey: undefined, baseUrl: "http://localhost:11434" }, {});
  });

  it("sem endereço usa o padrão", async () => {
    await guardarCredencial({ ...base, admin: admin(), provider: "ollama", porAdmin: true });
    expect(inserts[0]!.base_url).toBe("http://localhost:11434");
  });

  it("ignora qualquer chave que alguém mande: ela nunca é cifrada nem gravada", async () => {
    await guardarCredencial({
      ...base,
      admin: admin(),
      provider: "ollama",
      apiKey: "sk-nao-deveria-ir",
      porAdmin: true,
    });
    expect(JSON.stringify(inserts[0])).not.toContain("sk-nao");
    expect(inserts[0]!.api_key_encrypted).toBeNull();
  });

  it("endereço interno por quem não é admin é recusado e nada é gravado", async () => {
    const r = await guardarCredencial({
      ...base,
      admin: admin(),
      provider: "ollama",
      baseUrl: "http://192.168.1.20:11434",
      resolver: interno,
    });
    expect(r).toMatchObject({ ok: false, motivo: "endereco", endereco: { codigo: "endereco_local_so_admin" } });
    expect(inserts).toHaveLength(0);
  });

  it("endereço proibido é recusado até para admin", async () => {
    const r = await guardarCredencial({
      ...base,
      admin: admin(),
      provider: "ollama",
      baseUrl: "http://169.254.169.254",
      porAdmin: true,
    });
    expect(r).toMatchObject({ ok: false, motivo: "endereco", endereco: { codigo: "endereco_inseguro" } });
    expect(inserts).toHaveLength(0);
  });
});

describe("guardarCredencial — provedores com chave seguem exigindo chave", () => {
  it("sem chave não grava nada (o CHECK do banco é a segunda trava)", async () => {
    const r = await guardarCredencial({ ...base, admin: admin(), provider: "anthropic" });
    expect(r).toEqual({ ok: false, motivo: "sem_chave" });
    expect(inserts).toHaveLength(0);
  });

  it("com chave, cifra e NÃO grava endereço", async () => {
    const r = await guardarCredencial({ ...base, admin: admin(), provider: "openai", apiKey: "sk-abcdefgh1234" });
    expect(r).toMatchObject({ ok: true, last4: "1234" });
    expect(inserts[0]).toMatchObject({ api_key_last4: "1234" });
    expect(inserts[0]).not.toHaveProperty("base_url");
    expect(JSON.stringify(inserts[0])).not.toContain("sk-abcdefgh");
  });
});
