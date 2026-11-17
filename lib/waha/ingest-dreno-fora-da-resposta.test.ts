/**
 * O DRENO GLOBAL DO `event_log` NÃO RODA DENTRO DO POST DO WEBHOOK.
 *
 * ─── O defeito, medido em produção (10/11/2026) ─────────────────────────────
 *
 * Cada `messages.upsert` da Evolution rodava, DENTRO da requisição, um
 * `drainEventLog` global: até 50 eventos de QUALQUER organização, com handlers
 * de IA, sentimento, mídia e LGPD. Mediana de 1 a 21 s por mensagem, p95 até
 * 213 s; a Evolution estourava o tempo do webhook (285 vezes numa hora) e
 * reentregava a mesma mensagem 6 a 9 vezes — e a reentrega (caminho do 23505)
 * disparava o pipeline inteiro de novo. A carga se realimentava.
 *
 * O que estes casos seguram:
 *   1. a resposta não espera o dreno global (nem fora de request, nem dentro);
 *   2. N mensagens não viram N drenos: um por vez no processo, e as que chegam
 *      durante ele pedem UMA rodada a mais (para os eventos delas não ficarem
 *      parados numa instalação sem worker);
 *   3. a reentrega (23505) não dispara dreno nenhum.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drainEventLog = vi.fn();
vi.mock("@/lib/event-log/drain", () => ({
  drainEventLog: (...a: unknown[]) => drainEventLog(...a),
}));
vi.mock("@/lib/event-log/register-handlers", () => ({ ensureHandlersRegistered: vi.fn() }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  idsDoContatoEGemeos: vi.fn(async (_a: unknown, _o: string, c: string) => [c]),
}));
const aplicarTextoNosFollowups = vi.fn(async () => {});
vi.mock("@/lib/followup/aplicar-inbound", () => ({
  aplicarTextoNosFollowups: (...a: unknown[]) => aplicarTextoNosFollowups(...(a as [])),
}));
vi.mock("@/lib/followup/reactivity", () => ({
  applyReactivityEvent: vi.fn(async () => {}),
  createSupabaseReactivityClient: vi.fn(() => ({})),
}));
const enviarTextoFixoPendente = vi.fn(async () => 0);
vi.mock("@/lib/followup/enviar-texto-fixo", () => ({
  enviarTextoFixoPendente: (...a: unknown[]) => enviarTextoFixoPendente(...(a as [])),
}));
vi.mock("@/lib/followup/engine", () => ({
  avancarEnrollmentAtivo: vi.fn(async () => {}),
  createSupabaseAdminClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * `after()` do Next: dentro de um route handler agenda a tarefa para DEPOIS da
 * resposta; fora de request (teste, worker, script) lança. Os dois modos.
 */
let modoAfter: "fora_de_request" | "dentro_de_request" = "fora_de_request";
let tarefasDoAfter: Array<() => unknown> = [];
vi.mock("next/server", () => ({
  after: (tarefa: () => unknown) => {
    if (modoAfter === "fora_de_request") {
      throw new Error("`after` was called outside a request scope.");
    }
    tarefasDoAfter.push(tarefa);
  },
}));

import { acelerarPipelineDeEventos } from "@/lib/dev/kick-local-pipeline";
import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

/** Builder do PostgREST de mentira: encadeável, resolve `{ data: [], error: null }`. */
function consultaVazia(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        }
        return () => consultaVazia();
      },
    },
  );
}
const admin = { from: () => consultaVazia(), rpc: async () => ({ data: null, error: null }) } as never;

function inbound(i: number) {
  return { organizationId: "org-1", contactId: `contato-${i}`, messageId: `msg-${i}`, texto: "oi" };
}

/** O dreno "trava" até o teste soltar — é o dreno de 21 s de produção, sem o relógio. */
let soltarDreno: () => void = () => {};
function drenoQueEspera() {
  drainEventLog.mockImplementation(
    () =>
      new Promise((resolve) => {
        soltarDreno = () => resolve({ scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 });
      }),
  );
}

const ESTOUROU = Symbol("estourou");
async function respondeEmAte(ms: number, p: Promise<unknown>): Promise<unknown> {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(ESTOUROU), ms))]);
}

async function esperarFilaAssentar() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  drainEventLog.mockReset();
  drainEventLog.mockResolvedValue({ scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 });
  aplicarTextoNosFollowups.mockClear();
  enviarTextoFixoPendente.mockClear();
  modoAfter = "fora_de_request";
  tarefasDoAfter = [];
});

afterEach(async () => {
  // Nenhum dreno pendurado vaza para o caso seguinte.
  soltarDreno();
  await Promise.all(tarefasDoAfter.map((t) => t()));
  await esperarFilaAssentar();
});

describe("a resposta do webhook não espera o dreno global", () => {
  it("fora de request: cada mensagem responde com o dreno ainda rodando, e o processo roda UM", async () => {
    drenoQueEspera();

    for (let i = 1; i <= 5; i++) {
      const r = await respondeEmAte(200, acelerarPipelineDeEventos(admin, inbound(i)));
      expect(r, `a mensagem ${i} ficou esperando o dreno global`).not.toBe(ESTOUROU);
    }
    expect(drainEventLog, "N mensagens empilharam N drenos").toHaveBeenCalledTimes(1);

    soltarDreno();
    await esperarFilaAssentar();
    soltarDreno();
    await esperarFilaAssentar();

    // As 4 que chegaram durante o 1º dreno pedem UMA rodada a mais, não quatro.
    expect(drainEventLog).toHaveBeenCalledTimes(2);
  });

  it("dentro de request: o dreno vai para depois da resposta (after) e não empilha", async () => {
    modoAfter = "dentro_de_request";

    await Promise.all([1, 2, 3, 4, 5].map((i) => acelerarPipelineDeEventos(admin, inbound(i))));
    expect(drainEventLog, "o dreno rodou dentro da resposta").not.toHaveBeenCalled();
    expect(tarefasDoAfter.length).toBeGreaterThan(0);

    const tarefas = tarefasDoAfter;
    tarefasDoAfter = [];
    await Promise.all(tarefas.map((t) => t()));

    expect(drainEventLog.mock.calls.length, "5 mensagens viraram 5 drenos globais").toBeLessThanOrEqual(2);
    expect(drainEventLog.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("o follow-up DESTE contato avança antes da resposta, e de novo depois do dreno", async () => {
    modoAfter = "dentro_de_request";

    await acelerarPipelineDeEventos(admin, inbound(7));
    expect(aplicarTextoNosFollowups).toHaveBeenCalledTimes(1);
    const antes = enviarTextoFixoPendente.mock.calls.length;
    expect(antes, "o tick do contato saiu da resposta").toBeGreaterThan(0);

    const tarefas = tarefasDoAfter;
    tarefasDoAfter = [];
    await Promise.all(tarefas.map((t) => t()));
    // O dreno pode ter matriculado o contato num fluxo: o tick seguinte é o que
    // manda o 1º texto — continua acontecendo, agora fora da resposta.
    expect(enviarTextoFixoPendente.mock.calls.length).toBeGreaterThan(antes);
  });
});

describe("reentrega (23505) não redispara o pipeline pesado", () => {
  function bancoComMensagemJaIngerida() {
    // Toda consulta encadeia; `maybeSingle` acha a mensagem já gravada, e o
    // resto (matrículas de follow-up etc.) volta vazio.
    const consulta = (): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "maybeSingle") {
              return async () => ({ data: { id: "msg-1", contact_id: "contato-1", body: "oi" }, error: null });
            }
            if (prop === "then") {
              return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
            }
            return () => consulta();
          },
        },
      );
    return {
      from: () => ({
        select: () => consulta(),
        insert: () => ({
          select: () => ({
            maybeSingle: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
          }),
        }),
      }),
      rpc: async (fn: string) => {
        if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
        if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
        return { data: null, error: null };
      },
    };
  }

  const REENTREGA: WahaEnvelope = {
    event: "message",
    session: "default",
    payload: { id: "3EB0ABC", from: "5511999999999@s.whatsapp.net", fromMe: false, body: "oi" },
  };

  it("a mesma mensagem reentregue 6 vezes não roda dreno global nenhum", async () => {
    modoAfter = "dentro_de_request";
    const banco = bancoComMensagemJaIngerida();

    for (let i = 0; i < 6; i++) {
      await dispatchWahaEvent(banco as never, { id: "sessao-1", organization_id: "org-1" } as never, REENTREGA, "req-1");
    }
    const tarefas = tarefasDoAfter;
    tarefasDoAfter = [];
    await Promise.all(tarefas.map((t) => t()));
    await esperarFilaAssentar();

    expect(drainEventLog, "a reentrega disparou o dreno global de novo").not.toHaveBeenCalled();
  });

  it("controle: a reentrega ainda destrava o match_reply do follow-up deste contato", async () => {
    // A 1ª entrega pode ter gravado e caído antes dos efeitos; a recuperação
    // barata (só o contato) fica.
    const banco = bancoComMensagemJaIngerida();
    await dispatchWahaEvent(banco as never, { id: "sessao-1", organization_id: "org-1" } as never, REENTREGA, "req-1");
    expect(aplicarTextoNosFollowups).toHaveBeenCalledTimes(1);
  });
});
