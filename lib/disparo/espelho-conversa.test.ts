/**
 * O que o motor manda aparece no CRM na hora.
 *
 * Antes, a abertura fria e os toques de quem nunca respondeu não tinham conversa, então nada aparecia no
 * inbox até o lead responder. Agora o envio real cria a conversa do lead naquele chip, já `resolved` (fica em
 * "Todas" e fora da Fila; quando o lead responde, `fn_service_inbound` reabre como `open`), e grava a mensagem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";
import type { ChannelAdapter } from "@/lib/channels";

import { RITMO_PADRAO, type ConfigDisparo } from "./config";
import { criarEnvioReal } from "./envio-real";
import type { LeadDoDisparo } from "./motor";

const adapter = {
  resolveRecipient: vi.fn((r: { phoneNumber: string | null }) => r.phoneNumber),
  send: vi.fn(async () => ({ externalId: "wamid-1" })),
} as unknown as ChannelAdapter;

vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider, ref",
  resolveSessionRef: (s: { ref: string }) => s.ref,
  getAdapter: () => adapter,
}));

const ORG = "00000000-0000-4000-8000-0000000000a1";

type Linha = Record<string, unknown>;

function bancoFalso(inicial: { conversas?: Linha[]; conflitoNaCriacao?: Linha; falhaEspelho?: boolean; mensagens?: Linha[] } = {}) {
  const tabelas: Record<string, Linha[]> = {
    disparo_chips: [{ organization_id: ORG, id: "chip-1", channel_session_id: "sessao-1" }],
    channel_sessions: [{ organization_id: ORG, id: "sessao-1", provider: "p", ref: "r", archived_at: null }],
    crm_leads: [{ organization_id: ORG, id: "lead-1", contact_id: "contato-1" }],
    conversations: [...(inicial.conversas ?? [])],
    messages: [...(inicial.mensagens ?? [])],
  };
  let conflito = inicial.conflitoNaCriacao;
  const from = (t: string) => {
    const filtros: [string, unknown][] = [];
    const achar = () => (tabelas[t] ?? []).find((r) => filtros.every(([c, v]) => r[c] === v)) ?? null;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      maybeSingle: async () => ({ data: achar(), error: null }),
      update: (patch: Linha) => {
        const u = {
          eq: (c: string, v: unknown) => (filtros.push([c, v]), u),
          then: (ok: (r: { error: null }) => void) => {
            for (const r of tabelas[t] ?? []) if (filtros.every(([c, v]) => r[c] === v)) Object.assign(r, patch);
            ok({ error: null });
          },
        };
        return u;
      },
      insert: (linha: Linha) => {
        let erro: { code: string; message: string } | null = null;
        if (t === "messages" && inicial.falhaEspelho) {
          erro = { code: "XX000", message: "erro simulado" };
        } else if (
          t === "messages" &&
          tabelas.messages!.some((m) => m.organization_id === linha.organization_id && m.external_id === linha.external_id)
        ) {
          // O unique (organization_id, external_id) de `messages`.
          erro = { code: "23505", message: "duplicate key" };
        } else if (t === "conversations" && conflito) {
          // Corrida: o recebimento criou a conversa entre o select e o insert.
          tabelas.conversations!.push(conflito);
          conflito = undefined;
          erro = { code: "23505", message: "duplicate key" };
        } else {
          tabelas[t]!.push({ id: `${t}-${tabelas[t]!.length + 1}`, ...linha });
        }
        const criada = erro ? null : tabelas[t]![tabelas[t]!.length - 1];
        const r = {
          select: () => r,
          single: async () => ({ data: criada, error: erro }),
          then: (ok: (x: { error: typeof erro }) => void) => ok({ error: erro }),
        };
        return r;
      },
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, tabelas };
}

const CONFIG: ConfigDisparo = {
  organizationId: ORG, ligado: true, modo: "real", tetoDiario: null, cadencia: "reativacao_3_toques", fonteStageId: null,
  ritmo: { ...RITMO_PADRAO, feriados: [] }, modelos: {}, proibidos: [], slots: { fixos: {}, semNomeQuando: [] }, escolha: [],
};
const LEAD: LeadDoDisparo = {
  id: "lead-1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {},
};
const enviar = (db: SupabaseClient) =>
  criarEnvioReal(db, { DISPARO_REAL_LIBERADO: "sim" })({ config: CONFIG, chipId: "chip-1", lead: LEAD, texto: "Oi, Maria!", midiaId: null });

describe("envio do motor aparece no CRM na hora", () => {
  it("abertura fria sem conversa: cria a conversa resolvida no chip do envio e grava a mensagem nela", async () => {
    const { db, tabelas } = bancoFalso();
    await enviar(db);

    expect(tabelas.conversations).toHaveLength(1);
    const conversa = tabelas.conversations![0]!;
    expect(conversa).toMatchObject({
      organization_id: ORG, contact_id: "contato-1", channel_session_id: "sessao-1", status: "resolved", is_group: false, channel: "whatsapp",
    });
    expect(tabelas.messages).toHaveLength(1);
    expect(tabelas.messages![0]).toMatchObject({
      conversation_id: conversa.id, direction: "outbound", body: "Oi, Maria!", external_id: "wamid-1", sent_via: "automation",
    });
    expect(conversa.last_message_preview).toBe("Oi, Maria!");
  });

  it("conversa que já existe: usa a mesma e não cria outra", async () => {
    const { db, tabelas } = bancoFalso({
      conversas: [{ organization_id: ORG, id: "conv-velha", contact_id: "contato-1", channel_session_id: "sessao-1", status: "open" }],
    });
    await enviar(db);
    expect(tabelas.conversations).toHaveLength(1);
    expect(tabelas.conversations![0]!.status).toBe("open");
    expect(tabelas.messages![0]).toMatchObject({ conversation_id: "conv-velha" });
  });

  it("corrida com o recebimento (23505 na criação): usa a conversa que o recebimento criou", async () => {
    const { db, tabelas } = bancoFalso({
      conflitoNaCriacao: { organization_id: ORG, id: "conv-do-inbound", contact_id: "contato-1", channel_session_id: "sessao-1", status: "open" },
    });
    await enviar(db);
    expect(tabelas.conversations).toHaveLength(1);
    expect(tabelas.messages![0]).toMatchObject({ conversation_id: "conv-do-inbound" });
  });
});


describe("motor, eco primeiro: o SEND_MESSAGE chegou antes do espelho", () => {
  /** Como a ingestão grava o eco `fromMe` que chegou antes: "enviada pelo celular". */
  const ecoDoWebhook = (extra: Linha = {}): Linha => ({
    id: "m-eco",
    organization_id: ORG,
    conversation_id: "conv-1",
    external_id: "wamid-1",
    direction: "outbound",
    body: "Oi, Maria!",
    sent_via: "external_device",
    metadata: { raw_type: "chat", fromMe: true },
    ...extra,
  });

  it("a linha do eco passa a ser do motor (espelho_do_disparo), sem segunda linha", async () => {
    const { db, tabelas } = bancoFalso({
      conversas: [{ organization_id: ORG, id: "conv-1", contact_id: "contato-1", channel_session_id: "sessao-1", status: "open" }],
      mensagens: [ecoDoWebhook()],
    });
    await enviar(db);
    expect(tabelas.messages).toHaveLength(1);
    expect(tabelas.messages![0]).toMatchObject({
      id: "m-eco",
      sent_via: "automation",
      metadata: { raw_type: "chat", fromMe: true, espelho_do_disparo: true },
    });
  });

  it("linha do mesmo id que NÃO é eco do celular (composer, IA) não é tocada", async () => {
    const { db, tabelas } = bancoFalso({
      conversas: [{ organization_id: ORG, id: "conv-1", contact_id: "contato-1", channel_session_id: "sessao-1", status: "open" }],
      mensagens: [ecoDoWebhook({ sent_via: "user", metadata: {} })],
    });
    await enviar(db);
    expect(tabelas.messages![0]).toMatchObject({ sent_via: "user", metadata: {} });
  });
});

it("registra erro ao falhar o espelho sem causar reenvio", async () => {
  const log = vi.spyOn(logger, "error").mockImplementation(() => {});
  const { db, tabelas } = bancoFalso({ falhaEspelho: true });
  const chamadasAntes = vi.mocked(adapter.send).mock.calls.length;
  const resultado = await enviar(db);
  expect(resultado.externalId).toBe("wamid-1");
  expect(vi.mocked(adapter.send).mock.calls.length - chamadasAntes).toBe(1);
  expect(tabelas.messages).toHaveLength(0);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

it("registra falha do canal que não chegou a produzir espelho", async () => {
  const log = vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.mocked(adapter.send).mockRejectedValueOnce(new Error("falha simulada"));
  const { db, tabelas } = bancoFalso();
  await expect(enviar(db)).rejects.toThrow("falha simulada");
  expect(tabelas.messages).toHaveLength(0);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});
