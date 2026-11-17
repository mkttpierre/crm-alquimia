import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/health — a checagem do WAHA pode ser desligada por configuração.
 *
 * Contexto: uma instalação cujo motor de envio usa outro transporte (ex.: Evolution)
 * mantém `WAHA_API_BASE_URL`/`WAHA_API_KEY` preenchidos só porque `lib/env.ts` os
 * exige em produção. Sem um botão de desligar, o health respondia 503 ("unhealthy")
 * para sempre, com o app funcionando. `WAHA_HEALTH_CHECK=off` resolve sem afrouxar
 * a regra para quem usa o serviço: vazio continua sendo "checa e reprova se cair".
 */

const BASE_WAHA = "http://waha.invalido.test:3999";

type EnvDoTeste = Record<string, string | undefined>;

function envBase(extra: EnvDoTeste = {}): EnvDoTeste {
  return {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.exemplo.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-de-teste",
    UPSTASH_REDIS_REST_URL: "http://redis.exemplo.test:8079",
    UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
    WAHA_API_BASE_URL: BASE_WAHA,
    WAHA_API_KEY: "chave-de-teste",
    INTERNAL_CRON_SECRET: "",
    INTERNAL_SECRET: "",
    ...extra,
  };
}

/** Supabase e Redis respondem; o WAHA recusa a conexão (como no PC do operador). */
function fetchComWahaForaDoAr() {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith(BASE_WAHA)) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }
    return new Response("[]", { status: 200 });
  });
}

async function chamarHealth(env: EnvDoTeste) {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({ env }));
  const { GET } = await import("@/app/api/v1/health/route");
  const res = await GET(new NextRequest("https://crm.exemplo.test/api/v1/health"));
  return { http: res.status, corpo: (await res.json()).data };
}

describe("GET /api/v1/health — checagem do WAHA desligável", () => {
  let fetchMock: ReturnType<typeof fetchComWahaForaDoAr>;

  beforeEach(() => {
    fetchMock = fetchComWahaForaDoAr();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/env");
  });

  it("controle: ligada (padrão), WAHA fora do ar derruba o health com 503", async () => {
    const { http, corpo } = await chamarHealth(envBase());
    expect(corpo.checks.waha.status).toBe("down");
    expect(corpo.status).toBe("unhealthy");
    expect(http).toBe(503);
  });

  it("WAHA_HEALTH_CHECK=off: health 200 e saudável, sem nem tentar chamar o WAHA", async () => {
    const { http, corpo } = await chamarHealth(envBase({ WAHA_HEALTH_CHECK: "off" }));
    expect(corpo.checks.waha.status).toBe("disabled");
    expect(corpo.checks.waha.reason).toBe("desligado_por_configuracao");
    expect(corpo.status).toBe("healthy");
    expect(http).toBe(200);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(BASE_WAHA))).toBe(false);
  });

  it("aceita variações de maiúscula/espaço (' OFF ')", async () => {
    const { http, corpo } = await chamarHealth(envBase({ WAHA_HEALTH_CHECK: " OFF " }));
    expect(corpo.checks.waha.status).toBe("disabled");
    expect(http).toBe(200);
  });

  it("valor desconhecido NÃO desliga (falha fechada: continua checando)", async () => {
    const { http, corpo } = await chamarHealth(envBase({ WAHA_HEALTH_CHECK: "talvez" }));
    expect(corpo.checks.waha.status).toBe("down");
    expect(http).toBe(503);
  });

  it("desligar o WAHA não esconde falha de outro serviço (Redis fora do ar continua 503)", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).startsWith("http://redis.exemplo.test")) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      }
      return new Response("[]", { status: 200 });
    });
    const { http, corpo } = await chamarHealth(envBase({ WAHA_HEALTH_CHECK: "off" }));
    expect(corpo.checks.redis.status).toBe("down");
    expect(corpo.checks.waha.status).toBe("disabled");
    expect(http).toBe(503);
  });
});
