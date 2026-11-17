/**
 * MENSAGEM QUE CHEGA ATRASADA SOBE NA LISTA.
 *
 * Chip reconecta e a Evolution entrega em lote mensagens com horas de atraso.
 * A ingestão carimbava a conversa com o horário ORIGINAL do WhatsApp, e a lista
 * ordena por `last_message_at`: a mensagem entrava, mas a conversa ficava lá
 * embaixo, e o operador não via.
 *
 * O que estes casos seguram:
 *   - com atraso relevante, a conversa ganha `last_message_at` = CHEGADA (e o
 *     preview desta mensagem), só se isso a faz subir;
 *   - o balão não é falsificado: `messages.sent_at` segue o horário original;
 *   - a regra de `service_closed_at` não muda: o carimbo (`fn_mark_conversation_message`)
 *     recebe o horário original, e a subida só vale se a mensagem é posterior
 *     ao fechamento do atendimento;
 *   - sem atraso, nada a mais é escrito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => {}) }));

import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

type Chamada = { metodo: string; args: unknown[] };
interface Update {
  tabela: string;
  valores: Record<string, unknown>;
  filtros: Chamada[];
}

let updates: Update[] = [];
let inseridas: Array<Record<string, unknown>> = [];
let rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
let subidaLanca = false;

function cadeia(registro: Chamada[] | null): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (r: (v: unknown) => void) => r({ data: [], error: null });
        if (prop === "maybeSingle") return async () => ({ data: null, error: null });
        return (...args: unknown[]) => {
          registro?.push({ metodo: String(prop), args });
          return cadeia(registro);
        };
      },
    },
  );
}

const admin = {
  from: (tabela: string) => ({
    select: () => cadeia(null),
    update: (valores: Record<string, unknown>) => {
      if (subidaLanca && tabela === "conversations" && "last_message_at" in valores) {
        throw new Error("boom: a subida lançou");
      }
      const u: Update = { tabela, valores, filtros: [] };
      updates.push(u);
      return cadeia(u.filtros);
    },
    insert: (linha: Record<string, unknown>) => ({
      select: () => ({
        maybeSingle: async () => {
          inseridas.push(linha);
          return { data: { id: "msg-1" }, error: null };
        },
      }),
    }),
  }),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ fn, args });
    if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
    if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
    return { data: null, error: null };
  },
};

function mensagem(enviadaHaMs: number): WahaEnvelope {
  return {
    event: "message",
    session: "chip-01",
    payload: {
      id: "3EB0AAA",
      from: "5581999990000@s.whatsapp.net",
      fromMe: false,
      body: "oi, ainda tem o kit?",
      timestamp: Math.floor((Date.now() - enviadaHaMs) / 1000),
    },
  };
}

async function ingerir(env: WahaEnvelope) {
  await dispatchWahaEvent(admin as never, { id: "sessao-1", organization_id: "org-1" } as never, env, "req-1");
}

const subidas = () => updates.filter((u) => u.tabela === "conversations" && "last_message_at" in u.valores);

beforeEach(() => {
  updates = [];
  inseridas = [];
  rpcs = [];
  subidaLanca = false;
});

describe("conversa com mensagem atrasada sobe na lista", () => {
  it("3 h de atraso: last_message_at vira o momento da chegada, com o preview desta mensagem", async () => {
    const antes = Date.now();
    const env = mensagem(3 * 3600_000);
    await ingerir(env);

    const s = subidas();
    expect(s, "a conversa ficou com o horário antigo e não sobe na lista").toHaveLength(1);
    const chegada = Date.parse(String(s[0]!.valores.last_message_at));
    expect(chegada).toBeGreaterThanOrEqual(antes - 1000);
    expect(s[0]!.valores.last_message_preview).toBe("oi, ainda tem o kit?");
    // Só a conversa desta organização, e só se SOBE (nunca rebaixa atividade mais nova).
    const filtros = JSON.stringify(s[0]!.filtros);
    expect(filtros).toContain("conversa-1");
    expect(filtros).toContain("org-1");
    expect(s[0]!.filtros.some((f) => f.metodo === "lt" && f.args[0] === "last_message_at")).toBe(true);
  });

  it("o balão mantém o horário original do WhatsApp", async () => {
    const env = mensagem(3 * 3600_000);
    await ingerir(env);
    expect(inseridas[0]!.sent_at).toBe(new Date(env.payload!.timestamp! * 1000).toISOString());
  });

  it("a regra de service_closed_at não muda: o carimbo recebe o horário original, e a subida exige mensagem posterior ao fechamento", async () => {
    const env = mensagem(3 * 3600_000);
    await ingerir(env);
    const original = new Date(env.payload!.timestamp! * 1000).toISOString();

    const marca = rpcs.find((r) => r.fn === "fn_mark_conversation_message");
    expect(marca!.args.p_at).toBe(original);

    const filtroDoFechamento = subidas()[0]!.filtros.find((f) => f.metodo === "or");
    expect(filtroDoFechamento, "a subida ignoraria o fechamento do atendimento").toBeDefined();
    expect(String(filtroDoFechamento!.args[0])).toBe(
      `service_closed_at.is.null,service_closed_at.lt.${original}`,
    );
  });

  it("controle: mensagem em dia (10 s) não escreve nada a mais na conversa", async () => {
    await ingerir(mensagem(10_000));
    expect(subidas()).toHaveLength(0);
  });

  it("controle: sem timestamp do WhatsApp o carimbo já é a chegada — nada a mais", async () => {
    const env = mensagem(0);
    delete env.payload!.timestamp;
    await ingerir(env);
    expect(subidas()).toHaveLength(0);
  });

  it("exceção na subida não derruba a ingestão: a mensagem já está gravada", async () => {
    subidaLanca = true;
    await expect(ingerir(mensagem(3 * 3600_000))).resolves.toBeUndefined();
    expect(inseridas).toHaveLength(1);
  });
});
