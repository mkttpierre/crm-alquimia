/**
 * MENSAGENS QUE FALTAVAM NO CRM: enviadas pelo celular (`SEND_MESSAGE`), ligações (`CALL`),
 * edição (`MESSAGES_UPDATE` / protocolo de edição) e exclusão (`MESSAGES_DELETE`).
 *
 * Os testes entram pelo caminho de produção: `ingestEvolutionInbound` (o que a rota do token
 * chama) com o `dispatchWahaEvent` REAL por baixo e um Supabase em memória que implementa a única
 * regra de banco de que os desfechos dependem — `unique (organization_id, external_id)`.
 *
 * O que fica de fora, mockado como espião: os efeitos que respondem sozinhos (IA, atendimento do
 * motor, pausa da IA). É exatamente o que se quer contar: nenhum evento novo pode acordá-los.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const efeitosPosEntrada = vi.fn(async () => {});
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: (...a: unknown[]) => efeitosPosEntrada(...(a as [])) }));
const pausarIa = vi.fn(async () => {});
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: (...a: unknown[]) => pausarIa(...(a as [])) }));
const atenderEntradas = vi.fn(async (..._a: unknown[]) => 0);
vi.mock("@/lib/disparo/atendimento/gancho", () => ({ atenderEntradas: (...a: unknown[]) => atenderEntradas(...a) }));
vi.mock("@/lib/disparo/saude-eventos", () => ({ registrarConexoes: vi.fn(async () => 0), registrarEntregas: vi.fn(async () => 0) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ acelerarPipelineDeEventos: vi.fn(async () => {}) }));

import { assinarEventosDoWebhook, EVENTOS_DO_WEBHOOK } from "./client";
import { ingestEvolutionInbound } from "./ingest";
import { desfechoDaLigacao, textoDaLigacao } from "./ligacoes";
import {
  corpoSemChatsSemContato,
  traduzirEvento,
  webhookSoDeChatSemContato,
  type EvolutionEnvelope,
} from "./webhook";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

// ─── Supabase em memória ───────────────────────────────────────────────────────

type Linha = Record<string, unknown>;

function banco(inicial: Record<string, Linha[]> = {}) {
  const tabelas: Record<string, Linha[]> = { ...inicial };
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let seq = 0;

  const from = (nome: string) => {
    const linhas = (tabelas[nome] ??= []);
    const filtros: Array<(l: Linha) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let valores: Linha | Linha[] = {};
    const exec = async (umSo: boolean) => {
      if (op === "insert") {
        const novas = Array.isArray(valores) ? valores : [valores];
        for (const n of novas) {
          if (n.external_id && linhas.some((l) => l.organization_id === n.organization_id && l.external_id === n.external_id)) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
        }
        const criadas = novas.map((n) => ({ id: `${nome}-${++seq}`, ...n }));
        linhas.push(...criadas);
        return { data: umSo ? criadas[0] : criadas, error: null };
      }
      const casadas = linhas.filter((l) => filtros.every((f) => f(l)));
      if (op === "update") casadas.forEach((l) => Object.assign(l, valores));
      if (op === "delete") for (const l of casadas) linhas.splice(linhas.indexOf(l), 1);
      return { data: umSo ? (casadas[0] ?? null) : casadas, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      gte: (c: string, v: unknown) => (filtros.push((l) => String(l[c] ?? "") >= String(v)), q),
      gt: (c: string, v: unknown) => (filtros.push((l) => String(l[c] ?? "") > String(v)), q),
      lt: () => q,
      or: () => q,
      not: () => q,
      order: () => q,
      limit: () => q,
      insert: (v: Linha | Linha[]) => ((op = "insert"), (valores = v), q),
      update: (v: Linha) => ((op = "update"), (valores = v), q),
      delete: () => ((op = "delete"), q),
      maybeSingle: () => exec(true),
      single: () => exec(true),
      then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => exec(false).then(ok, erro),
    };
    return q;
  };

  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };
  return { admin, tabelas, rpcs, messages: () => tabelas.messages ?? [] };
}

const ORG = "org-1";
const SESSAO = {
  id: "sessao-1",
  organization_id: ORG,
  evolution_instance_name: "chip-01",
  is_warmup_complete: true,
  warmup_started_at: null,
  phone_number: "+5581988887777",
};
const LEAD = "5581999990000@s.whatsapp.net";
const GRUPO = "120363000000000000@g.us";

function novoBanco(extra: Record<string, Linha[]> = {}) {
  return banco({ channel_sessions: [{ ...SESSAO }], ...extra });
}

async function entregar(b: ReturnType<typeof banco>, corpo: unknown) {
  return ingestEvolutionInbound(b.admin as never, {
    session: { id: SESSAO.id, organization_id: ORG },
    rawBody: JSON.stringify(corpo),
  });
}

const evento = (event: string, data: unknown) => ({ event, instance: "chip-01", data });

/** Formato do `SEND_MESSAGE` da Evolution 2.3.7: o `messageRaw` do envio, `fromMe: true`. */
const enviada = (id: string, texto: string, jid = LEAD) =>
  evento("send.message", {
    key: { remoteJid: jid, fromMe: true, id },
    pushName: "Loja",
    message: { conversation: texto },
    messageType: "conversation",
    messageTimestamp: 1_763_053_500,
    status: "PENDING",
  });

/** Formato do `CALL` (Baileys `WACallEvent`), que a Evolution posta como lista. */
const ligacao = (status: string, extra: Record<string, unknown> = {}) =>
  evento("call", [
    {
      chatId: LEAD,
      from: LEAD,
      id: "CALL-1",
      date: "2026-11-13T17:05:00.000Z", // 14:05 em São Paulo
      isVideo: false,
      isGroup: false,
      offline: false,
      status,
      ...extra,
    },
  ]);

/** Edição: o protocolo de edição (tipo 14) dentro de `editedMessage`, como o Baileys 7 entrega. */
const protocoloDeEdicao = (alvo: string, texto: string, jid = LEAD) => ({
  editedMessage: {
    message: {
      protocolMessage: { key: { remoteJid: jid, fromMe: false, id: alvo }, type: 14, editedMessage: { conversation: texto } },
    },
  },
});
const edicaoPorUpdate = (alvo: string, texto: string, jid = LEAD) =>
  evento("messages.update", { keyId: alvo, remoteJid: jid, fromMe: false, status: "DELETED", message: protocoloDeEdicao(alvo, texto, jid) });

const exclusao = (alvo: string, jid = LEAD) => evento("messages.delete", { remoteJid: jid, fromMe: false, id: alvo });

const linhaDoLead = (extra: Linha = {}): Linha => ({
  id: "m-orig",
  organization_id: ORG,
  channel_session_id: SESSAO.id,
  external_id: "3EB0ORIG",
  direction: "inbound",
  type: "text",
  body: "texto velho",
  metadata: { raw_type: "chat" },
  ...extra,
});

beforeEach(() => {
  efeitosPosEntrada.mockClear();
  pausarIa.mockClear();
  atenderEntradas.mockClear();
});

// ─── SEND_MESSAGE ──────────────────────────────────────────────────────────────

describe("SEND_MESSAGE: mensagem enviada pelo celular aparece na conversa", () => {
  it("vira mensagem `fromMe` (outbound, do aparelho) na conversa do lead", async () => {
    const b = novoBanco();
    const r = await entregar(b, enviada("3EB0CEL1", "oi, mandei pelo celular"));
    expect(r.ok).toBe(true);
    expect(b.messages()).toHaveLength(1);
    expect(b.messages()[0]).toMatchObject({
      external_id: "3EB0CEL1",
      direction: "outbound",
      sent_via: "external_device",
      body: "oi, mandei pelo celular",
      conversation_id: "conversa-1",
    });
  });

  it("`SEND_MESSAGE` e `send.message` são o mesmo evento", () => {
    const t = traduzirEvento({ ...enviada("3EB0CEL1", "x"), event: "SEND_MESSAGE" } as EvolutionEnvelope);
    expect(t.ignorado).toBe(false);
    expect(t.envelopes).toHaveLength(1);
    expect(t.envelopes[0]!.payload?.fromMe).toBe(true);
  });

  it("send_message_nao_duplica_envio_do_crm: o que o CRM mandou casa por external_id", async () => {
    // O composer e o motor gravam a linha com o `key.id` que o envio devolveu; o eco é o mesmo id.
    const b = novoBanco({
      messages: [{ id: "m-crm", organization_id: ORG, external_id: "3EB0CRM", direction: "outbound", sent_via: "user", body: "proposta enviada" }],
    });
    await entregar(b, enviada("3EB0CRM", "proposta enviada"));
    expect(b.messages()).toHaveLength(1);
    expect(b.messages()[0]!.id).toBe("m-crm");
    // E o eco do próprio envio não é "humano no celular": a IA não é pausada.
    expect(pausarIa).not.toHaveBeenCalled();
  });

  it("SEND_MESSAGE é sempre saída: `fromMe:false` no payload não vira entrada nem acorda a IA", async () => {
    const b = novoBanco();
    const corpo = enviada("3EB0CEL2", "saiu pela API");
    (corpo.data as { key: { fromMe: boolean } }).key.fromMe = false;
    await entregar(b, corpo);
    expect(b.messages()).toHaveLength(1);
    expect(b.messages()[0]).toMatchObject({ direction: "outbound", sent_via: "external_device" });
    expect(efeitosPosEntrada).not.toHaveBeenCalled();
    for (const chamada of atenderEntradas.mock.calls) {
      const envelopes = chamada[2] as Array<{ payload?: { fromMe?: boolean } }>;
      expect(envelopes.every((e) => e.payload?.fromMe === true)).toBe(true);
    }
  });

  it("reentrega do mesmo SEND_MESSAGE não duplica", async () => {
    const b = novoBanco();
    await entregar(b, enviada("3EB0CEL1", "oi"));
    await entregar(b, enviada("3EB0CEL1", "oi"));
    expect(b.messages()).toHaveLength(1);
  });
});

// ─── CALL ──────────────────────────────────────────────────────────────────────

describe("CALL: ligação vira nota de tela, nunca mensagem", () => {
  it("ligacao_e_linha_system: recebida às HH:MM (fuso de São Paulo)", async () => {
    const b = novoBanco();
    const r = await entregar(b, ligacao("offer"));
    expect(r.ok).toBe(true);
    expect(b.messages()).toHaveLength(1);
    const l = b.messages()[0]!;
    expect(l).toMatchObject({
      type: "system",
      sent_via: "system",
      body: "Ligação recebida às 14:05",
      external_id: "ligacao:CALL-1",
      conversation_id: "conversa-1",
      contact_id: "contato-1",
    });
    // Nota de tela: nunca entra como mensagem do lead (não conta como resposta).
    expect(l.direction).not.toBe("inbound");
  });

  it("a mesma ligação não vira duas linhas: tocou e ninguém atendeu = perdida", async () => {
    const b = novoBanco();
    await entregar(b, ligacao("offer"));
    await entregar(b, ligacao("timeout"));
    expect(b.messages()).toHaveLength(1);
    expect(b.messages()[0]!.body).toBe("Ligação perdida às 14:05");
  });

  it("atendida e encerrada continua recebida", async () => {
    const b = novoBanco();
    await entregar(b, ligacao("offer"));
    await entregar(b, ligacao("accept"));
    await entregar(b, ligacao("terminate"));
    expect(b.messages()).toHaveLength(1);
    expect(b.messages()[0]!.body).toBe("Ligação recebida às 14:05");
  });

  it("ligação feita pelo próprio número: 'Ligação feita'", async () => {
    const b = novoBanco();
    await entregar(b, ligacao("offer", { from: "5581988887777@s.whatsapp.net" }));
    expect(b.messages()[0]!.body).toBe("Ligação feita às 14:05");
  });

  it.each([
    ["cadastro sem o 9, ligação com o 9", "+558188887777", "5581988887777@s.whatsapp.net"],
    ["cadastro com o 9, ligação sem o 9", "+5581988887777", "558188887777@s.whatsapp.net"],
  ])("número próprio é reconhecido com e sem o nono dígito (%s)", async (_nome, cadastro, from) => {
    const b = banco({ channel_sessions: [{ ...SESSAO, phone_number: cadastro }] });
    await entregar(b, ligacao("offer", { from }));
    expect(b.messages()[0]!.body).toBe("Ligação feita às 14:05");
  });

  it("regra pura do desfecho e do texto", () => {
    expect(desfechoDaLigacao(["offer"], false)).toBe("recebida");
    expect(desfechoDaLigacao(["offer", "reject"], false)).toBe("perdida");
    expect(desfechoDaLigacao(["offer", "terminate"], false)).toBe("perdida");
    expect(desfechoDaLigacao(["offer", "accept", "terminate"], false)).toBe("recebida");
    expect(desfechoDaLigacao(["offer", "timeout"], true)).toBe("feita");
    expect(textoDaLigacao("perdida", new Date("2026-11-13T02:30:00.000Z"))).toBe("Ligação perdida às 23:30");
  });
});

// ─── MESSAGES_UPDATE com edição ───────────────────────────────────────────────

describe("MESSAGES_UPDATE com edição: o texto muda e a linha fica marcada", () => {
  it("tradução: vira `message.edited` apontando a mensagem ORIGINAL", () => {
    const t = traduzirEvento(edicaoPorUpdate("3EB0ORIG", "texto novo") as EvolutionEnvelope);
    expect(t.envelopes).toEqual([
      { event: "message.edited", session: "chip-01", payload: { id: "3EB0ORIG", editedMessageId: "3EB0ORIG", body: "texto novo" } },
    ]);
  });

  it("atualiza o texto e marca `metadata.editada`, sem perder o resto do metadata", async () => {
    const b = novoBanco({ messages: [linhaDoLead()] });
    await entregar(b, edicaoPorUpdate("3EB0ORIG", "texto novo"));
    const l = b.messages()[0]!;
    expect(l.body).toBe("texto novo");
    expect(l.edited_at).toBeTruthy();
    expect(l.metadata).toEqual({ raw_type: "chat", editada: true });
    expect(b.messages()).toHaveLength(1);
  });

  it("a edição que chega como protocolo no `messages.upsert` tem o mesmo desfecho", async () => {
    const b = novoBanco({ messages: [linhaDoLead()] });
    await entregar(
      b,
      evento("messages.upsert", {
        key: { remoteJid: LEAD, fromMe: false, id: "3EB0EVT" },
        message: protocoloDeEdicao("3EB0ORIG", "corrigido"),
        messageType: "editedMessage",
        messageTimestamp: 1_763_053_600,
      }),
    );
    expect(b.messages()).toHaveLength(1);
    expect(b.messages()[0]).toMatchObject({ body: "corrigido", metadata: { raw_type: "chat", editada: true } });
  });

  it("status de entrega segue como antes (o caminho da edição não engole o ack)", () => {
    const t = traduzirEvento(evento("messages.update", { keyId: "3EB0X", remoteJid: LEAD, fromMe: true, status: "READ" }) as EvolutionEnvelope);
    expect(t.envelopes).toEqual([{ event: "message.ack", session: "chip-01", payload: { id: "3EB0X", ack: 3 } }]);
  });
});

// ─── MESSAGES_DELETE ───────────────────────────────────────────────────────────

describe("MESSAGES_DELETE: marca apagada e mantém o texto", () => {
  it("marca `metadata.apagada` e `revoked_at`; o corpo fica para o operador", async () => {
    const b = novoBanco({ messages: [linhaDoLead()] });
    await entregar(b, exclusao("3EB0ORIG"));
    const l = b.messages()[0]!;
    expect(l.revoked_at).toBeTruthy();
    expect(l.metadata).toEqual({ raw_type: "chat", apagada: true });
    expect(l.body).toBe("texto velho");
    expect(b.messages()).toHaveLength(1);
  });

  it.each([
    ["edição", edicaoPorUpdate("3EB0ORIG", "texto novo")],
    ["exclusão", exclusao("3EB0ORIG")],
  ])("%s não toca o mesmo external_id de outra organização nem de outra conexão", async (_nome, corpo) => {
    const outraOrg = linhaDoLead({ id: "m-outra-org", organization_id: "org-2", channel_session_id: "sessao-9" });
    const outraConexao = linhaDoLead({ id: "m-outra-conexao", channel_session_id: "sessao-2", conversation_id: "conversa-2" });
    const b = novoBanco({ messages: [linhaDoLead(), outraOrg, outraConexao] });
    await entregar(b, corpo);
    const porId = Object.fromEntries(b.messages().map((m) => [m.id, m]));
    expect(porId["m-orig"]!.metadata).not.toEqual({ raw_type: "chat" });
    for (const id of ["m-outra-org", "m-outra-conexao"]) {
      expect(porId[id]).toMatchObject({ body: "texto velho", metadata: { raw_type: "chat" } });
      expect(porId[id]!.edited_at).toBeUndefined();
      expect(porId[id]!.revoked_at).toBeUndefined();
    }
  });

  it("exclusão de mensagem desconhecida não inventa linha", async () => {
    const b = novoBanco();
    await entregar(b, exclusao("NAO-EXISTE"));
    expect(b.messages()).toHaveLength(0);
  });
});

// ─── Grupo ─────────────────────────────────────────────────────────────────────

describe("grupo_continua_descartado_nos_eventos_novos", () => {
  const soDeGrupo = [
    ["send.message", enviada("G1", "no grupo", GRUPO)],
    ["call (chatId de grupo)", ligacao("offer", { chatId: GRUPO, isGroup: true, groupJid: GRUPO })],
    ["call (só isGroup, sem @g.us no corpo)", ligacao("offer", { isGroup: true })],
    ["messages.update com edição", edicaoPorUpdate("G2", "editado no grupo", GRUPO)],
    ["messages.delete", exclusao("G3", GRUPO)],
    ["messages.edited", evento("messages.edited", { key: { remoteJid: GRUPO, id: "G4" }, type: 14, editedMessage: { conversation: "x" } })],
  ] as const;

  it.each(soDeGrupo)("%s: lote só de grupo é descartado na ENTRADA (antes de qualquer escrita)", (_nome, corpo) => {
    expect(webhookSoDeChatSemContato(JSON.stringify(corpo))).toBe(true);
  });

  it.each(soDeGrupo)("%s: mesmo se chegar à tradução, nada sai dela", (_nome, corpo) => {
    const t = traduzirEvento(corpo as EvolutionEnvelope);
    expect(t.envelopes).toEqual([]);
    expect(t.ligacoes).toEqual([]);
  });

  it("lote misto: o item de grupo sai do corpo arquivado; o individual fica", () => {
    const misto = evento("call", [
      { chatId: GRUPO, from: LEAD, id: "CG", status: "offer", isGroup: true, groupJid: GRUPO },
      { chatId: LEAD, from: LEAD, id: "CI", status: "offer", isGroup: false },
    ]);
    const filtrado = JSON.parse(corpoSemChatsSemContato(JSON.stringify(misto))) as { data: Array<{ id: string }> };
    expect(filtrado.data.map((d) => d.id)).toEqual(["CI"]);
    expect(JSON.stringify(filtrado)).not.toContain("@g.us");
  });

  it("ligação de grupo em lote misto não grava linha", async () => {
    const b = novoBanco();
    await entregar(
      b,
      evento("call", [
        { chatId: GRUPO, from: LEAD, id: "CG", status: "offer", isGroup: true, groupJid: GRUPO, date: "2026-11-13T17:05:00.000Z" },
      ]),
    );
    expect(b.messages()).toHaveLength(0);
    expect(b.rpcs.filter((r) => r.fn === "fn_upsert_wa_contact")).toHaveLength(0);
  });
});

// ─── Nenhum evento novo dispara IA ─────────────────────────────────────────────

describe("evento_novo_nao_dispara_ia", () => {
  const casos = [
    ["SEND_MESSAGE", enviada("3EB0CEL9", "mandei do celular")],
    ["CALL", ligacao("offer")],
    ["MESSAGES_UPDATE (edição)", edicaoPorUpdate("3EB0ORIG", "novo")],
    ["MESSAGES_DELETE", exclusao("3EB0ORIG")],
  ] as const;

  it.each(casos)("%s não chama IA, atendimento do motor nem grava mensagem de entrada", async (_nome, corpo) => {
    const b = novoBanco({ messages: [linhaDoLead()] });
    await entregar(b, corpo);
    expect(efeitosPosEntrada).not.toHaveBeenCalled();
    // O gancho do motor recebe o lote, mas nenhum item é "mensagem do lead" (é o filtro dele).
    for (const chamada of atenderEntradas.mock.calls) {
      const envelopes = chamada[2] as Array<{ event?: string; payload?: { fromMe?: boolean } }>;
      expect(envelopes.filter((e) => (e.event === "message" || e.event === "message.any") && e.payload?.fromMe === false)).toEqual([]);
    }
    // Só a linha do lead que já existia é de entrada.
    expect(b.messages().filter((m) => m.direction === "inbound")).toHaveLength(1);
  });

  it("ligação, edição e exclusão também não pausam a IA (não são 'humano no celular')", async () => {
    for (const corpo of [ligacao("offer"), edicaoPorUpdate("3EB0ORIG", "novo"), exclusao("3EB0ORIG")]) {
      await entregar(novoBanco({ messages: [linhaDoLead()] }), corpo);
    }
    expect(pausarIa).not.toHaveBeenCalled();
  });
});

// ─── Reconciliação: `fromMe` recuperada ────────────────────────────────────────

describe("reconciliação traz fromMe: recuperada não pausa a IA", () => {
  it("mensagem do celular recuperada entra marcada e sem efeito de 'humano assumiu'", async () => {
    const b = novoBanco();
    const t = traduzirEvento(evento("messages.upsert", { key: { remoteJid: LEAD, fromMe: true, id: "3EB0REC" }, message: { conversation: "respondi ontem" }, messageTimestamp: 1_763_000_000 }) as EvolutionEnvelope);
    await dispatchWahaEvent(b.admin as never, SESSAO as never, t.envelopes[0]!, "req", { recuperada: true });
    expect(b.messages()).toHaveLength(1);
    expect(b.messages()[0]).toMatchObject({ direction: "outbound", sent_via: "external_device", metadata: { recuperada: true } });
    expect(pausarIa).not.toHaveBeenCalled();
  });
});

// ─── Assinatura dos eventos na instância (rota de reconectar) ──────────────────

describe("assinarEventosDoWebhook: aplica a lista nas instâncias existentes, sem QR", () => {
  const creds = { baseUrl: "https://evolution.test", apiKey: "chave", instance: "chip-01", source: "session" as const };

  function evolutionFalsa(webhookAtual: unknown, falhar?: "find" | "set") {
    const chamadas: Array<{ metodo: string; caminho: string; corpo: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const caminho = new URL(String(url)).pathname;
        chamadas.push({ metodo: init?.method ?? "GET", caminho, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (falhar && caminho.includes(`/webhook/${falhar}`)) return new Response("erro interno do servidor", { status: 500 });
        if (caminho.includes("/webhook/find")) return Response.json(webhookAtual);
        return Response.json({});
      }),
    );
    return chamadas;
  }

  beforeEach(() => vi.unstubAllGlobals());

  it("a lista inclui os eventos novos e os que o CRM já consumia", () => {
    expect([...EVENTOS_DO_WEBHOOK].sort()).toEqual(
      ["CALL", "CONNECTION_UPDATE", "MESSAGES_DELETE", "MESSAGES_EDITED", "MESSAGES_UPDATE", "MESSAGES_UPSERT", "SEND_MESSAGE"].sort(),
    );
  });

  it("acrescenta os que faltam, preservando URL, cabeçalhos, formato e os eventos que já estavam", async () => {
    const chamadas = evolutionFalsa({
      url: "https://crm.test/api/v1/webhooks/evolution/tok",
      enabled: true,
      headers: { "x-extra": "1" },
      webhookByEvents: false,
      webhookBase64: false,
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    });
    expect(await assinarEventosDoWebhook(creds)).toBeNull();
    const set = chamadas.find((c) => c.caminho === "/webhook/set/chip-01");
    expect(set?.metodo).toBe("POST");
    const w = (set!.corpo as { webhook: Record<string, unknown> }).webhook;
    expect(w).toMatchObject({ url: "https://crm.test/api/v1/webhooks/evolution/tok", enabled: true, headers: { "x-extra": "1" }, byEvents: false, base64: false });
    expect([...(w.events as string[])].sort()).toEqual(
      ["CALL", "CONNECTION_UPDATE", "MESSAGES_DELETE", "MESSAGES_EDITED", "MESSAGES_UPDATE", "MESSAGES_UPSERT", "QRCODE_UPDATED", "SEND_MESSAGE"].sort(),
    );
  });

  it("já assinado por completo: não escreve nada", async () => {
    const chamadas = evolutionFalsa({ url: "https://crm.test/x", enabled: true, events: [...EVENTOS_DO_WEBHOOK] });
    expect(await assinarEventosDoWebhook(creds)).toBeNull();
    expect(chamadas.map((c) => c.caminho)).toEqual(["/webhook/find/chip-01"]);
  });

  it("sem webhook cadastrado: avisa e não inventa URL", async () => {
    const chamadas = evolutionFalsa(null);
    expect(await assinarEventosDoWebhook(creds)).toMatch(/webhook/i);
    expect(chamadas.some((c) => c.caminho.includes("/webhook/set"))).toBe(false);
  });

  it.each(["find", "set"] as const)("falha em webhook/%s vira aviso, sem vazar o corpo do servidor", async (falha) => {
    evolutionFalsa({ url: "https://crm.test/x", enabled: true, events: ["MESSAGES_UPSERT"] }, falha);
    const aviso = await assinarEventosDoWebhook(creds);
    expect(aviso).toMatch(/eventos/i);
    expect(aviso).not.toContain("erro interno");
  });
});
