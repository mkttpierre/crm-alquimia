/**
 * ENVIO MANUAL EM DOBRO — o caso de 06/11 e as brechas que a trava de 60 s deixou.
 *
 * Produção, 06/11: o operador respondeu um lead pela tela e a MESMA frase saiu três vezes para o WhatsApp, com três
 * `external_id` e intervalos de 10,55 s e 10,79 s. O chip estava lento e a Evolution levou ~30 s para responder. O
 * cliente HTTP da tela tem limite de 10 s e repete o POST em tempo esgotado (200 ms e 400 ms de espera), mandando a
 * MESMA `Idempotency-Key` — que a rota não lia.
 *
 * Nada sai de verdade: auth, Supabase e o canal (WAHA, por `fetch`) são dublês. O dublê do banco é UM estado
 * compartilhado, inclusive entre "processos" (`vi.resetModules` + import de novo = outra fila em memória), porque é
 * isso que o banco é na produção.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

const estado = vi.hoisted(() => ({ supabase: null as unknown }));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => estado.supabase }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/a.jpg" }, error: null }) }) },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
// O envio automático relê o modo de teste do canal; aqui ele está liberado (o caso sob teste é outro).
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({ decidirPreGoLiveDoCanalViaSupabase: async () => ({ permite: true }) }));

type Row = Record<string, unknown>;

/** Banco falso: `messages` e `idempotency_keys` com o unique (organization_id, key, endpoint) da 0001. */
function makeBanco() {
  const messages: Row[] = [];
  const chaves: Row[] = [];
  const agora = () => new Date().toISOString();
  const casa = (filtros: [string, unknown][]) => (r: Row) => filtros.every(([c, v]) => r[c] === v);

  const from = (table: string) => {
    if (table === "conversations") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: CONV,
                organization_id: ORG,
                contact_id: CONTACT,
                channel_session_id: SESSION,
                is_group: false,
                group_chat_id: null,
                bot_silenced_until: null,
                contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
                channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
              },
              error: null,
            }),
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === "contacts") {
      const cadeia: Record<string, unknown> = {
        eq: () => cadeia,
        then: (resolve: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
      return { update: () => cadeia };
    }
    if (table === "operator_funnels") {
      const q: Record<string, unknown> = { select: () => q, eq: () => q, limit: () => q, maybeSingle: async () => ({ data: null, error: null }) };
      return q;
    }
    if (table === "idempotency_keys") {
      return {
        insert: async (row: Row) => {
          if (chaves.some((c) => c.organization_id === row.organization_id && c.key === row.key && c.endpoint === row.endpoint)) {
            return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          chaves.push({ ...row });
          return { error: null };
        },
        select: () => {
          const filtros: [string, unknown][] = [];
          const q = {
            eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
            maybeSingle: async () => {
              const achada = chaves.find(casa(filtros));
              return { data: achada ? { ...achada } : null, error: null };
            },
          };
          return q;
        },
        update: (patch: Row) => {
          const filtros: [string, unknown][] = [];
          const q = {
            eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
            then: (resolve: (v: { error: null }) => unknown) => {
              chaves.filter(casa(filtros)).forEach((c) => Object.assign(c, patch));
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return q;
        },
      };
    }
    if (table !== "messages") throw new Error(`fake: tabela inesperada '${table}'`);
    return {
      select: () => {
        const filtros: [string, unknown][] = [];
        const desde: [string, string][] = [];
        const q = {
          eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
          gte: (c: string, v: string) => (desde.push([c, v]), q),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({
              data: messages.filter(casa(filtros)).filter((r) => desde.every(([c, v]) => String(r[c]) >= v)).map((r) => ({ ...r })),
              error: null,
            }).then(resolve),
        };
        return q;
      },
      insert: (row: Row) => {
        const nova: Row = { id: `msg-${messages.length + 1}`, external_id: null, ack: null, error_code: null, error_message: null, ...row, created_at: agora(), updated_at: agora() };
        messages.push(nova);
        return { select: () => ({ single: async () => ({ data: { ...nova }, error: null }) }) };
      },
      update: (patch: Row) => {
        const filtros: [string, unknown][] = [];
        const q = {
          eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
          select: () => q,
          maybeSingle: async () => {
            const alvos = messages.filter(casa(filtros));
            alvos.forEach((r) => Object.assign(r, patch, { updated_at: agora() }));
            return { data: alvos[0] ? { ...alvos[0] } : null, error: null };
          },
        };
        return q;
      },
      delete: () => {
        const q: Record<string, unknown> = {
          eq: () => q,
          neq: () => q,
          in: () => q,
          then: (resolve: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
        return q;
      },
    };
  };
  const supabase = { from, rpc: async () => ({ error: null }) } as unknown as SupabaseClient;
  return { supabase, messages, chaves };
}

/**
 * O canal: WAHA por `fetch`. Cada chamada a `/api/send*` é UM envio ao WhatsApp. `segurar(n)` faz os próximos `n`
 * envios ficarem pendurados até o teste decidir o desfecho — o chip lento de 06/11. Os seguintes respondem na hora.
 */
function canal() {
  const envios: string[] = [];
  const pendentes: Array<{ ok: (id: string) => void; estoura: () => void }> = [];
  let segurar = 0;
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      if (!String(url).includes("/api/send")) return new Response(JSON.stringify({}), { status: 200 });
      envios.push(String(url));
      const id = `3EB0ENVIO${envios.length}`;
      if (segurar <= 0) return new Response(JSON.stringify({ id: { id } }), { status: 200 });
      segurar--;
      return new Promise<Response>((resolve, reject) => {
        pendentes.push({
          ok: (x) => resolve(new Response(JSON.stringify({ id: { id: x } }), { status: 200 })),
          // O que o `fetch` lança quando o `AbortSignal.timeout` vence: a mensagem pode ter saído do mesmo jeito.
          estoura: () => reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })),
        });
      });
    }),
  );
  return {
    envios,
    pendentes,
    segurar: (n: number) => {
      segurar = n;
    },
  };
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ate(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await pausa(2);
  if (!cond()) throw new Error("condição não chegou");
}

function pedido(corpo: Row, chave?: string) {
  return new NextRequest("http://localhost/api/v1/messages", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json", ...(chave ? { "idempotency-key": chave } : {}) },
  });
}

async function rotaNova() {
  vi.resetModules();
  return (await import("@/app/api/v1/messages/route")).POST;
}

async function handlerNovo() {
  vi.resetModules();
  return (await import("@/app/api/v1/messages/_handler")).sendMessageHandler;
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };
const texto = (over: Partial<SendMessageInput> = {}) => ({ conversation_id: CONV, type: "text", body: "Oi, Maria! Já te mando o valor.", ...over }) as SendMessageInput;

let banco: ReturnType<typeof makeBanco>;
beforeEach(() => {
  banco = makeBanco();
  estado.supabase = banco.supabase;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Idempotency-Key no POST /api/v1/messages", () => {
  it("caso de 06/11: três POSTs do mesmo clique, mesma chave, enquanto o primeiro espera o canal — UM envio", async () => {
    const c = canal();
    c.segurar(1);
    const POST = await rotaNova();
    const chave = crypto.randomUUID();
    const corpo = { conversation_id: CONV, type: "text", body: "Oi, Maria! Já te mando o valor." };

    const primeiro = POST(pedido(corpo, chave));
    await ate(() => c.envios.length === 1);
    // As duas novas tentativas do cliente chegam enquanto o canal ainda não respondeu.
    const segundo = POST(pedido(corpo, chave));
    await pausa(10);
    const terceiro = POST(pedido(corpo, chave));
    await pausa(10);
    // A Evolution estoura o tempo — mas a mensagem saiu.
    c.pendentes[0]!.estoura();

    const respostas = await Promise.all([primeiro, segundo, terceiro]);
    await pausa(10);
    expect(c.envios, "a mesma frase saiu mais de uma vez para o WhatsApp").toHaveLength(1);
    expect(respostas[0]!.status).toBe(201);
    for (const r of respostas.slice(1)) {
      expect(r.status).not.toBe(201);
      expect((await r.json()).error.code).toBe("envio_em_andamento");
    }
  });

  it("vale entre processos: dois POSTs simultâneos com a mesma chave, cada um num processo, saem UMA vez", async () => {
    const c = canal();
    const POST_A = await rotaNova();
    const POST_B = await rotaNova();
    expect(POST_A).not.toBe(POST_B);
    const chave = crypto.randomUUID();
    const corpo = { conversation_id: CONV, type: "text", body: "Oi, Maria!" };

    const [a, b] = await Promise.all([POST_A(pedido(corpo, chave)), POST_B(pedido(corpo, chave))]);

    expect(c.envios).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it("a primeira já terminou: a mesma chave devolve o mesmo resultado e não envia de novo", async () => {
    const c = canal();
    const POST = await rotaNova();
    const chave = crypto.randomUUID();
    const corpo = { conversation_id: CONV, type: "text", body: "Oi, Maria!" };

    const r1 = await POST(pedido(corpo, chave));
    const r2 = await POST(pedido(corpo, chave));

    expect(c.envios).toHaveLength(1);
    expect(r2.status).toBe(r1.status);
    expect((await r2.json()).data.id).toBe((await r1.json()).data.id);
  });

  it("a mesma chave com outro conteúdo é recusada sem enviar", async () => {
    const c = canal();
    const POST = await rotaNova();
    const chave = crypto.randomUUID();
    await POST(pedido({ conversation_id: CONV, type: "text", body: "Oi" }, chave));
    const r = await POST(pedido({ conversation_id: CONV, type: "text", body: "Outra coisa" }, chave));

    expect(c.envios).toHaveLength(1);
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("idempotency_conflict");
  });

  it("chave nova (clique novo) não é barrada pela chave: segue para a trava de duplicata", async () => {
    const c = canal();
    const POST = await rotaNova();
    const corpo = { conversation_id: CONV, type: "text", body: "Oi" };
    await POST(pedido(corpo, crypto.randomUUID()));
    const r = await POST(pedido({ ...corpo, allow_duplicate: true }, crypto.randomUUID()));

    expect(r.status).toBe(201);
    expect(c.envios).toHaveLength(2);
  });

  it("texto que começa com / continua recusado, com ou sem chave", async () => {
    const c = canal();
    const POST = await rotaNova();
    const r = await POST(pedido({ conversation_id: CONV, type: "text", body: "/qualquer" }, crypto.randomUUID()));
    expect(r.status).toBe(422);
    expect(c.envios).toHaveLength(0);
  });
});

describe("resultado incerto: o canal estourou o tempo e a mensagem pode ter saído", () => {
  it("a linha guarda que o resultado é incerto, e o reenvio idêntico é recusado com código próprio", async () => {
    const c = canal();
    c.segurar(1);
    const enviar = await handlerNovo();
    const primeiro = enviar(banco.supabase, ctx, texto());
    await ate(() => c.envios.length === 1);
    c.pendentes[0]!.estoura();
    const linha = await primeiro;
    expect(linha.status).toBe("failed");
    expect((linha.metadata as Row | null)?.resultado_incerto).toBe(true);

    await expect(enviar(banco.supabase, ctx, texto())).rejects.toMatchObject({ status: 409, code: "mensagem_talvez_enviada" });
    expect(c.envios).toHaveLength(1);
  });

  it("confirmado pelo operador (allow_duplicate), envia de novo", async () => {
    const c = canal();
    c.segurar(1);
    const enviar = await handlerNovo();
    const primeiro = enviar(banco.supabase, ctx, texto());
    await ate(() => c.envios.length === 1);
    c.pendentes[0]!.estoura();
    await primeiro;

    const segunda = await enviar(banco.supabase, ctx, texto({ allow_duplicate: true }));
    expect(segunda.status).toBe("sent");
    expect(c.envios).toHaveLength(2);
  });

  it("falha CERTA (o canal recusou) continua liberando o reenvio idêntico", async () => {
    const c = canal();
    const enviar = await handlerNovo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/send")) c.envios.push(String(url));
        return String(url).includes("/api/send") ? new Response("sessão fechada", { status: 422 }) : new Response("{}", { status: 200 });
      }),
    );
    const primeira = await enviar(banco.supabase, ctx, texto());
    expect(primeira.status).toBe("failed");
    expect((primeira.metadata as Row | null)?.resultado_incerto).toBeUndefined();
    await expect(enviar(banco.supabase, ctx, texto())).resolves.toBeDefined();
  });

  it("o envio automático não ganha a trava (só o manual)", async () => {
    const c = canal();
    c.segurar(1);
    const enviar = await handlerNovo();
    const ia: HandlerCtx = { ...ctx, actor: { type: "ai_agent", id: USER, role: "agent" } };
    const primeiro = enviar(banco.supabase, ia, texto());
    await ate(() => c.envios.length === 1);
    c.pendentes[0]!.estoura();
    const linha = await primeiro;
    expect((linha.metadata as Row | null)?.resultado_incerto).toBeUndefined();
  });
});

describe("a janela de duplicata cobre a duração real do envio", () => {
  it("mídia que leva 90 s: a repetição que chegou aos 10 s e esperou na fila é recusada", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T14:00:00Z"));
    const c = canal();
    c.segurar(1);
    const enviar = await handlerNovo();
    const imagem = texto({ type: "image", body: "o catálogo", media_storage_path: `${ORG}/${CONV}/catalogo.jpg`, media_mime: "image/jpeg" });

    const primeiro = enviar(banco.supabase, ctx, imagem);
    await ate(() => c.envios.length === 1);
    vi.setSystemTime(new Date("2026-11-06T14:00:10Z"));
    const segundo = enviar(banco.supabase, ctx, imagem);
    await pausa(10);
    vi.setSystemTime(new Date("2026-11-06T14:01:30Z"));
    c.pendentes[0]!.ok("3EB0CATALOGO");

    await expect(primeiro).resolves.toMatchObject({ status: "sent" });
    await expect(segundo).rejects.toMatchObject({ status: 409, code: "mensagem_duplicada" });
    expect(c.envios).toHaveLength(1);
  });

  it("mídia que leva 90 s: a repetição que chegou aos 70 s, com a primeira ainda em voo, é recusada", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T14:00:00Z"));
    const c = canal();
    c.segurar(1);
    const enviar = await handlerNovo();
    const imagem = texto({ type: "image", body: "o catálogo", media_storage_path: `${ORG}/${CONV}/catalogo.jpg`, media_mime: "image/jpeg" });

    const primeiro = enviar(banco.supabase, ctx, imagem);
    await ate(() => c.envios.length === 1);
    vi.setSystemTime(new Date("2026-11-06T14:01:10Z"));
    const segundo = enviar(banco.supabase, ctx, imagem);
    await pausa(10);
    vi.setSystemTime(new Date("2026-11-06T14:01:30Z"));
    c.pendentes[0]!.ok("3EB0CATALOGO");

    await primeiro;
    await expect(segundo).rejects.toMatchObject({ status: 409, code: "mensagem_duplicada" });
    expect(c.envios).toHaveLength(1);
  });

  it("a mesma frase mandada de novo 3 min depois de um envio normal passa (repetição deliberada)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T14:00:00Z"));
    const c = canal();
    const enviar = await handlerNovo();
    await enviar(banco.supabase, ctx, texto({ body: "ok" }));
    vi.setSystemTime(new Date("2026-11-06T14:03:01Z"));
    await expect(enviar(banco.supabase, ctx, texto({ body: "ok" }))).resolves.toMatchObject({ status: "sent" });
    expect(c.envios).toHaveLength(2);
  });
});
