import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O provedor Ollama (modelo local, sem chave) nas camadas que dá para provar sem
 * rede: operações compartilhadas (tela, API com bearer, MCP), a lista viva (B7),
 * o registry de execução e a rota que cadastra a credencial. Nada chama Ollama,
 * OpenRouter ou rede de verdade.
 */

const auditado = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditado(e) }));
vi.mock("@/lib/instalacao/ambiente", () => ({
  lerAmbiente: () => ({ chavesDeProvedor: {}, gateway: false }),
}));

const { crmAiProviders } = await import("@/lib/mcp/tools/provedores");
const operacoes = await import("@/lib/ai/provedores/operacoes");

const ORG = "00000000-0000-4000-8000-00000000000a";
const CRED = "66666666-6666-4666-8666-666666666666";
const CRED_SEM_TESTE = "77777777-7777-4777-8777-777777777777";
const AMBIENTE = { chavesDeProvedor: {}, gateway: false };

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>) {
  const upserts: Linha[] = [];
  function consulta(tabela: string) {
    let linhas = [...(tabelas[tabela] ?? [])];
    let colunas: string[] | null = null;
    const projetar = (l: Linha) =>
      colunas ? Object.fromEntries(colunas.map((c) => [c, l[c] ?? null])) : l;
    const q = {
      select(c: string) {
        colunas = c.split(",").map((s) => s.trim());
        return q;
      },
      eq(col: string, v: unknown) {
        linhas = linhas.filter((l) => l[col] === v);
        return q;
      },
      in(col: string, vs: unknown[]) {
        linhas = linhas.filter((l) => vs.includes(l[col]));
        return q;
      },
      is(col: string, v: unknown) {
        linhas = linhas.filter((l) => (l[col] ?? null) === v);
        return q;
      },
      upsert(l: Linha) {
        upserts.push(l);
        linhas = [{ id: "44444444-4444-4444-8444-444444444444", ...l }];
        return q;
      },
      async maybeSingle() {
        return { data: linhas[0] ? projetar(linhas[0]) : null, error: null };
      },
      then(resolve: (v: { data: Linha[]; error: null }) => unknown) {
        return Promise.resolve({ data: linhas.map(projetar), error: null }).then(resolve);
      },
    };
    return q;
  }
  return { db: { from: consulta } as unknown as SupabaseClient, upserts };
}

function cenario() {
  return bancoFalso({
    ai_provider_credentials_safe: [
      {
        id: CRED,
        organization_id: ORG,
        provider: "ollama",
        label: "Servidor da sala",
        api_key_last4: null,
        base_url: "http://192.168.1.20:11434",
        // O que a view NÃO tem: se vazar para a resposta, o teste acusa.
        api_key_encrypted: "SEGREDO-NAO-DEVE-SAIR",
        validated_at: "2026-11-16T12:00:00.000Z",
        validation_error: null,
        models_available: ["llama3.2:3b", "qwen2.5:7b", "nomic-embed-text:latest"],
        models_tools: null,
        is_active: true,
      },
      {
        id: CRED_SEM_TESTE,
        organization_id: ORG,
        provider: "ollama",
        label: "Fora do ar",
        api_key_last4: null,
        base_url: "http://10.0.0.9:11434",
        validated_at: null,
        validation_error: "ollama_inacessivel",
        models_available: ["llama3.2:3b"],
        models_tools: null,
        is_active: true,
      },
    ],
    ai_models: [],
    ai_purpose_bindings: [],
  });
}

beforeEach(() => auditado.mockClear());

describe("ollama nas operações compartilhadas (tela, API com bearer)", () => {
  it("aparece conectado, com o endereço e sem sinal de chave", async () => {
    const { db } = cenario();
    const r = await operacoes.provedoresConectados(db, ORG, AMBIENTE);
    const ollama = r.provedores.find((p) => p.provider === "ollama")!;
    expect(ollama.conectado).toBe(true);
    expect(ollama.daInstalacao).toBe(false);
    expect(ollama.credenciais.find((c) => c.id === CRED)).toMatchObject({
      base_url: "http://192.168.1.20:11434",
      api_key_last4: null,
      conectada: true,
      total_de_modelos: 2, // o embedding fica de fora
    });
    expect(JSON.stringify(r)).not.toContain("SEGREDO");
  });

  it("não conectado explica em termos de servidor, não de chave", async () => {
    const { db } = bancoFalso({ ai_provider_credentials_safe: [] });
    const r = await operacoes.provedoresConectados(db, ORG, AMBIENTE);
    expect(r.provedores.find((p) => p.provider === "ollama")!.motivo).toMatch(/Ollama.*endereço/);
  });

  it("lista os modelos vivos do servidor e tira o que não é conversa", async () => {
    const { db } = cenario();
    const r = await operacoes.modelosAoVivo(db, ORG, { provider: "ollama", credentialId: CRED });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credenciais[0]!.modelos.map((m) => m.model_id)).toEqual(["llama3.2:3b", "qwen2.5:7b"]);
    expect(r.credenciais[0]!.base_url).toBe("http://192.168.1.20:11434");
    // O provedor local não informa ferramentas: "não sabemos", nunca "não tem".
    expect(r.credenciais[0]!.modelos.every((m) => m.supports_tools === null)).toBe(true);
  });

  it("grava modelo da lista viva, com aviso de que a capacidade não foi verificada", async () => {
    const { db, upserts } = cenario();
    const corpo = operacoes.corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "ollama",
      model_id: "llama3.2:3b",
      credential_id: CRED,
    });
    const r = await operacoes.definirModeloDoPonto(db, ORG, corpo, AMBIENTE, { origem: "sessao" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.avisos.join(" ")).toMatch(/verificar/i);
    expect(upserts[0]).toMatchObject({ provider: "ollama", base_url: null, credential_id: CRED });
  });

  it("B7: modelo que o servidor não listou é recusado", async () => {
    const { db, upserts } = cenario();
    const corpo = operacoes.corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "ollama",
      model_id: "llama3.3:70b",
      credential_id: CRED,
    });
    const r = await operacoes.definirModeloDoPonto(db, ORG, corpo, AMBIENTE, { origem: "sessao" });
    expect(r).toMatchObject({ ok: false, codigo: "modelo_fora_da_lista", status: 422 });
    expect(upserts).toHaveLength(0);
  });

  it("servidor que não passou no teste não libera modelo nenhum", async () => {
    const { db } = cenario();
    const corpo = operacoes.corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "ollama",
      model_id: "llama3.2:3b",
      credential_id: CRED_SEM_TESTE,
    });
    const r = await operacoes.definirModeloDoPonto(db, ORG, corpo, AMBIENTE, { origem: "sessao" });
    expect(r).toMatchObject({ ok: false, codigo: "credencial_nao_validada" });
  });

  it("sem conexão escolhida não há 'da instalação' para o ollama", async () => {
    const { db } = cenario();
    const corpo = operacoes.corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "ollama",
      model_id: "llama3.2:3b",
    });
    const r = await operacoes.definirModeloDoPonto(db, ORG, corpo, AMBIENTE, { origem: "sessao" });
    expect(r).toMatchObject({ ok: false, codigo: "sem_chave" });
  });

  it("o endereço NÃO é do ponto: base_url no ponto do ollama é 422, mesmo pela tela", async () => {
    const { db, upserts } = cenario();
    const corpo = operacoes.corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "ollama",
      model_id: "llama3.2:3b",
      credential_id: CRED,
      base_url: "https://meu-servidor.exemplo.com",
    });
    const r = await operacoes.definirModeloDoPonto(db, ORG, corpo, AMBIENTE, {
      origem: "sessao",
      resolver: async () => {},
    });
    expect(r).toMatchObject({ ok: false, codigo: "provedor_sem_endereco_proprio", status: 422 });
    expect(upserts).toHaveLength(0);
  });
});

describe("ollama no MCP (crm_ai_providers)", () => {
  function ctx() {
    const { db } = cenario();
    return {
      organizationId: ORG,
      role: "admin" as const,
      actor: { type: "user" as const, id: "tok", role: "admin" as const },
      apiTokenId: "55555555-5555-4555-8555-555555555555",
      requestId: "req-1",
      supabase: db,
    };
  }

  it("lista provedores com o ollama, sem chave", async () => {
    const r = (await crmAiProviders.handler({ acao: "listar_provedores" }, ctx())) as {
      provedores: { provider: string; conectado: boolean }[];
    };
    expect(r.provedores.find((p) => p.provider === "ollama")?.conectado).toBe(true);
    expect(JSON.stringify(r)).not.toContain("SEGREDO");
  });

  it("aceita provider ollama em listar_modelos e definir_modelo, e audita pelo token", async () => {
    const lista = (await crmAiProviders.handler(
      { acao: "listar_modelos", provider: "ollama", credential_id: CRED },
      ctx(),
    )) as { ok: boolean; credenciais: { modelos: { model_id: string }[] }[] };
    expect(lista.ok).toBe(true);
    expect(lista.credenciais[0]!.modelos.map((m) => m.model_id)).toContain("llama3.2:3b");

    const def = (await crmAiProviders.handler(
      { acao: "definir_modelo", purpose: "stage_classifier", provider: "ollama", model_id: "qwen2.5:7b", credential_id: CRED },
      ctx(),
    )) as { ok: boolean };
    expect(def.ok).toBe(true);
    expect(auditado).toHaveBeenCalledTimes(1);
  });

  it("agente não define endereço, nem para o ollama", async () => {
    const r = (await crmAiProviders.handler(
      {
        acao: "definir_modelo",
        purpose: "stage_classifier",
        provider: "ollama",
        model_id: "qwen2.5:7b",
        credential_id: CRED,
        base_url: "http://169.254.169.254",
      },
      ctx(),
    )) as { ok: boolean; motivo?: string };
    expect(r).toMatchObject({ ok: false, motivo: "endereco_proprio_so_pela_tela" });
    expect(auditado).not.toHaveBeenCalled();
  });
});

describe("ollama no registry de execução", () => {
  it("o registry executa ollama sem chave, com endereço da credencial ou o padrão", async () => {
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    const registry = createDefaultRegistry();
    expect(registry["ollama"]).toBeTypeOf("function");
    expect(registry["ollama"]!("", "llama3.2:3b", "http://192.168.1.20:11434")).toBeDefined();
    expect(registry["ollama"]!("", "llama3.2:3b")).toBeDefined();
  });

  it("endereço adulterado no banco não vira chamada: lança antes de qualquer rede", async () => {
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    const registry = createDefaultRegistry();
    expect(() => registry["ollama"]!("", "m", "http://169.254.169.254")).toThrow(/Ollama recusado/);
    expect(() => registry["ollama"]!("", "m", "ftp://localhost")).toThrow(/Ollama recusado/);
  });

  it("o fetch do SDK é contido: host fora do endereço da credencial é bloqueado", async () => {
    const { criarModeloOllama } = await import("@/lib/agent-engine/edge/llm/providers");
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    try {
      const modelo = criarModeloOllama("llama3.2:3b", "http://localhost:11434") as unknown as {
        config: { url: (o: { path: string }) => string; fetch: typeof fetch };
      };
      const url = modelo.config.url({ path: "/chat/completions" });
      expect(url).toBe("http://localhost:11434/v1/chat/completions");
      // Mesmo host: passa pelo fetch. Outro host: o egress bloqueia (fail closed).
      await modelo.config.fetch(url, { method: "POST" });
      expect(f).toHaveBeenCalledTimes(1);
      await expect(modelo.config.fetch("http://169.254.169.254/x", {})).rejects.toThrow(/egress bloqueado/);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("POST /api/v1/ai/credentials aceita ollama sem chave", () => {
  const guardar = vi.fn(async (p: unknown) => ({ ok: true as const, id: "cred-1", last4: "", p }));

  async function rota() {
    vi.resetModules();
    vi.doMock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
    vi.doMock("@/lib/auth/require-role", () => ({
      requireRole: async () => ({
        ok: true,
        user: { id: "user-1", idioma: "pt-BR" },
        org: { orgId: ORG },
      }),
    }));
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({ single: async () => ({ data: { id: "cred-1", provider: "ollama" }, error: null }) }),
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
    vi.doMock("@/lib/ai/credenciais/guardar", () => ({ guardarCredencial: (p: unknown) => guardar(p) }));
    return import("@/app/api/v1/ai/credentials/route");
  }

  const pedido = (corpo: unknown) =>
    new Request("http://x/api/v1/ai/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }) as never;

  beforeEach(() => guardar.mockClear());

  it("ollama sem api_key: 201, e quem grava recebe porAdmin e nenhuma chave", async () => {
    const { POST } = await rota();
    const res = await POST(pedido({ provider: "ollama", label: "Local", base_url: "http://localhost:11434" }));
    expect(res.status).toBe(201);
    const arg = guardar.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({ provider: "ollama", baseUrl: "http://localhost:11434", porAdmin: true });
    expect(arg).not.toHaveProperty("apiKey");
  });

  it("ollama com api_key é 422: o segredo nunca seria usado", async () => {
    const { POST } = await rota();
    const res = await POST(pedido({ provider: "ollama", label: "Local", api_key: "sk-qualquer-coisa" }));
    expect(res.status).toBe(422);
    expect(guardar).not.toHaveBeenCalled();
  });

  it("provedor com chave continua exigindo chave e recusando endereço", async () => {
    const { POST } = await rota();
    expect((await POST(pedido({ provider: "openai", label: "x" }))).status).toBe(422);
    expect(
      (await POST(pedido({ provider: "openai", label: "x", api_key: "sk-12345678", base_url: "http://localhost:11434" })))
        .status,
    ).toBe(422);
    expect(guardar).not.toHaveBeenCalled();
  });

  it("política de rede recusando o endereço devolve 422 com o código", async () => {
    guardar.mockResolvedValueOnce({
      ok: false,
      motivo: "endereco",
      endereco: { codigo: "endereco_inseguro", mensagem: "Esse endereço não é aceito." },
    } as never);
    const { POST } = await rota();
    const res = await POST(pedido({ provider: "ollama", label: "x", base_url: "http://169.254.169.254" }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("endereco_inseguro");
  });
});
