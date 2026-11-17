/**
 * Pings síncronos para validar API keys BYO de provedores LLM.
 *
 * Uso:
 *   const result = await validateProviderKey("anthropic", apiKey);
 *   if (result.ok) → grava `validated_at = now()`, `models_available = result.models`
 *   else → grava `validation_error = result.error`
 *
 * Timeout 5s, sem retry. Erros 401 são distintos de erros de rede.
 */
import { allowlistedFetch, EgressBlockedError, buildAllowlist } from "@/lib/agent-engine/edge/egress";
import type { PROVEDORES } from "@/lib/ai/pontos/provedores";
import {
  conferirEnderecoOllama,
  ENDERECO_PADRAO_DO_OLLAMA,
  type ResolvedorDeEnderecos,
} from "@/lib/ai/provedores/endereco-ollama";

/**
 * Os provedores cuja CHAVE este arquivo sabe validar.
 *
 * Derivado de `lib/ai/pontos/provedores.ts`, que é a lista única desde a
 * migration 0127 — quando ela era repetida à mão aqui, na rota de credenciais,
 * no diálogo da tela e em `lib/ai/agents/validation.ts`, a 0127 abriu o banco
 * para a OpenRouter e as quatro cópias continuaram recusando. O resultado era
 * uma tela que oferecia OpenRouter num ponto e não tinha onde cadastrar a
 * chave dela.
 */
export type Provider = (typeof PROVEDORES)[number]["id"];

export interface ValidationOk {
  ok: true;
  /**
   * A lista que o provedor devolveu. AUSENTE quando a chave provou ser válida
   * mas a listagem falhou (`aviso`): lista que não veio não é lista vazia, e
   * gravar `[]` apagaria do operador os modelos que a chave liberava ontem.
   */
  models?: string[];
  /** A chave é válida, mas algo secundário falhou (ex.: catálogo fora do ar). */
  aviso?: string;
  /**
   * Os ids que o provedor DECLAROU suportar ferramentas. Ausente quando a
   * listagem do provedor não informa isso (Anthropic, OpenAI, Google): aí a
   * capacidade segue vindo do catálogo `ai_models`. Lista vazia quer dizer
   * "o provedor informou, e nenhum suporta" — é diferente de ausente.
   */
  modelsTools?: string[];
}

export interface ValidationFail {
  ok: false;
  error: string;
}

export type ValidationResult = ValidationOk | ValidationFail;

const TIMEOUT_MS = 5000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Teto de páginas da listagem da Anthropic: 20 × 1000 modelos sobra muito. */
const MAX_PAGINAS_ANTHROPIC = 20;

/**
 * A listagem da Anthropic PAGINA (padrão de 20 por página). Ler só a primeira
 * página escondia modelo que a chave libera — e, com a lista viva, o modelo
 * escondido passava a ser recusado na escrita. Pede `limit=1000` e segue
 * `has_more`/`last_id` até acabar, com teto de páginas para um provedor que
 * respondesse `has_more: true` para sempre não prender a validação.
 */
export async function validateAnthropicKey(apiKey: string): Promise<ValidationResult> {
  try {
    const models: string[] = [];
    let depois: string | null = null;
    for (let pagina = 0; pagina < MAX_PAGINAS_ANTHROPIC; pagina++) {
      const url =
        "https://api.anthropic.com/v1/models?limit=1000" +
        (depois ? `&after_id=${encodeURIComponent(depois)}` : "");
      const res = await timedFetch(url, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "auth_failed_401" };
      }
      if (!res.ok) {
        // Primeira página falhando é falha da validação; página seguinte
        // falhando não desfaz a prova da chave — mas a lista ficou incompleta,
        // e lista incompleta não pode substituir a anterior.
        if (pagina === 0) return { ok: false, error: `provider_status_${res.status}` };
        return { ok: true, aviso: `catalogo_incompleto_${res.status}` };
      }
      const json = (await res.json()) as {
        data?: { id: string }[];
        has_more?: boolean;
        last_id?: string | null;
      };
      models.push(...(json.data ?? []).map((m) => m.id).filter(Boolean));
      if (json.has_more !== true || !json.last_id) return { ok: true, models };
      depois = json.last_id;
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

export async function validateOpenAIKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

export async function validateGoogleKey(apiKey: string): Promise<ValidationResult> {
  // Google Generative Language API — listModels. A chave vai no cabeçalho
  // `x-goog-api-key`, que a API aceita, e NUNCA na query string: URL com
  // segredo acaba em log de proxy, de CDN e de quem depura (anti-pattern 12 do
  // CLAUDE.md). Até 2026-11-16 ela ia em `?key=`.
  try {
    const res = await timedFetch("https://generativelanguage.googleapis.com/v1beta/models", {
      method: "GET",
      headers: { "x-goog-api-key": apiKey },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { models?: { name?: string }[] };
    const models = (json.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

/**
 * OpenRouter expõe `/api/v1/key` (metadados da própria chave) e `/api/v1/models`
 * (catálogo).
 *
 * ⚠️ `/api/v1/models` É PÚBLICO. Validar por ele não valida nada — e era o que
 * este arquivo fazia. Medido em 2026-09-02, com a chave mais falsa possível:
 *
 *     GET /api/v1/models   sem header nenhum         → 200
 *     GET /api/v1/models   Bearer sk-or-v1-...falsa  → 200
 *     GET /api/v1/key      Bearer sk-or-v1-...falsa  → 401
 *
 * O comentário anterior dizia que o catálogo responde "esta chave é aceita?"
 * do mesmo jeito que os três irmãos acima. Não responde: os outros três batem
 * em endpoints que EXIGEM credencial, este não.
 *
 * O efeito medido é o pior para quem opera: QUALQUER string era gravada com
 * `validated_at` preenchido, a tela dizia "validada" com o final da chave ao
 * lado, e a falha só aparecia no primeiro turno do agente — como
 * `runtime_error: User not found.`, mensagem que não menciona credencial
 * nenhuma. Quem depurasse isso procuraria o defeito no modelo, no provedor ou
 * no runtime; o operador tinha uma tela dizendo que a parte quebrada estava boa.
 *
 * A prova passa a ser `/api/v1/key`, que exige a credencial. O catálogo segue
 * sendo lido DEPOIS, porque a lista de modelos é o que a interface usa — e ali
 * ele é só dado, não prova. Catálogo fora do ar não recusa uma chave que já
 * provou ser válida: seria trocar um erro de credencial por um de
 * disponibilidade.
 */
export async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
  try {
    const auth = await timedFetch("https://openrouter.ai/api/v1/key", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (auth.status === 401 || auth.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!auth.ok) {
      return { ok: false, error: `provider_status_${auth.status}` };
    }

    const res = await timedFetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // A chave já provou ser válida; o catálogo fora do ar não a recusa, mas
    // também não vira lista vazia: o patch mantém a lista anterior e grava o
    // aviso em `validation_error`.
    if (!res.ok) return { ok: true, aviso: `catalogo_indisponivel_${res.status}` };

    // `supported_parameters` é o que a OpenRouter declara por modelo — a mesma
    // fonte que o sincronizador do catálogo usa (`lib/ai/catalogo/openrouter.ts`),
    // nunca heurística sobre o nome.
    const json = (await res.json()) as {
      data?: { id?: string; supported_parameters?: string[] | null }[];
    };
    const linhas = (json.data ?? []).filter((m) => (m.id ?? "") !== "");
    const models = linhas.map((m) => m.id!);
    const modelsTools = linhas
      .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
      .map((m) => m.id!);
    return { ok: true, models, modelsTools };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

/**
 * O Ollama (modelo local) não tem chave: "validar" é perguntar ao servidor, em
 * `GET {base_url}/api/tags`, quais modelos ele tem baixados. A resposta é a
 * lista viva (`models_available`); se o servidor não responde, a credencial não
 * fica conectada.
 *
 * A rede é a de todo o runtime: o `fetch` sai por `allowlistedFetch`, com a
 * allowlist do próprio host, o que também impede seguir um redirecionamento para
 * fora dele. E o endereço é conferido DE NOVO aqui (`conferirEnderecoOllama`),
 * porque este validador roda no revalidar e em segundo plano — um endereço
 * gravado antes de uma mudança de política, ou um nome que passou a resolver
 * para endereço proibido, não pode ser consultado. Quem chega aqui já passou
 * pela tela de admin (a credencial só existe se um admin a gravou), por isso o
 * papel é tratado como admin; a conferência por papel de quem GRAVA está em
 * `lib/ai/credenciais/guardar.ts`.
 *
 * `/api/tags` não informa quem sabe usar ferramentas, então `modelsTools` fica
 * ausente (a coluna vira NULL e a capacidade é "não verificada").
 */
export async function validateOllama(
  baseUrl: string | null | undefined,
  deps: { resolver?: ResolvedorDeEnderecos; fetchImpl?: typeof fetch } = {},
): Promise<ValidationResult> {
  const endereco = await conferirEnderecoOllama(baseUrl?.trim() || ENDERECO_PADRAO_DO_OLLAMA, {
    porAdmin: true,
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
  });
  if (!endereco.ok) return { ok: false, error: endereco.codigo };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${endereco.url}/api/tags`;
    const res = await allowlistedFetch(
      url,
      { method: "GET", headers: { Accept: "application/json" }, signal: ctrl.signal },
      {
        allowlist: buildAllowlist([endereco.url]),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      },
    );
    if (res.status >= 300 && res.status < 400) return { ok: false, error: `provider_status_${res.status}` };
    if (!res.ok) return { ok: false, error: `provider_status_${res.status}` };
    let json: { models?: { name?: string; model?: string }[] };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return { ok: false, error: "resposta_invalida" };
    }
    if (json === null || typeof json !== "object" || !Array.isArray(json.models)) {
      return { ok: false, error: "resposta_invalida" };
    }
    const models = json.models.map((m) => (m.name ?? m.model ?? "").trim()).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    if (err instanceof EgressBlockedError) return { ok: false, error: "endereco_inseguro" };
    return { ok: false, error: "ollama_inacessivel" };
  } finally {
    clearTimeout(t);
  }
}

/**
 * O que gravar na credencial depois de validar — a MESMA forma no cadastro
 * (`lib/ai/credenciais/guardar.ts`) e no revalidar (botão "Atualizar modelos").
 * Duas cópias desta decisão já divergiriam no primeiro campo novo.
 *
 * Falha não apaga a lista anterior: ela continua sem valer (a tela só usa lista
 * de credencial validada), e apagar tiraria do operador a referência do que a
 * chave liberava antes de parar.
 */
export function patchDeValidacao(
  result: ValidationResult,
  agora: Date = new Date(),
):
  | {
      validated_at: string;
      validation_error: null;
      models_available: string[];
      models_tools: string[] | null;
    }
  | { validated_at: string; validation_error: string }
  | { validated_at: null; validation_error: string } {
  if (!result.ok) return { validated_at: null, validation_error: result.error };
  if (result.models === undefined) {
    // Chave válida, lista não veio: valida, marca o motivo e deixa a lista e a
    // capacidade de ferramentas anteriores como estão.
    return { validated_at: agora.toISOString(), validation_error: result.aviso ?? "catalogo_indisponivel" };
  }
  return {
    validated_at: agora.toISOString(),
    validation_error: null,
    models_available: result.models,
    models_tools: result.modelsTools ?? null,
  };
}

/**
 * Valida a credencial de qualquer provedor da lista: com chave (os quatro
 * primeiros) ou sem chave e com endereço (ollama). É o ponto que o cadastro e o
 * revalidar usam — dois `if (provider === "ollama")` espalhados divergiriam.
 */
export function validateProviderCredential(
  provider: Provider,
  credencial: { apiKey?: string | null; baseUrl?: string | null },
  deps: { resolver?: ResolvedorDeEnderecos; fetchImpl?: typeof fetch } = {},
): Promise<ValidationResult> {
  if (provider === "ollama") return validateOllama(credencial.baseUrl, deps);
  return validateProviderKey(provider, credencial.apiKey ?? "");
}

export function validateProviderKey(
  provider: Provider,
  apiKey: string,
): Promise<ValidationResult> {
  switch (provider) {
    case "anthropic":
      return validateAnthropicKey(apiKey);
    case "openai":
      return validateOpenAIKey(apiKey);
    case "google":
      return validateGoogleKey(apiKey);
    case "openrouter":
      return validateOpenRouterKey(apiKey);
    case "ollama":
      // Sem chave: o Ollama é validado pelo ENDEREÇO (`validateProviderCredential`).
      // Chegar aqui com ele é cobrar uma chave que ele não tem.
      return Promise.resolve({ ok: false, error: "ollama_sem_endereco" });
    default: {
      // Sem `never` aqui: `Provider` agora é derivado de PROVEDORES, e a lista
      // cresce sem que este arquivo saiba. Provedor novo cadastrado antes de
      // ganhar validador devolve um erro que DIZ isso, em vez de quebrar o
      // build de quem só acrescentou uma linha na lista.
      return Promise.resolve({ ok: false, error: `unknown_provider:${provider}` });
    }
  }
}
