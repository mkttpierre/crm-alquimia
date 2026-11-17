/**
 * Excluir uma conexão funciona mesmo com o servidor de WhatsApp fora do ar.
 *
 * Antes, o DELETE só mexia no banco DEPOIS de deslogar no servidor: WAHA sem
 * configuração devolvia 503, WAHA que recusava a conexão devolvia 502 (e ainda
 * marcava o canal FAILED), e o dono ficava preso a uma conexão velha que não
 * conseguia tirar da tela. A Evolution caía no ramo do canal oficial e nunca era
 * deslogada no servidor.
 *
 * Agora a revogação no provedor é TENTATIVA, não portão: o banco arquiva ou apaga
 * do mesmo jeito (a escolha continua com `loadDeletionImpact`), e a resposta diz
 * se o servidor revogou (`revogado`) e o que avisar ao operador (`aviso`).
 *
 * O dublê aplica os filtros `eq`/`is`/`in` de verdade, como o de `route.test.ts`:
 * o "webhook de conexão arquivada" só prova alguma coisa se o `archived_at` da
 * linha for de fato comparado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import type { AuthUser } from "@/lib/auth/types";
import { resolveEvolutionCreds } from "@/lib/channels/evolution/credentials";
import { handleInboundWebhook } from "@/lib/channels/inbound";
import type * as InboundModule from "@/lib/channels/inbound";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient } from "@/lib/waha/client";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: vi.fn(),
  wahaFriendlyError: (m: unknown) => String(m),
}));
vi.mock("@/lib/channels/evolution/credentials", () => ({ resolveEvolutionCreds: vi.fn() }));
vi.mock("@/lib/waha/ingest", () => ({ dispatchWahaEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/inbound", async (original) => ({
  ...(await original<typeof InboundModule>()),
  handleInboundWebhook: vi.fn(async () => ({ ok: true, body: { status: "processed" } })),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";
const TOKEN = "tokenwebhookdocanal0001";
const AVISO =
  "O servidor de WhatsApp não respondeu. A conexão saiu do CRM, mas pode continuar ativa no aparelho: desconecte em Aparelhos conectados.";

type Linha = Record<string, unknown>;

interface Escrita {
  tipo: "update" | "delete" | "insert";
  table: string;
  patch: Linha | null;
}

interface Registro {
  escritas: Escrita[];
  /** Ordem observável de tudo que tem efeito colateral (servidor + banco). */
  eventos: string[];
}

function canalWaha(over: Linha = {}): Linha {
  return {
    id: CANAL,
    organization_id: ORG,
    provider: "waha",
    waha_session_name: "org_2222_abc",
    evolution_instance_name: null,
    display_name: "Comercial",
    phone_number: "+5531999998888",
    status: "WORKING",
    archived_at: null,
    webhook_path_token: TOKEN,
    webhook_secret_encrypted: null,
    ...over,
  };
}

function canalEvolution(over: Linha = {}): Linha {
  return canalWaha({ provider: "evolution", waha_session_name: null, evolution_instance_name: "chip-alfa", ...over });
}

const CONVERSA = { conversations: [{ id: "c1", organization_id: ORG, channel_session_id: CANAL }] };

function makeDb(sessions: Linha[], rows: Record<string, Linha[]> = {}): Registro {
  const registro: Registro = { escritas: [], eventos: [] };
  const tabelas: Record<string, Linha[]> = { channel_sessions: sessions, ...rows };

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    private inclusoes: Array<[string, unknown[]]> = [];
    private limite: number | undefined;
    private contar = false;
    private single = false;

    constructor(
      private readonly table: string,
      private readonly op: "select" | "update" | "delete" | "insert",
      private readonly patch: Linha | null = null,
    ) {}

    select(_cols?: string, o?: { count?: string; head?: boolean }): this {
      this.contar = o?.count !== undefined;
      return this;
    }
    eq(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    is(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    in(col: string, values: unknown[]): this {
      this.inclusoes.push([col, values]);
      return this;
    }
    order(): this {
      return this;
    }
    limit(n: number): this {
      this.limite = n;
      return this;
    }
    maybeSingle(): this {
      this.single = true;
      return this;
    }

    private casam(): Linha[] {
      return (tabelas[this.table] ?? []).filter(
        (l) =>
          this.filtros.every(([c, v]) => (l[c] ?? null) === v) &&
          this.inclusoes.every(([c, values]) => values.includes(l[c])),
      );
    }

    private executar(): { data: unknown; error: unknown; count?: number } {
      if (this.op === "select") {
        let achadas = this.casam();
        if (this.limite !== undefined) achadas = achadas.slice(0, this.limite);
        if (this.contar) return { data: null, error: null, count: achadas.length };
        return { data: this.single ? (achadas[0] ?? null) : achadas, error: null };
      }
      registro.escritas.push({ tipo: this.op, table: this.table, patch: this.patch });
      registro.eventos.push(`${this.op}:${this.table}`);
      if (this.op === "insert") {
        (tabelas[this.table] ??= []).push({ ...(this.patch ?? {}) });
      } else if (this.op === "delete") {
        const alvo = this.casam();
        tabelas[this.table] = (tabelas[this.table] ?? []).filter((l) => !alvo.includes(l));
      } else {
        for (const l of this.casam()) Object.assign(l, this.patch);
      }
      return { data: null, error: null };
    }

    then<R1 = unknown, R2 = never>(
      onOk?: ((v: { data: unknown; error: unknown; count?: number }) => R1 | PromiseLike<R1>) | null,
      onErr?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.executar()).then(onOk, onErr);
    }
  }

  const client = {
    from: (table: string) => ({
      select: (cols?: string, o?: { count?: string; head?: boolean }) => new Q(table, "select").select(cols, o),
      update: (patch: Linha) => new Q(table, "update", patch),
      delete: () => new Q(table, "delete"),
      insert: (patch: Linha) => new Q(table, "insert", patch),
    }),
    rpc: async () => ({ data: null, error: null }),
  };

  vi.mocked(createClient).mockResolvedValue(client as never);
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return registro;
}

function authOk(): void {
  const user: AuthUser = {
    id: USER,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId: ORG, name: "Org", role: "admin" } });
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG, name: "Org", role: "admin" });
}

function wahaOk(registro: Registro) {
  const cliente = {
    logoutSession: vi.fn(async () => {
      registro.eventos.push("waha:logout");
    }),
    deleteSession: vi.fn(async () => {
      registro.eventos.push("waha:delete");
    }),
  };
  vi.mocked(getWahaClient).mockReturnValue(cliente as never);
  return cliente;
}

function econnrefused(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3001"), { code: "ECONNREFUSED" }),
  });
}

const CREDS_EVOLUTION = { baseUrl: "http://evolution.local", apiKey: "k", instance: "chip-alfa", source: "session" as const };

/** `fetch` da Evolution: registra a chamada na ordem dos eventos e responde ok, ou lança. */
function stubFetchEvolution(registro: Registro, falha?: () => Error) {
  const f = vi.fn(async (url: string, _init: RequestInit) => {
    registro.eventos.push(`evolution:${new URL(url).pathname}`);
    if (falha) throw falha();
    return new Response(JSON.stringify({ status: "SUCCESS" }), { status: 200 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

function reservaOcupada(): Record<string, Linha[]> {
  return {
    channel_connection_requests: [
      {
        id: "busy",
        organization_id: ORG,
        channel_session_id: CANAL,
        state: "processing",
        lease_until: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };
}

const ctx = () => ({ params: Promise.resolve({ id: CANAL }) });
const reqDelete = () => new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL}`, { method: "DELETE" });

async function excluir() {
  const { DELETE } = await import("./route");
  const res = await DELETE(reqDelete(), ctx());
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("excluir conexão WAHA sem o servidor", () => {
  it("exclui_waha_sem_configuracao: sem WAHA_API_BASE_URL → 200, apaga, revogado=false e aviso", async () => {
    authOk();
    const db = makeDb([canalWaha()]);
    vi.mocked(getWahaClient).mockReturnValue(null);

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: false, revogado: false, aviso: AVISO });
    expect(db.escritas).toEqual([{ tipo: "delete", table: "channel_sessions", patch: null }]);
  });

  it("exclui_waha_sem_configuracao: com histórico → 200, arquiva", async () => {
    authOk();
    const db = makeDb([canalWaha()], CONVERSA);
    vi.mocked(getWahaClient).mockReturnValue(null);

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: true, revogado: false, aviso: AVISO });
    expect(db.escritas.map((e) => e.tipo)).toEqual(["update"]);
    expect(db.escritas[0]?.patch).toMatchObject({ status: "STOPPED", archived_at: expect.any(String) });
  });

  it("exclui_waha_fora_do_ar: logout lança ECONNREFUSED → 200, revogado=false, status não vira FAILED", async () => {
    authOk();
    const db = makeDb([canalWaha()], CONVERSA);
    const waha = wahaOk(db);
    waha.logoutSession.mockRejectedValue(econnrefused());
    waha.deleteSession.mockRejectedValue(econnrefused());

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: true, revogado: false, aviso: AVISO });
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toMatchObject({ status: "STOPPED", archived_at: expect.any(String) });
    expect(db.escritas.some((e) => e.patch?.status === "FAILED")).toBe(false);
  });

  it("WAHA no ar: revoga antes do banco e não avisa", async () => {
    authOk();
    const db = makeDb([canalWaha()]);
    wahaOk(db);

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: false, revogado: true, aviso: null });
    expect(db.eventos).toEqual(["waha:logout", "waha:delete", "delete:channel_sessions"]);
  });
});

describe("excluir conexão Evolution", () => {
  it("exclui_evolution_e_desloga: logout e delete da instância no servidor → revogado=true", async () => {
    authOk();
    const db = makeDb([canalEvolution()], CONVERSA);
    vi.mocked(resolveEvolutionCreds).mockResolvedValue(CREDS_EVOLUTION);
    const waha = wahaOk(db);
    const f = stubFetchEvolution(db);

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: true, revogado: true, aviso: null });
    expect(vi.mocked(resolveEvolutionCreds).mock.calls[0]?.[1]).toEqual({ organizationId: ORG, instance: "chip-alfa" });
    expect(f.mock.calls.map(([, init]) => init.method)).toEqual(["DELETE", "DELETE"]);
    // Revoga antes de mexer no banco, e não fala com o WAHA.
    expect(db.eventos).toEqual([
      "evolution:/instance/logout/chip-alfa",
      "evolution:/instance/delete/chip-alfa",
      "update:channel_sessions",
    ]);
    expect(waha.logoutSession).not.toHaveBeenCalled();
    // Evolution não é canal oficial: nada de apagar credencial de Meta nem trocar o token do webhook.
    expect(db.escritas[0]?.patch).not.toHaveProperty("meta_token_encrypted");
  });

  it("chip já desconectado: logout recusado (instância fechada) + delete ok → revogado=true, sem aviso", async () => {
    authOk();
    const db = makeDb([canalEvolution()]);
    vi.mocked(resolveEvolutionCreds).mockResolvedValue(CREDS_EVOLUTION);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        db.eventos.push(`evolution:${new URL(url).pathname}`);
        return new URL(url).pathname.startsWith("/instance/logout/")
          ? new Response(JSON.stringify({ message: "The \"chip-alfa\" instance is not connected" }), { status: 400 })
          : new Response(JSON.stringify({ status: "SUCCESS" }), { status: 200 });
      }),
    );

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: false, revogado: true, aviso: null });
    expect(db.eventos).toEqual([
      "evolution:/instance/logout/chip-alfa",
      "evolution:/instance/delete/chip-alfa",
      "delete:channel_sessions",
    ]);
  });

  it("exclui_evolution_fora_do_ar: servidor recusa a conexão → 200, revogado=false e aviso", async () => {
    authOk();
    const db = makeDb([canalEvolution()]);
    vi.mocked(resolveEvolutionCreds).mockResolvedValue(CREDS_EVOLUTION);
    stubFetchEvolution(db, econnrefused);

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: false, revogado: false, aviso: AVISO });
    expect(db.escritas).toEqual([{ tipo: "delete", table: "channel_sessions", patch: null }]);
  });

  it("Evolution sem credencial configurada → 200, revogado=false e aviso, sem chamar o servidor", async () => {
    authOk();
    const db = makeDb([canalEvolution()]);
    vi.mocked(resolveEvolutionCreds).mockResolvedValue(null);
    const f = stubFetchEvolution(db);

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ revogado: false, aviso: AVISO });
    expect(f).not.toHaveBeenCalled();
    expect(db.escritas.map((e) => e.tipo)).toEqual(["delete"]);
  });

  it("falha ao ler a credencial não vira 500: a conexão sai do CRM com aviso", async () => {
    authOk();
    makeDb([canalEvolution()]);
    vi.mocked(resolveEvolutionCreds).mockRejectedValue(new Error("evolution_creds_lookup_failed: XX000"));

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ revogado: false, aviso: AVISO });
  });
});

/**
 * Servidor que ACEITA a conexão e não responde: sem orçamento, cada passo do WAHA
 * espera 15 s (logout e delete, cada um com uma releitura) e a tela, com limite de
 * 20 s, desistia antes de o banco ser tocado — erro vermelho, aviso perdido. A
 * revogação inteira cabe em 6 s; estourou, o canal sai do CRM com o aviso.
 */
describe("servidor que não responde não segura a exclusão", () => {
  const ORCAMENTO_MS = 6_000;
  const nunca = () => new Promise<never>(() => {});

  afterEach(() => vi.useRealTimers());

  async function excluirComRelogio() {
    const { DELETE } = await import("./route");
    vi.useFakeTimers();
    let terminou = false;
    const pendente = DELETE(reqDelete(), ctx()).then((res) => {
      terminou = true;
      return res;
    });
    await vi.advanceTimersByTimeAsync(ORCAMENTO_MS - 1);
    const antesDoOrcamento = terminou;
    await vi.advanceTimersByTimeAsync(1);
    const res = await pendente;
    return { antesDoOrcamento, status: res.status, body: await res.json() };
  }

  it("WAHA pendurado: arquiva no fim do orçamento e devolve revogado=false com aviso", async () => {
    authOk();
    const db = makeDb([canalWaha()], CONVERSA);
    const waha = wahaOk(db);
    waha.logoutSession.mockImplementation(nunca);
    waha.deleteSession.mockImplementation(nunca);

    const { antesDoOrcamento, status, body } = await excluirComRelogio();

    expect(antesDoOrcamento).toBe(false);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: true, revogado: false, aviso: AVISO });
    expect(db.escritas.map((e) => e.tipo)).toEqual(["update"]);
  });

  it("Evolution pendurada: apaga no fim do orçamento e devolve revogado=false com aviso", async () => {
    authOk();
    const db = makeDb([canalEvolution()]);
    vi.mocked(resolveEvolutionCreds).mockResolvedValue(CREDS_EVOLUTION);
    // Ignora o sinal de propósito: o orçamento da rota não pode depender do teto de cada chamada.
    vi.stubGlobal("fetch", vi.fn(nunca));

    const { antesDoOrcamento, status, body } = await excluirComRelogio();

    expect(antesDoOrcamento).toBe(false);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: false, revogado: false, aviso: AVISO });
    expect(db.escritas.map((e) => e.tipo)).toEqual(["delete"]);
  });
});

/**
 * A conexão arquivada continua na tabela (é o que preserva o histórico) e o índice
 * único de instância só vale entre as ATIVAS: outra conexão pode reusar o nome. A
 * credencial é resolvida por organização + nome entre as ativas, então repetir o
 * DELETE da arquivada revogava a conexão NOVA no servidor e só "mexia" na velha.
 */
describe("reexcluir conexão já arquivada é inofensivo", () => {
  const ARQUIVADA = "2026-11-13T12:00:00.000Z";
  const OUTRO_CANAL = "55555555-5555-4555-8555-555555555555";

  it("A arquivada + B ativa com a mesma instância: DELETE de A não chama o servidor nem escreve", async () => {
    authOk();
    const ativa = canalEvolution({ id: OUTRO_CANAL, webhook_path_token: "tokendaconexaonova0001" });
    const db = makeDb([canalEvolution({ archived_at: ARQUIVADA }), ativa], CONVERSA);
    vi.mocked(resolveEvolutionCreds).mockResolvedValue(CREDS_EVOLUTION);
    const f = stubFetchEvolution(db);

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ id: CANAL, archived: true, revogado: false, aviso: null });
    expect(f).not.toHaveBeenCalled();
    expect(resolveEvolutionCreds).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
    expect(ativa.archived_at).toBeNull();
  });

  it("WAHA arquivado: não desloga de novo nem escreve", async () => {
    authOk();
    const db = makeDb([canalWaha({ archived_at: ARQUIVADA })], CONVERSA);
    const waha = wahaOk(db);

    const { status, body } = await excluir();

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ archived: true, revogado: false, aviso: null });
    expect(waha.logoutSession).not.toHaveBeenCalled();
    expect(waha.deleteSession).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
  });
});

describe("conexão em andamento continua bloqueando", () => {
  it("conexao_em_andamento_continua_409: WAHA com pareamento em curso → 409, sem revogar nem escrever", async () => {
    authOk();
    const db = makeDb([canalWaha()], reservaOcupada());
    const waha = wahaOk(db);

    const { status, body } = await excluir();

    expect(status).toBe(409);
    expect(body.error.code).toBe("connection_in_progress");
    expect(db.escritas).toEqual([]);
    expect(waha.logoutSession).not.toHaveBeenCalled();
  });

  it("conexao_em_andamento_continua_409: vale também sem WAHA configurado", async () => {
    authOk();
    const db = makeDb([canalWaha()], reservaOcupada());
    vi.mocked(getWahaClient).mockReturnValue(null);

    expect((await excluir()).status).toBe(409);
    expect(db.escritas).toEqual([]);
  });

  it("conexao_em_andamento_continua_409: Evolution com pareamento em curso → 409, sem chamar o servidor", async () => {
    authOk();
    const db = makeDb([canalEvolution()], reservaOcupada());
    vi.mocked(resolveEvolutionCreds).mockResolvedValue(CREDS_EVOLUTION);
    const f = stubFetchEvolution(db);

    expect((await excluir()).status).toBe(409);
    expect(f).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
  });
});

/**
 * Depois de arquivada, a conexão não pode voltar pela porta do webhook: o
 * servidor que não respondeu na exclusão pode continuar vivo e mandando evento.
 * Os três caminhos de entrada resolvem a sessão e descartam a arquivada.
 */
describe("webhook_de_conexao_arquivada_nao_recria", () => {
  const ARQUIVADA = "2026-11-13T12:00:00.000Z";

  it("Evolution (/webhooks/evolution/[token]): ignora, sem arquivar o corpo nem ingerir", async () => {
    const db = makeDb([canalEvolution({ archived_at: ARQUIVADA })]);
    const { POST } = await import("@/app/api/v1/webhooks/evolution/[token]/route");
    const corpo = JSON.stringify({
      event: "messages.upsert",
      instance: "chip-alfa",
      data: { key: { id: "ABC", remoteJid: "5531999998888@s.whatsapp.net", fromMe: false }, message: { conversation: "oi" } },
    });

    const res = await POST(
      new NextRequest(`http://localhost/api/v1/webhooks/evolution/${TOKEN}`, { method: "POST", body: corpo }),
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: "ignored", reason: "canal_arquivado" });
    expect(handleInboundWebhook).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
  });

  const corpoWaha = JSON.stringify({
    event: "message",
    session: "org_2222_abc",
    payload: { id: "false_5531999998888@c.us_ABC", from: "5531999998888@c.us", fromMe: false, body: "oi" },
  });

  it("WAHA por token (/webhooks/waha/[token]): sessão arquivada não é encontrada, nada é ingerido", async () => {
    const db = makeDb([canalWaha({ archived_at: ARQUIVADA })]);
    const { POST } = await import("@/app/api/v1/webhooks/waha/[token]/route");

    const res = await POST(
      new NextRequest(`http://localhost/api/v1/webhooks/waha/${TOKEN}`, { method: "POST", body: corpoWaha }),
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(res.status).toBe(404);
    expect(dispatchWahaEvent).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
  });

  it("WAHA global (/webhooks/waha): sessão arquivada vira session_not_registered, nada é ingerido", async () => {
    const db = makeDb([canalWaha({ archived_at: ARQUIVADA })]);
    const { POST } = await import("@/app/api/v1/webhooks/waha/route");

    const res = await POST(new NextRequest("http://localhost/api/v1/webhooks/waha", { method: "POST", body: corpoWaha }));

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ accepted: false, reason: "session_not_registered" });
    expect(dispatchWahaEvent).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
  });

  it("controle: a MESMA sessão sem archived_at é encontrada pelo webhook WAHA por token", async () => {
    makeDb([canalWaha()]);
    const { POST } = await import("@/app/api/v1/webhooks/waha/[token]/route");

    const res = await POST(
      new NextRequest(`http://localhost/api/v1/webhooks/waha/${TOKEN}`, { method: "POST", body: corpoWaha }),
      { params: Promise.resolve({ token: TOKEN }) },
    );

    // Passa da busca da sessão (não é 404); o que acontece depois é da autenticação do webhook.
    expect(res.status).not.toBe(404);
  });
});
