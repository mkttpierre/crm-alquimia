/**
 * Task 4a do seam de canais — rede de caracterização do caminho de envio.
 *
 * Fixa os 6 desfechos que `sendMessageHandler` produz DEPOIS de inserir a linha
 * (`_handler.ts:219-318`), escrita contra o código ATUAL, antes de qualquer
 * refactor. As Tasks 4b–4d trocam `getWahaClient`/`resolveWahaChatId`/`sendMedia`
 * por `ChannelAdapter` — por isso aqui se asserta o **estado final da linha de
 * mensagem**, nunca a sequência de chamadas internas: teste que asserta chamada
 * travaria exatamente o refactor que ele deveria proteger.
 *
 * Fake próprio de propósito: `tests/invariants/automation-send-whatsapp.test.ts`
 * é o único outro teste que exercita este handler, mas arrasta `gov-helpers` e
 * exige Postgres real — e a pasta `tests/invariants/` está fora do `test:unit` e
 * do CI. Duplicar scaffolding é o preço de uma rede que gateia PR em segundos.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const WAHA_BASE = 'http://localhost:3030';

// A URL assinada do Storage é montada com o admin client; ele valida env no
// import, e o desfecho de mídia precisa controlar sucesso E falha da assinatura.
const signedUrl = vi.fn<() => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>>(
  async () => ({ data: { signedUrl: 'https://signed.example/a.jpg' }, error: null }),
);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: signedUrl }) } }),
}));
// Audit é fire-and-forget e escreve em outra tabela; fora do escopo dos desfechos.
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;

interface ConversationShape {
  isGroup?: boolean;
  groupChatId?: string | null;
  phoneNumber?: string | null;
  waIdentity?: string | null;
  isBlocked?: boolean;
  sessionStatus?: string | null;
  provider?: string;
  /** Canal excluído pelo usuário (migration 0106) — a linha sobrevive, o canal não. */
  archivedAt?: string | null;
}

function conversationRow(shape: ConversationShape = {}): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: shape.isGroup ?? false,
    group_chat_id: shape.groupChatId ?? null,
    contacts: {
      phone_number: shape.phoneNumber === undefined ? '+5531999998888' : shape.phoneNumber,
      wa_identity: shape.waIdentity ?? null,
      is_blocked: shape.isBlocked ?? false,
    },
    channel_sessions:
      shape.sessionStatus === null
        ? null
        : {
            // `provider` sai do banco desde a migration 0087 — o handler não
            // supõe mais o canal, então a linha falsa também não pode supor.
            provider: shape.provider ?? 'waha',
            waha_session_name: 'default',
            status: shape.sessionStatus ?? 'WORKING',
            archived_at: shape.archivedAt ?? null,
          },
  };
}

/**
 * Fake de `SupabaseClient` com o mínimo que o handler encadeia:
 *   conversations: select().eq().maybeSingle() · update().eq()
 *   messages:      insert().select().single() · update().eq().select().maybeSingle()
 *   rpc('emit_event')
 * O update é merge raso — igual ao que o Postgres faz com um SET de colunas.
 */
function makeSupabase(
  conversation: Row,
  templateRow: Row | null = null,
  /** `semColunaArquivada`: banco em que a migration 0106 ainda não rodou. */
  opts: { semColunaArquivada?: boolean; channelMetadata?: Row; rows?: Row[] } = {},
) {
  const state: { message: Row | null; rows: Row[] } = { message: null, rows: opts.rows ?? [] };

  const client = {
    from(table: string) {
      if (table === "channel_sessions") {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: { metadata: opts.channelMetadata ?? {} }, error: null }),
        };
        return query;
      }
      if (table === 'conversations') {
        return {
          select: (cols?: string) => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.semColunaArquivada === true && (cols ?? '').includes('archived_at')
                  ? {
                      data: null,
                      error: {
                        code: '42703',
                        message: 'column channel_sessions_1.archived_at does not exist',
                      },
                    }
                  : { data: conversation, error: null },
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'meta_templates') {
        // O espelho local do template. `templateRow` é injetado por caso; null
        // simula template que não existe (ou WABA errada).
        //
        // A cadeia é ENCADEÁVEL SEM LIMITE de propósito. A versão anterior tinha
        // exatamente três `eq` aninhados, e isso fazia o dublê ditar quantos
        // filtros o código de produção podia usar: acrescentar um quarto (a
        // conexão dona da definição, da 0144) quebrava com `q.eq is not a
        // function` — um vermelho que não fala do comportamento sob teste e
        // manda quem lê procurar defeito onde não há.
        const cadeia: Record<string, unknown> = {
          eq: () => cadeia,
          maybeSingle: async () => ({ data: templateRow, error: null }),
        };
        return { select: () => cadeia };
      }
      if (table === 'messages') {
        const filters: [string, unknown][] = [];
        const query = {
          eq: (col: string, value: unknown) => { filters.push([col, value]); return query; },
          gte: (col: string, value: unknown) => { filters.push([col, value]); return query; },
          then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.rows.filter(row => filters.every(([key, value]) => key === 'created_at' ? String(row[key]) >= String(value) : row[key] === value)), error: null }).then(resolve),
        };
        return {
          select: () => query,
          insert: (row: Row) => {
            state.message = {
              id: 'msg-1',
              external_id: null,
              ack: null,
              error_code: null,
              error_message: null,
              ...row,
              created_at: new Date().toISOString(),
            };
            state.rows.push(state.message);
            return { select: () => ({ single: async () => ({ data: { ...state.message }, error: null }) }) };
          },
          update: (patch: Row) => {
            state.message = { ...state.message, ...patch };
            const query = {
              eq: () => query,
              select: () => query,
              maybeSingle: async () => ({ data: { ...state.message }, error: null }),
              single: async () => ({ data: { ...state.message }, error: null }),
            };
            return query;
          },
        };
      }
      if (table === "contacts") {
        // O envio carimba `contacts.last_activity_at` (migration 0162). O dublê
        // é encadeável SEM LIMITE de propósito: a consulta filtra por id E por
        // organização (este handler também roda com o client de service role,
        // que bypassa RLS), e um dublê que fixa a quantidade de `eq` quebra
        // quando a consulta ganha um filtro novo — com um erro que não fala do
        // comportamento sob teste.
        const cadeiaContacts: Record<string, unknown> = {
          eq: () => cadeiaContacts,
          then: (resolve: (v: { error: null }) => unknown) =>
            Promise.resolve({ error: null }).then(resolve),
        };
        return { update: () => cadeiaContacts };
      }
      throw new Error(`fake_supabase: tabela inesperada '${table}'`);
    },
    rpc: async () => ({ error: null }),
  };

  return client as unknown as SupabaseClient;
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-1' };

function textInput(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return { conversation_id: CONV, type: 'text', body: 'oi', ...over } as SendMessageInput;
}

function wahaConfigured(configured: boolean) {
  vi.stubEnv('WAHA_API_BASE_URL', configured ? WAHA_BASE : '');
  vi.stubEnv('WAHA_API_KEY', configured ? 'hash123' : '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  signedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/a.jpg' }, error: null });
});

describe("duplicata de envio manual", () => {
  it("pedidos simultaneos iguais reservam apenas uma mensagem", async () => {
    wahaConfigured(false);
    const db = makeSupabase(conversationRow());
    const results = await Promise.allSettled([sendMessageHandler(db, ctx, textInput()), sendMessageHandler(db, ctx, textInput())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });

  it("permite reenviar uma mensagem anterior que falhou", async () => {
    wahaConfigured(false);
    const db = makeSupabase(conversationRow(), null, { rows: [{ organization_id: ORG, conversation_id: CONV, direction: "outbound", status: "failed", type: "text", body: "oi", created_at: new Date().toISOString() }] });
    await expect(sendMessageHandler(db, ctx, textInput())).resolves.toBeDefined();
  });

  it("permite anexo diferente com a mesma legenda", async () => {
    wahaConfigured(false);
    const db = makeSupabase(conversationRow());
    await sendMessageHandler(db, ctx, textInput({ type: "image", media_storage_path: `${ORG}/${CONV}/primeira.jpg` }));
    await expect(sendMessageHandler(db, ctx, textInput({ type: "image", media_storage_path: `${ORG}/${CONV}/segunda.jpg` }))).resolves.toBeDefined();
  });

  it("bloqueia a segunda e a terceira mensagem igual, mesmo com espa?os diferentes", async () => {
    wahaConfigured(false);
    const db = makeSupabase(conversationRow());
    await sendMessageHandler(db, ctx, textInput({ body: "Ol?  mundo" }));
    for (const body of ["  Ol? mundo  ", "Ol?\n mundo"]) {
      await expect(sendMessageHandler(db, ctx, textInput({ body }))).rejects.toMatchObject({ code: "mensagem_duplicada", status: 409 });
    }
  });
});

it("permite repeticao deliberada e envio automatico", async () => {
  wahaConfigured(false);
  const db = makeSupabase(conversationRow());
  await sendMessageHandler(db, ctx, textInput());
  await expect(sendMessageHandler(db, ctx, { ...textInput(), allow_duplicate: true } as SendMessageInput)).resolves.toBeDefined();
  const automatico: HandlerCtx = { ...ctx, actor: { type: "ai_agent", id: USER, role: "agent" } };
  await expect(sendMessageHandler(db, automatico, textInput())).resolves.toBeDefined();
  await expect(sendMessageHandler(db, automatico, textInput())).resolves.toBeDefined();
});
