import { afterEach, describe, expect, it, vi } from "vitest";

import {
  patchDeValidacao,
  validateAnthropicKey,
  validateGoogleKey,
  validateOllama,
  validateOpenRouterKey,
  validateProviderCredential,
  validateProviderKey,
} from "@/lib/ai/provider-validators";

/**
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * O validador da OpenRouter chamava `/api/v1/models`, que é PÚBLICO: ele
 * responde 200 sem header nenhum. Qualquer string era gravada como credencial
 * validada, e a falha só aparecia no primeiro turno do agente — como
 * `runtime_error: User not found.`, mensagem que não fala de credencial.
 *
 * O caso decisivo é o último: ele prende o ENDEREÇO da primeira chamada. Sem
 * ele, alguém "simplifica" o validador de volta para uma requisição só, o
 * catálogo responde 200 para chave falsa, e os dois primeiros casos aqui
 * continuariam verdes — a família do teste que concorda com o próprio defeito.
 */

const chamadas: string[] = [];

function fetchFalso(respostas: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (url: string) => {
    chamadas.push(url);
    const chave = Object.keys(respostas).find((k) => url.includes(k));
    const r = chave ? respostas[chave]! : { status: 404 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    } as unknown as Response;
  });
}

afterEach(() => {
  chamadas.length = 0;
  vi.unstubAllGlobals();
});

describe("validateOpenRouterKey", () => {
  it("recusa a chave que a OpenRouter não reconhece", async () => {
    // Era ESTE o caso que passava: /api/v1/models devolve 200 para qualquer um.
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/api/v1/key": { status: 401 }, "/api/v1/models": { status: 200 } }),
    );
    const r = await validateOpenRouterKey("sk-or-v1-nao-existe");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("auth_failed_401");
  });

  it("aceita a chave boa e devolve o catálogo", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({
        "/api/v1/key": { status: 200, body: { data: { label: "x" } } },
        "/api/v1/models": { status: 200, body: { data: [{ id: "minimax/minimax-m3:free" }] } },
      }),
    );
    const r = await validateOpenRouterKey("sk-or-v1-boa");
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.models).toEqual(["minimax/minimax-m3:free"]);
  });

  it("catálogo fora do ar não recusa chave que já provou ser válida", async () => {
    // Trocar erro de credencial por erro de disponibilidade faria o operador
    // caçar defeito na chave certa.
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/api/v1/key": { status: 200 }, "/api/v1/models": { status: 503 } }),
    );
    const r = await validateOpenRouterKey("sk-or-v1-boa");
    expect(r.ok).toBe(true);
    // Lista que não veio NÃO é lista vazia: o validador não devolve `models`,
    // e o patch mantém a lista anterior com o erro marcado.
    expect(r.ok === true && r.models).toBeUndefined();
    expect(r.ok === true && r.aviso).toBe("catalogo_indisponivel_503");
  });

  it("a PROVA é o endpoint autenticado, e é o primeiro a ser chamado", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/api/v1/key": { status: 200 }, "/api/v1/models": { status: 200 } }),
    );
    await validateOpenRouterKey("sk-or-v1-boa");
    expect(chamadas[0]).toContain("/api/v1/key");
  });
});

describe("validateGoogleKey", () => {
  // A doutrina do repo proíbe chave em query string (vaza em log de proxy, de
  // CDN e de quem depura). O Google aceita a chave no cabeçalho
  // `x-goog-api-key`, então não há motivo para a URL carregar segredo.
  it("manda a chave no cabeçalho x-goog-api-key, nunca na URL", async () => {
    const vistos: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        vistos.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: "models/gemini-x" }] }),
        } as unknown as Response;
      }),
    );
    const r = await validateGoogleKey("AIza-segredo-de-teste");
    expect(r.ok === true && r.models).toEqual(["gemini-x"]);
    expect(vistos).toHaveLength(1);
    expect(vistos[0]!.url).not.toContain("AIza-segredo-de-teste");
    expect(vistos[0]!.url).not.toContain("key=");
    expect(vistos[0]!.headers["x-goog-api-key"]).toBe("AIza-segredo-de-teste");
  });

  it("recusa chave que o Google não reconhece", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response),
    );
    const r = await validateGoogleKey("AIza-falsa");
    expect(r.ok === false && r.error).toBe("auth_failed_401");
  });
});

describe("OpenRouter: quem sabe usar ferramentas vem da própria listagem", () => {
  it("separa os modelos com ferramentas pelo supported_parameters", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({
        "/api/v1/key": { status: 200 },
        "/api/v1/models": {
          status: 200,
          body: {
            data: [
              { id: "a/com-tools", supported_parameters: ["tools", "temperature"] },
              { id: "b/sem-tools", supported_parameters: ["temperature"] },
              { id: "c/sem-info" },
            ],
          },
        },
      }),
    );
    const r = await validateOpenRouterKey("sk-or-v1-boa");
    expect(r.ok === true && r.models).toEqual(["a/com-tools", "b/sem-tools", "c/sem-info"]);
    expect(r.ok === true && r.modelsTools).toEqual(["a/com-tools"]);
  });
});

describe("patchDeValidacao", () => {
  const agora = new Date("2026-11-16T03:00:00.000Z");

  it("sucesso regrava a lista, a data e a lista de ferramentas", () => {
    expect(
      patchDeValidacao({ ok: true, models: ["x"], modelsTools: ["x"] }, agora),
    ).toEqual({
      validated_at: "2026-11-16T03:00:00.000Z",
      validation_error: null,
      models_available: ["x"],
      models_tools: ["x"],
    });
  });

  it("provedor que não informa ferramentas grava NULL (desconhecido), não lista vazia", () => {
    const patch = patchDeValidacao({ ok: true, models: ["x"] }, agora);
    expect("models_tools" in patch ? patch.models_tools : "ausente").toBeNull();
  });

  it("falha apaga a validação e guarda o motivo, sem tocar na lista", () => {
    expect(patchDeValidacao({ ok: false, error: "auth_failed_401" }, agora)).toEqual({
      validated_at: null,
      validation_error: "auth_failed_401",
    });
  });
});

describe("Anthropic: a listagem pagina", () => {
  it("pede limit=1000 e segue has_more/last_id até acabar", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const segunda = url.includes("after_id=m-2");
        return {
          ok: true,
          status: 200,
          json: async () =>
            segunda
              ? { data: [{ id: "m-3" }], has_more: false, last_id: "m-3" }
              : { data: [{ id: "m-1" }, { id: "m-2" }], has_more: true, last_id: "m-2" },
        } as unknown as Response;
      }),
    );
    const r = await validateAnthropicKey("sk-ant-teste");
    expect(r.ok === true && r.models).toEqual(["m-1", "m-2", "m-3"]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("limit=1000");
    expect(urls[1]).toContain("after_id=m-2");
    expect(urls.join(" ")).not.toContain("sk-ant-teste");
  });

  it("para no teto de páginas mesmo se o provedor disser que há mais", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: `m-${n}` }], has_more: true, last_id: `m-${n}` }),
        } as unknown as Response;
      }),
    );
    const r = await validateAnthropicKey("sk-ant-teste");
    expect(r.ok).toBe(true);
    expect(n).toBeLessThanOrEqual(20);
  });
});

describe("patchDeValidacao com catálogo indisponível", () => {
  it("valida a chave, marca o erro e NÃO toca na lista anterior", () => {
    const p = patchDeValidacao(
      { ok: true, aviso: "catalogo_indisponivel_503" },
      new Date("2026-11-16T03:00:00.000Z"),
    );
    expect(p).toEqual({
      validated_at: "2026-11-16T03:00:00.000Z",
      validation_error: "catalogo_indisponivel_503",
    });
    expect("models_available" in p).toBe(false);
  });
});

/**
 * OLLAMA (modelo local, sem chave): o "validador" pergunta ao servidor quais
 * modelos ele tem, em `GET {base_url}/api/tags`. Tudo mockado — nenhum Ollama de
 * verdade é chamado.
 */
describe("validateOllama", () => {
  const resolverInterno = async () => ["192.168.1.20"];

  function servidor(resposta: { status: number; body?: unknown; location?: string } | Error) {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      chamadas.push(String(url));
      if (resposta instanceof Error) throw resposta;
      return {
        ok: resposta.status >= 200 && resposta.status < 300,
        status: resposta.status,
        headers: new Headers(resposta.location ? { location: resposta.location } : {}),
        json: async () => resposta.body ?? {},
        // O init chega até aqui só para o teste conferir que nenhum cabeçalho de chave foi enviado.
        _init: init,
      } as unknown as Response;
    });
  }

  it("lista os modelos de /api/tags e usa o endereço pedido", async () => {
    const f = servidor({
      status: 200,
      body: { models: [{ name: "llama3.2:3b" }, { model: "qwen2.5:7b" }, { name: "" }] },
    });
    const r = await validateOllama("http://localhost:11434", { fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, models: ["llama3.2:3b", "qwen2.5:7b"] });
    expect(chamadas).toEqual(["http://localhost:11434/api/tags"]);
    // Sem chave: nenhum cabeçalho de autorização sai.
    const init = f.mock.calls[0]![1]!;
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|api-key/i);
  });

  it("sem endereço, usa o padrão http://localhost:11434", async () => {
    const f = servidor({ status: 200, body: { models: [] } });
    const r = await validateOllama(null, { fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, models: [] });
    expect(chamadas).toEqual(["http://localhost:11434/api/tags"]);
  });

  it("aceita nome interno que resolve para rede privada", async () => {
    const f = servidor({ status: 200, body: { models: [{ name: "m:1" }] } });
    const r = await validateOllama("http://ollama.lan:11434", {
      resolver: resolverInterno,
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
  });

  it("NÃO chama a rede quando o endereço é proibido (metadata de nuvem)", async () => {
    const f = servidor({ status: 200, body: { models: [] } });
    const r = await validateOllama("http://169.254.169.254", { fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, error: "endereco_inseguro" });
    expect(f).not.toHaveBeenCalled();
  });

  it("nome que passa a resolver para link-local não é consultado", async () => {
    const f = servidor({ status: 200, body: { models: [] } });
    const r = await validateOllama("http://velho.exemplo:11434", {
      resolver: async () => ["169.254.169.254"],
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, error: "endereco_inseguro" });
    expect(f).not.toHaveBeenCalled();
  });

  it("redirecionamento não é seguido: vira erro", async () => {
    const f = servidor({ status: 302, location: "http://169.254.169.254/x" });
    const r = await validateOllama("http://localhost:11434", { fetchImpl: f as unknown as typeof fetch });
    expect(r.ok).toBe(false);
  });

  it("servidor fora do ar vira ollama_inacessivel", async () => {
    const f = servidor(new TypeError("fetch failed"));
    expect(await validateOllama("http://localhost:11434", { fetchImpl: f as unknown as typeof fetch })).toEqual({
      ok: false,
      error: "ollama_inacessivel",
    });
  });

  it("status de erro e resposta fora do formato são falhas distintas", async () => {
    expect(
      await validateOllama("http://localhost:11434", { fetchImpl: servidor({ status: 500 }) as unknown as typeof fetch }),
    ).toEqual({ ok: false, error: "provider_status_500" });
    expect(
      await validateOllama("http://localhost:11434", {
        fetchImpl: servidor({ status: 200, body: { qualquer: 1 } }) as unknown as typeof fetch,
      }),
    ).toEqual({ ok: false, error: "resposta_invalida" });
  });

  it("não informa ferramentas (/api/tags não diz): a grava NULL e mantém a lista", () => {
    const patch = patchDeValidacao({ ok: true, models: ["llama3.2:3b"] }, new Date("2026-11-16T12:00:00Z"));
    expect(patch).toMatchObject({ models_available: ["llama3.2:3b"], models_tools: null, validation_error: null });
  });
});

describe("validateProviderCredential", () => {
  it("ollama vai pelo endereço; os outros pela chave", async () => {
    const f = vi.fn(async (url: string) => {
      chamadas.push(url);
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ models: [{ name: "a:1" }] }) } as unknown as Response;
    });
    const r = await validateProviderCredential("ollama", { baseUrl: "http://localhost:11434" }, { fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, models: ["a:1"] });

    // A chave do Ollama é ignorada, e o validador por chave recusa ollama.
    expect(await validateProviderKey("ollama", "qualquer-coisa")).toEqual({ ok: false, error: "ollama_sem_endereco" });

    vi.stubGlobal("fetch", fetchFalso({ "api.openai.com": { status: 200, body: { data: [{ id: "gpt-5" }] } } }));
    expect(await validateProviderCredential("openai", { apiKey: "sk-teste" })).toEqual({ ok: true, models: ["gpt-5"] });
  });
});
