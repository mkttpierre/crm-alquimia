import { describe, expect, it } from "vitest";

import {
  conferirNaListaViva,
  pontoConectado,
  ehModeloDeChat,
  estadoDosProvedores,
  modelosVivos,
  type CredencialSegura,
} from "@/lib/ai/pontos/modelos-vivos";

/**
 * A tela de Provedores só pode oferecer modelo que a chave do operador libera,
 * e só modelo de CONVERSA. Estes casos prendem as duas metades: o filtro de
 * capacidade e a recusa na escrita (422) do que está fora da lista viva.
 */

function cred(p: Partial<CredencialSegura> = {}): CredencialSegura {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "openai",
    label: "minha chave",
    api_key_last4: "abcd",
    validated_at: "2026-11-16T03:00:00.000Z",
    validation_error: null,
    models_available: ["gpt-5", "text-embedding-3-small", "whisper-1"],
    models_tools: null,
    is_active: true,
    ...p,
  };
}

describe("ehModeloDeChat", () => {
  it.each([
    "gpt-5",
    "gpt-4o-mini",
    "claude-sonnet-4-6",
    "gemini-2.5-pro",
    "openai/gpt-4o",
    "meta-llama/llama-3.3-70b-instruct",
    "minimax/minimax-m3:free",
  ])("%s é conversa", (id) => {
    expect(ehModeloDeChat(id)).toBe(true);
  });

  it.each([
    "text-embedding-3-small",
    "gemini-embedding-001",
    "embedding-gecko-001",
    "whisper-1",
    "gpt-4o-transcribe",
    "tts-1",
    "tts-1-hd",
    "gemini-2.5-flash-preview-tts",
    "dall-e-3",
    "gpt-image-1",
    "imagen-3.0-generate-002",
    "gemini-2.0-flash-preview-image-generation",
    "google/gemini-2.5-flash-image",
    "omni-moderation-latest",
    "text-moderation-latest",
    "gpt-4o-realtime-preview",
    "gpt-4o-audio-preview",
    "sora-2",
    "veo-2.0-generate-001",
    "aqa",
    "davinci-002",
    "babbage-002",
    "",
  ])("%s não é conversa", (id) => {
    expect(ehModeloDeChat(id)).toBe(false);
  });
});

describe("modelosVivos", () => {
  it("lista só conversa, sem repetir, em ordem", () => {
    const c = cred({ models_available: ["gpt-5", "whisper-1", "gpt-4o", "gpt-5"] });
    expect(modelosVivos(c).map((m) => m.model_id)).toEqual(["gpt-4o", "gpt-5"]);
  });

  it("credencial que não passou no teste não libera nada", () => {
    expect(modelosVivos(cred({ validated_at: null }))).toEqual([]);
    expect(modelosVivos(cred({ is_active: false }))).toEqual([]);
  });

  it("sem informação de ferramentas, a capacidade fica desconhecida (null)", () => {
    expect(modelosVivos(cred())[0]!.supports_tools).toBeNull();
  });

  it("com a lista de ferramentas do provedor, o ponto que exige ferramentas só vê quem tem", () => {
    const c = cred({
      provider: "openrouter",
      models_available: ["a/com-tools", "b/sem-tools"],
      models_tools: ["a/com-tools"],
    });
    expect(modelosVivos(c).map((m) => [m.model_id, m.supports_tools])).toEqual([
      ["a/com-tools", true],
      ["b/sem-tools", false],
    ]);
    expect(modelosVivos(c, { exigeFerramentas: true }).map((m) => m.model_id)).toEqual([
      "a/com-tools",
    ]);
  });
});

describe("estadoDosProvedores", () => {
  it("diz quem está conectado, de quando é a lista e se há chave da instalação (só booleano)", () => {
    const estado = estadoDosProvedores({
      provedores: ["openai", "anthropic", "google"],
      credenciais: [
        cred({ id: "a", validated_at: "2026-11-10T00:00:00.000Z" }),
        cred({ id: "b", validated_at: "2026-11-15T00:00:00.000Z" }),
        cred({ id: "c", provider: "anthropic", validated_at: null, validation_error: "auth_failed_401" }),
      ],
      chavesDaInstalacao: { openai: false, anthropic: true },
    });
    const [openai, anthropic, google] = estado;
    expect(openai!.conectado).toBe(true);
    expect(openai!.motivo).toBeNull();
    expect(openai!.listaAtualizadaEm).toBe("2026-11-15T00:00:00.000Z");
    expect(openai!.credenciais[0]!.total_de_modelos).toBe(1);
    expect(anthropic!.conectado).toBe(false);
    expect(anthropic!.daInstalacao).toBe(true);
    expect(anthropic!.motivo).toMatch(/teste/);
    expect(google!.conectado).toBe(false);
    expect(google!.motivo).toMatch(/Nenhuma chave/);
    expect(google!.daInstalacao).toBe(false);
  });

  it("nunca devolve material de chave", () => {
    const estado = estadoDosProvedores({
      provedores: ["openai"],
      credenciais: [{ ...cred(), api_key_encrypted: "SEGREDO" } as unknown as CredencialSegura],
      chavesDaInstalacao: {},
    });
    expect(JSON.stringify(estado)).not.toContain("SEGREDO");
  });
});

describe("conferirNaListaViva (B7: fora da lista é 422)", () => {
  const base = {
    provider: "openai",
    exigeFerramentas: false,
    baseUrl: null,
    daInstalacao: false,
  };

  it("aceita o modelo que a chave libera", () => {
    expect(conferirNaListaViva({ ...base, modelId: "gpt-5", credencial: cred() })).toEqual({ ok: true });
  });

  it("recusa o modelo que a chave não libera", () => {
    const r = conferirNaListaViva({ ...base, modelId: "gpt-inventado", credencial: cred() });
    expect(r.ok === false && r.codigo).toBe("modelo_fora_da_lista");
  });

  it("recusa modelo que não é de conversa, mesmo estando na listagem", () => {
    const r = conferirNaListaViva({ ...base, modelId: "whisper-1", credencial: cred() });
    expect(r.ok === false && r.codigo).toBe("modelo_fora_da_lista");
  });

  it("recusa credencial que não passou no teste", () => {
    const r = conferirNaListaViva({
      ...base,
      modelId: "gpt-5",
      credencial: cred({ validated_at: null }),
    });
    expect(r.ok === false && r.codigo).toBe("credencial_nao_validada");
  });

  it("recusa modelo sem ferramentas em ponto que exige, quando o provedor informa", () => {
    const r = conferirNaListaViva({
      ...base,
      exigeFerramentas: true,
      modelId: "b/sem-tools",
      credencial: cred({ models_available: ["b/sem-tools"], models_tools: [] }),
    });
    expect(r.ok === false && r.codigo).toBe("modelo_sem_ferramentas");
  });

  it("com endereço próprio a lista oficial não vale", () => {
    const r = conferirNaListaViva({
      ...base,
      baseUrl: "https://meu-gateway.exemplo/v1",
      modelId: "modelo-do-meu-gateway",
      credencial: cred(),
    });
    expect(r).toEqual({ ok: true });
  });

  it("sem credencial, passa se a instalação tem a chave (comportamento de antes)", () => {
    expect(
      conferirNaListaViva({ ...base, modelId: "qualquer", credencial: null, daInstalacao: true }),
    ).toEqual({ ok: true });
  });

  it("gateway da instalação NÃO é chave do provedor: sem a chave dele, recusa", () => {
    // O runtime, sem credencial e sem a chave do provedor, cai no modelo PADRÃO
    // pelo gateway — não no modelo que a tela mostrava. Aceitar aqui era
    // gravar um modelo que ninguém executa (o "modelo fictício").
    const r = conferirNaListaViva({ ...base, modelId: "qualquer", credencial: null });
    expect(r.ok === false && r.codigo).toBe("sem_chave");
  });

  it("sem credencial e sem chave da instalação, recusa", () => {
    const r = conferirNaListaViva({ ...base, modelId: "gpt-5", credencial: null });
    expect(r.ok === false && r.codigo).toBe("sem_chave");
  });
});

describe("pontoConectado: o provedor efetivo do ponto tem chave de verdade?", () => {
  const credenciais = [
    cred({ id: "ok", provider: "openai" }),
    cred({ id: "falhou", provider: "openai", validated_at: null }),
  ];

  it("credencial escolhida e validada: conectado", () => {
    expect(
      pontoConectado({ provider: "openai", credentialId: "ok", credenciais, chavesDaInstalacao: {} }),
    ).toBe(true);
  });

  it("credencial escolhida que não passou no teste: desconectado, mesmo havendo outra boa", () => {
    expect(
      pontoConectado({ provider: "openai", credentialId: "falhou", credenciais, chavesDaInstalacao: {} }),
    ).toBe(false);
  });

  it("sem credencial escolhida: vale qualquer credencial validada do provedor ou a chave da instalação", () => {
    expect(
      pontoConectado({ provider: "openai", credentialId: null, credenciais, chavesDaInstalacao: {} }),
    ).toBe(true);
    expect(
      pontoConectado({
        provider: "openrouter",
        credentialId: null,
        credenciais,
        chavesDaInstalacao: { openrouter: true },
      }),
    ).toBe(true);
  });

  it("o caso da produção: Anthropic sem credencial e sem chave da instalação é desconectado", () => {
    expect(
      pontoConectado({
        provider: "anthropic",
        credentialId: null,
        credenciais,
        chavesDaInstalacao: { anthropic: false, openrouter: true },
      }),
    ).toBe(false);
  });
});
