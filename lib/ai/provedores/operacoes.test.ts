import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  corpoDoPonto,
  definirModeloDoPonto,
  modelosAoVivo,
  provedoresConectados,
} from "@/lib/ai/provedores/operacoes";

/**
 * As três operações que a tela, a API com bearer e o MCP compartilham.
 *
 * O banco é falso de propósito, e mínimo: o que estes casos prendem é a regra
 * (lista viva, filtro de organização, nada de chave na resposta), não o
 * PostgREST. O isolamento real entre organizações é do `test:db`.
 */

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const CRED_OPENAI = "11111111-1111-4111-8111-111111111111";
const CRED_ROUTER = "22222222-2222-4222-8222-222222222222";
const CRED_DE_OUTRA_ORG = "33333333-3333-4333-8333-333333333333";

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>) {
  const upserts: Linha[] = [];
  function consulta(tabela: string) {
    let linhas = [...(tabelas[tabela] ?? [])];
    let colunas: string[] | null = null;
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
      projetar(l: Linha) {
        if (!colunas) return l;
        return Object.fromEntries(colunas.map((c) => [c, l[c] ?? null]));
      },
      async maybeSingle() {
        return { data: linhas[0] ? q.projetar(linhas[0]) : null, error: null };
      },
      then(resolve: (v: { data: Linha[]; error: null }) => unknown) {
        return Promise.resolve({ data: linhas.map((l) => q.projetar(l)), error: null }).then(resolve);
      },
    };
    return q;
  }
  return { db: { from: consulta } as unknown as SupabaseClient, upserts };
}

function credencial(p: Linha): Linha {
  return {
    organization_id: ORG,
    label: "minha chave",
    api_key_last4: "abcd",
    // O que a view NÃO tem: se vazar para a resposta, o teste acusa.
    api_key_encrypted: "SEGREDO-CIFRADO",
    validated_at: "2026-11-16T03:00:00.000Z",
    validation_error: null,
    models_tools: null,
    is_active: true,
    ...p,
  };
}

function cenario(bindings: Linha[] = []) {
  return bancoFalso({
    ai_provider_credentials_safe: [
      credencial({
        id: CRED_OPENAI,
        provider: "openai",
        models_available: ["gpt-5", "gpt-4o-mini", "whisper-1", "text-embedding-3-small"],
      }),
      credencial({
        id: CRED_ROUTER,
        provider: "openrouter",
        models_available: ["a/com-tools", "b/sem-tools"],
        models_tools: ["a/com-tools"],
      }),
      credencial({
        id: CRED_DE_OUTRA_ORG,
        organization_id: OUTRA,
        provider: "openai",
        models_available: ["gpt-5"],
      }),
    ],
    ai_models: [
      { provider: "openai", model_id: "gpt-5", supports_tools: true, supports_vision: true, deprecated_at: null },
      {
        provider: "openai",
        model_id: "gpt-4o-mini",
        supports_tools: false,
        supports_vision: false,
        deprecated_at: null,
      },
    ],
    ai_purpose_bindings: bindings,
  });
}

const AMBIENTE = { chavesDeProvedor: { anthropic: true }, gateway: false };
const resolvePublico = async () => {};
const SESSAO = { origem: "sessao" as const, resolver: resolvePublico };
const AGENTE = { origem: "agente" as const, resolver: resolvePublico };

describe("provedoresConectados", () => {
  it("mostra só a organização pedida e nunca a chave", async () => {
    const { db } = cenario();
    const r = await provedoresConectados(db, ORG, AMBIENTE);
    const openai = r.provedores.find((p) => p.provider === "openai")!;
    expect(openai.conectado).toBe(true);
    expect(openai.credenciais.map((c) => c.id)).toEqual([CRED_OPENAI]);
    expect(r.provedores.find((p) => p.provider === "anthropic")!.daInstalacao).toBe(true);
    expect(JSON.stringify(r)).not.toContain("SEGREDO");
  });
});

describe("modelosAoVivo", () => {
  it("lista os modelos de conversa da chave, completando ferramentas pelo catálogo", async () => {
    const { db } = cenario();
    const r = await modelosAoVivo(db, ORG, { provider: "openai" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credenciais[0]!.modelos).toEqual([
      { model_id: "gpt-4o-mini", supports_tools: false },
      { model_id: "gpt-5", supports_tools: true },
    ]);
    expect(JSON.stringify(r)).not.toContain("SEGREDO");
  });

  it("no ponto que exige ferramentas, some quem comprovadamente não as tem", async () => {
    const { db } = cenario();
    const r = await modelosAoVivo(db, ORG, { provider: "openrouter", purpose: "operator_turn" });
    expect(r.ok && r.exigeFerramentas).toBe(true);
    if (!r.ok) return;
    expect(r.credenciais[0]!.modelos.map((m) => m.model_id)).toEqual(["a/com-tools"]);
  });

  it("ponto desconhecido é 404", async () => {
    const { db } = cenario();
    const r = await modelosAoVivo(db, ORG, { provider: "openai", purpose: "nao-existe" });
    expect(r.ok === false && r.status).toBe(404);
  });
});

describe("definirModeloDoPonto", () => {
  it("grava o modelo da lista viva, na organização de quem chamou", async () => {
    const { db, upserts } = cenario();
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "openai",
      model_id: "gpt-4o-mini",
      credential_id: CRED_OPENAI,
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r.ok).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.organization_id).toBe(ORG);
  });

  it("modelo fora da lista viva é 422 claro (B7)", async () => {
    const { db, upserts } = cenario();
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "openai",
      model_id: "gpt-que-a-chave-nao-libera",
      credential_id: CRED_OPENAI,
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r).toMatchObject({ ok: false, codigo: "modelo_fora_da_lista", status: 422 });
    expect(upserts).toHaveLength(0);
  });

  it("chave de outra organização não é encontrada", async () => {
    const { db } = cenario();
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "openai",
      model_id: "gpt-5",
      credential_id: CRED_DE_OUTRA_ORG,
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r).toMatchObject({ ok: false, codigo: "credencial_invalida", status: 422 });
  });

  it("a lista de ferramentas do provedor manda: modelo sem ferramentas no ponto que exige é 422", async () => {
    const { db } = cenario();
    const corpo = corpoDoPonto.parse({
      purpose: "operator_turn",
      provider: "openrouter",
      model_id: "b/sem-tools",
      credential_id: CRED_ROUTER,
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r).toMatchObject({ ok: false, codigo: "modelo_sem_ferramentas", status: 422 });
  });

  it("sem credencial e com chave da instalação segue como antes (catálogo, sem lista viva)", async () => {
    const { db } = cenario();
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "anthropic",
      model_id: "claude-qualquer",
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r.ok).toBe(true);
  });

  it("sem credencial e sem chave da instalação é 422", async () => {
    const { db } = cenario();
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "google",
      model_id: "gemini-2.5-pro",
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r).toMatchObject({ ok: false, codigo: "sem_chave", status: 422 });
  });
});

describe("endereço próprio (base_url) é para onde a chave vai", () => {
  const comBase = (base_url: string) =>
    corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "openai",
      model_id: "modelo-do-meu-gateway",
      credential_id: CRED_OPENAI,
      base_url,
    });

  it("pela API com bearer ou pelo MCP, base_url é 422", async () => {
    const { db, upserts } = cenario();
    const r = await definirModeloDoPonto(db, ORG, comBase("https://gw.exemplo.com/v1"), AMBIENTE, AGENTE);
    expect(r).toMatchObject({ ok: false, codigo: "endereco_proprio_so_pela_tela", status: 422 });
    expect(upserts).toHaveLength(0);
  });

  it("o agente que não manda base_url preserva o que o admin gravou (mesmo provedor)", async () => {
    const { db, upserts } = cenario([
      {
        organization_id: ORG,
        purpose: "stage_classifier",
        provider: "openai",
        model_id: "gpt-5",
        credential_id: CRED_OPENAI,
        base_url: "https://gw.exemplo.com/v1",
        is_enabled: true,
      },
    ]);
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "openai",
      model_id: "gpt-5",
      credential_id: CRED_OPENAI,
      is_enabled: false,
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, AGENTE);
    expect(r.ok).toBe(true);
    expect(upserts[0]!.base_url).toBe("https://gw.exemplo.com/v1");
  });

  it.each([
    "http://gw.exemplo.com/v1",
    "https://localhost:11434/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.5/v1",
    "https://192.168.1.10/v1",
    "https://169.254.169.254/latest",
    "https://[::1]/v1",
    "https://[fe80::1]/v1",
    "https://maquina.local/v1",
    "https://user:senha@gw.exemplo.com/v1",
  ])("pela tela, %s é 422", async (url) => {
    const { db, upserts } = cenario();
    const r = await definirModeloDoPonto(db, ORG, comBase(url), AMBIENTE, SESSAO);
    expect(r).toMatchObject({ ok: false, codigo: "endereco_proprio_inseguro", status: 422 });
    expect(upserts).toHaveLength(0);
  });

  it("nome que resolve para rede interna é 422", async () => {
    const { db } = cenario();
    const r = await definirModeloDoPonto(db, ORG, comBase("https://interno.exemplo.com/v1"), AMBIENTE, {
      origem: "sessao",
      resolver: async () => {
        throw new Error("unsafe_url:private_ip");
      },
    });
    expect(r).toMatchObject({ ok: false, codigo: "endereco_proprio_inseguro" });
  });

  it("https público pela tela passa, com aviso de que a lista da chave não foi conferida", async () => {
    const { db, upserts } = cenario();
    const r = await definirModeloDoPonto(db, ORG, comBase("https://gw.exemplo.com/v1"), AMBIENTE, SESSAO);
    expect(r.ok).toBe(true);
    expect(r.ok && r.avisos.join(" ")).toMatch(/endereço próprio/);
    expect(upserts[0]!.base_url).toBe("https://gw.exemplo.com/v1");
  });

  it("provedor que não aceita endereço próprio recusa base_url", async () => {
    const { db } = cenario();
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "anthropic",
      model_id: "claude-x",
      base_url: "https://gw.exemplo.com/v1",
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r).toMatchObject({ ok: false, codigo: "provedor_sem_endereco_proprio", status: 422 });
  });
});

describe("a lista viva só é conferida quando modelo ou chave mudam", () => {
  const gravado = {
    organization_id: ORG,
    purpose: "stage_classifier",
    provider: "openai",
    // Modelo que a lista viva de hoje NÃO tem (a lista mudou depois de salvo).
    model_id: "gpt-antigo",
    credential_id: CRED_OPENAI,
    base_url: null,
    is_enabled: true,
  };

  it("desligar o ponto com o mesmo modelo nunca dá 422", async () => {
    const { db, upserts } = cenario([gravado]);
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "openai",
      model_id: "gpt-antigo",
      credential_id: CRED_OPENAI,
      is_enabled: false,
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r.ok).toBe(true);
    expect(upserts[0]!.is_enabled).toBe(false);
  });

  it("trocar o modelo para um fora da lista continua 422", async () => {
    const { db } = cenario([gravado]);
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "openai",
      model_id: "gpt-outro-inventado",
      credential_id: CRED_OPENAI,
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r).toMatchObject({ ok: false, codigo: "modelo_fora_da_lista" });
  });

  it("binding de outra organização não conta como 'já gravado'", async () => {
    const { db } = cenario([{ ...gravado, organization_id: OUTRA }]);
    const corpo = corpoDoPonto.parse({
      purpose: "stage_classifier",
      provider: "openai",
      model_id: "gpt-antigo",
      credential_id: CRED_OPENAI,
    });
    const r = await definirModeloDoPonto(db, ORG, corpo, AMBIENTE, SESSAO);
    expect(r).toMatchObject({ ok: false, codigo: "modelo_fora_da_lista" });
  });
});
