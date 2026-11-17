import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ferramentas do MCP para provedores de IA (B6): as mesmas operações da tela,
 * com papel admin, auditoria e a chave nunca na resposta.
 */

const auditado = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditado(e) }));
vi.mock("@/lib/instalacao/ambiente", () => ({
  lerAmbiente: () => ({ chavesDeProvedor: { anthropic: true }, gateway: false }),
}));

const { crmAiProviders } = await import("@/lib/mcp/tools/provedores");
const { catalogEntry } = await import("@/lib/mcp/tools/catalog");

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const CRED = "11111111-1111-4111-8111-111111111111";
const CRED_OUTRA = "33333333-3333-4333-8333-333333333333";

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
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
  return { from: consulta } as unknown as SupabaseClient;
}

function ctx() {
  const base = {
    organization_id: ORG,
    provider: "openai",
    label: "minha chave",
    api_key_last4: "abcd",
    api_key_encrypted: "SEGREDO-CIFRADO",
    validated_at: "2026-11-16T03:00:00.000Z",
    validation_error: null,
    models_available: ["gpt-5", "whisper-1"],
    models_tools: null,
    is_active: true,
  };
  return {
    organizationId: ORG,
    role: "admin" as const,
    actor: { type: "user" as const, id: "tok", role: "admin" as const },
    apiTokenId: "55555555-5555-4555-8555-555555555555",
    requestId: "req-1",
    supabase: bancoFalso({
      ai_provider_credentials_safe: [
        { id: CRED, ...base },
        { id: CRED_OUTRA, ...base, organization_id: OUTRA },
      ],
      ai_models: [],
      ai_purpose_bindings: [],
    }),
  };
}

beforeEach(() => auditado.mockClear());

describe("ferramentas de provedores de IA no MCP", () => {
  it("exige admin e escopo de escrita, e fica fora do alcance do agente que atende", () => {
    expect(crmAiProviders.requiresRole).toBe("admin");
    expect(crmAiProviders.requiresScope).toBe("mcp:write");
    expect(catalogEntry(crmAiProviders.name)?.apenasHumano).toBe(true);
  });

  it("definir sem os campos obrigatórios é recusado com motivo", async () => {
    const r = (await crmAiProviders.handler({ acao: "definir_modelo" } as never, ctx())) as {
      ok: boolean;
      motivo?: string;
    };
    expect(r).toMatchObject({ ok: false, motivo: "corpo_invalido" });
    expect(auditado).not.toHaveBeenCalled();
  });

  it("listar provedores não devolve a chave e não mistura organizações", async () => {
    const r = (await crmAiProviders.handler({ acao: "listar_provedores" }, ctx())) as {
      provedores: { provider: string; credenciais: { id: string }[]; daInstalacao: boolean }[];
    };
    const openai = r.provedores.find((p) => p.provider === "openai")!;
    expect(openai.credenciais.map((c) => c.id)).toEqual([CRED]);
    expect(r.provedores.find((p) => p.provider === "anthropic")!.daInstalacao).toBe(true);
    expect(JSON.stringify(r)).not.toContain("SEGREDO");
  });

  it("listar modelos devolve a lista viva só de conversa", async () => {
    const r = (await crmAiProviders.handler({ acao: "listar_modelos", provider: "openai" }, ctx())) as {
      ok: boolean;
      credenciais: { modelos: { model_id: string }[] }[];
    };
    expect(r.ok).toBe(true);
    expect(r.credenciais[0]!.modelos.map((m) => m.model_id)).toEqual(["gpt-5"]);
  });

  it("definir modelo fora da lista viva é recusado e não audita", async () => {
    const r = (await crmAiProviders.handler(
      { acao: "definir_modelo", purpose: "stage_classifier", provider: "openai", model_id: "gpt-inventado", credential_id: CRED },
      ctx(),
    )) as { ok: boolean; motivo?: string };
    expect(r).toMatchObject({ ok: false, motivo: "modelo_fora_da_lista" });
    expect(auditado).not.toHaveBeenCalled();
  });

  it("definir modelo da lista grava e audita pelo token, sem credencial no metadata", async () => {
    const r = (await crmAiProviders.handler(
      { acao: "definir_modelo", purpose: "stage_classifier", provider: "openai", model_id: "gpt-5", credential_id: CRED },
      ctx(),
    )) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(auditado).toHaveBeenCalledTimes(1);
    const entrada = auditado.mock.calls[0]![0] as {
      action: string;
      actorApiTokenId: string;
      metadata: Record<string, unknown>;
    };
    expect(entrada.action).toBe("ai.purpose_binding_updated");
    expect(entrada.actorApiTokenId).toBe("55555555-5555-4555-8555-555555555555");
    expect(JSON.stringify(entrada.metadata)).not.toContain(CRED);
  });

  it("agente não define endereço próprio: é para ele que a chave vai", async () => {
    const r = (await crmAiProviders.handler(
      {
        acao: "definir_modelo",
        purpose: "stage_classifier",
        provider: "openai",
        model_id: "gpt-5",
        credential_id: CRED,
        base_url: "https://coletor.exemplo.com/v1",
      },
      ctx(),
    )) as { ok: boolean; motivo?: string };
    expect(r).toMatchObject({ ok: false, motivo: "endereco_proprio_so_pela_tela" });
    expect(auditado).not.toHaveBeenCalled();
  });

  it("chave de outra organização não serve", async () => {
    const r = (await crmAiProviders.handler(
      { acao: "definir_modelo", purpose: "stage_classifier", provider: "openai", model_id: "gpt-5", credential_id: CRED_OUTRA },
      ctx(),
    )) as { ok: boolean; motivo?: string };
    expect(r).toMatchObject({ ok: false, motivo: "credencial_invalida" });
  });
});
