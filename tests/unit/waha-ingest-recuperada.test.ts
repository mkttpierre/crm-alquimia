/**
 * Ingestão de mensagem RECUPERADA (reconciliação de entrada): o MESMO caminho do webhook
 * (`dispatchWahaEvent` → `handleInbound`), com uma marca a mais.
 *
 *   - a linha nasce com `metadata.recuperada = true` (é o que o dreno do `event_log` lê para não
 *     acordar consumidor que envia);
 *   - a conversa é carimbada como sempre (sobe na lista, soma não lida);
 *   - os efeitos pós-entrada recebem `recuperada: true` (só o opt-out roda, ver `pos-entrada.ts`);
 *   - no dedup (`23505`) a recuperada NÃO reacelera o follow-up.
 *
 * E a mensagem viva continua byte a byte como antes: sem chave nova no `metadata`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/atribuicao-de-anuncio", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  estamparAtribuicaoDoContato: vi.fn(async () => undefined),
}));
const posEntrada = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: (...a: unknown[]) => posEntrada(...a) }));
const acelerar = vi.fn(async () => undefined);
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ acelerarPipelineDeEventos: (...a: unknown[]) => acelerar(...(a as [])) }));

import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

function dublarAdmin(opts: { duplicada?: boolean } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const rpcs: string[] = [];
  const admin = {
    rpc: (nome: string) => {
      rpcs.push(nome);
      const data = nome === "fn_upsert_wa_contact" ? "c-1" : nome === "fn_upsert_wa_conversation" ? "conv-1" : null;
      const r = Promise.resolve({ data, error: null });
      return Object.assign(r, { then: r.then.bind(r) });
    },
    from: () => {
      let inseriu = false;
      const fixos: Record<string, unknown> = {
        insert: (linha: Record<string, unknown>) => {
          inserts.push(linha);
          inseriu = true;
          return q;
        },
        maybeSingle: async () =>
          inseriu && opts.duplicada
            ? { data: null, error: { code: "23505", message: "dup" } }
            : { data: inseriu ? { id: "m-1" } : { id: "m-1", contact_id: "c-1", body: "oi" }, error: null },
        then: (r: (x: unknown) => void) => r({ data: [], error: null }),
      };
      // Qualquer outro filtro do PostgREST devolve a própria cadeia.
      const q: Record<string, unknown> = new Proxy(fixos, { get: (alvo, k: string) => (k in alvo ? alvo[k] : () => q) });
      return q;
    },
  };
  return { admin: admin as never, inserts, rpcs };
}

const SESSAO = { id: "s-1", organization_id: "org-1", is_warmup_complete: true, warmup_started_at: null };
const ENVELOPE: WahaEnvelope = {
  event: "message",
  session: "chip-alfa",
  payload: { id: "3EB0REC", from: "5581999990000@s.whatsapp.net", fromMe: false, body: "oi", timestamp: 1_762_300_000 },
};

beforeEach(() => {
  posEntrada.mockClear();
  acelerar.mockClear();
});

describe("ingestão de mensagem recuperada", () => {
  it("grava com a marca, carimba a conversa e passa `recuperada` aos efeitos", async () => {
    const { admin, inserts, rpcs } = dublarAdmin();
    await dispatchWahaEvent(admin, SESSAO, ENVELOPE, "req-1", { recuperada: true });

    const linha = inserts.find((l) => l.external_id === "3EB0REC")!;
    expect(linha.direction).toBe("inbound");
    expect((linha.metadata as Record<string, unknown>).recuperada).toBe(true);
    // A data é a do WhatsApp, não a da recuperação: a mensagem entra no lugar certo da conversa.
    expect(linha.sent_at).toBe(new Date(1_762_300_000 * 1000).toISOString());
    expect(rpcs).toContain("fn_mark_conversation_message");
    expect(posEntrada).toHaveBeenCalledWith(admin, expect.objectContaining({ recuperada: true, messageId: "m-1" }));
  });

  it("mensagem viva: nenhuma chave nova no metadata, efeitos sem `recuperada`", async () => {
    const { admin, inserts } = dublarAdmin();
    await dispatchWahaEvent(admin, SESSAO, ENVELOPE, "req-2");
    const linha = inserts.find((l) => l.external_id === "3EB0REC")!;
    expect(linha.metadata).not.toHaveProperty("recuperada");
    expect(posEntrada.mock.calls[0]![1]).not.toHaveProperty("recuperada");
  });

  it("dedup (23505) de recuperada não reacelera o follow-up", async () => {
    const { admin } = dublarAdmin({ duplicada: true });
    await dispatchWahaEvent(admin, SESSAO, ENVELOPE, "req-3", { recuperada: true });
    expect(acelerar).not.toHaveBeenCalled();
    expect(posEntrada).not.toHaveBeenCalled();
  });
});
