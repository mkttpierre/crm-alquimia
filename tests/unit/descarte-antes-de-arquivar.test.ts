import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GRUPO, STATUS E CANAL NÃO PODEM CUSTAR UMA ESCRITA.
 *
 * Medido em 26/10/2026: 11.806 de 11.811 eventos de mensagem do canal Evolution
 * eram de grupo, e cada um era gravado em `webhook_events_log` (2,16 GB, 97% do
 * banco) para ser descartado logo depois pela ingestão. O descarte tem que vir
 * ANTES da escrita — mas sem tocar no que a saúde do chip lê: `connection.update`
 * e o status de entrega de mensagem individual.
 *
 * Segundo defeito no mesmo caminho: a rota decifrava o segredo da sessão em todo
 * webhook ("Wrong key or corrupt data"), embora só a Zernio confira assinatura.
 */

const SESSAO = {
  id: "sess-1",
  organization_id: "org-1",
  provider: "evolution",
  display_name: "Chip",
  phone_number: null,
  webhook_secret_encrypted: "\xabcd",
  archived_at: null as string | null,
};

const abertos: unknown[] = [];
const decifrados: unknown[] = [];
const ingeridos: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({ data: SESSAO, error: null }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async (_a: unknown, c: unknown) => {
    decifrados.push(c);
    return "segredo-longo-o-suficiente";
  },
}));
vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  abrirArquivoDoWebhook: async (_a: unknown, e: unknown) => {
    abertos.push(e);
    return "arquivo-1";
  },
  fecharArquivoDoWebhook: async () => {},
}));
vi.mock("@/lib/channels/evolution/ingest", () => ({
  ingestEvolutionInbound: async (_a: unknown, i: unknown) => {
    ingeridos.push(i);
    return { ok: true, body: { status: "processed" } };
  },
}));

import { POST } from "@/app/api/v1/webhooks/channel/[token]/route";
import { descartarAntesDeArquivar } from "@/lib/channels/inbound";

const upsert = (jid: string, extra: Record<string, unknown> = {}) => ({
  event: "messages.upsert",
  instance: "chip-01",
  data: { key: { remoteJid: jid, fromMe: false, id: "A1" }, message: { conversation: "oi" }, ...extra },
});
const INDIVIDUAL = "5581999990000@s.whatsapp.net";

const pedido = (corpo: unknown) =>
  ({ text: async () => (typeof corpo === "string" ? corpo : JSON.stringify(corpo)), headers: new Headers() }) as never;
const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

beforeEach(() => {
  abertos.length = 0;
  decifrados.length = 0;
  ingeridos.length = 0;
  SESSAO.provider = "evolution";
});

describe("descartarAntesDeArquivar (Evolution)", () => {
  it("grupo, status e canal são descartados", () => {
    for (const jid of ["120363@g.us", "status@broadcast", "1203@newsletter", "5511@broadcast"]) {
      expect(descartarAntesDeArquivar("evolution", JSON.stringify(upsert(jid))), jid).toBe("chat_sem_contato");
    }
  });

  it("mensagem individual (phone e @lid) NÃO é descartada", () => {
    for (const jid of [INDIVIDUAL, "5581999990000@c.us", "98765@lid"]) {
      expect(descartarAntesDeArquivar("evolution", JSON.stringify(upsert(jid))), jid).toBeNull();
    }
  });

  it("lote misto não é descartado: só se TODOS os itens forem sem contato", () => {
    const misto = { ...upsert(INDIVIDUAL), data: [upsert("1@g.us").data, upsert(INDIVIDUAL).data] };
    const soGrupo = { ...upsert(INDIVIDUAL), data: [upsert("1@g.us").data, upsert("2@g.us").data] };
    expect(descartarAntesDeArquivar("evolution", JSON.stringify(misto))).toBeNull();
    expect(descartarAntesDeArquivar("evolution", JSON.stringify(soGrupo))).toBe("chat_sem_contato");
  });

  it("connection.update e QR nunca são descartados, mesmo citando um grupo", () => {
    for (const event of ["connection.update", "qrcode.updated", "logout.instance"]) {
      const corpo = { event, instance: "chip-01", data: { state: "close", nota: "x@g.us" } };
      expect(descartarAntesDeArquivar("evolution", JSON.stringify(corpo)), event).toBeNull();
    }
  });

  it("status de entrega: descarta o de grupo, mantém o de chat individual", () => {
    const upd = (remoteJid: string) => ({
      event: "messages.update",
      instance: "chip-01",
      data: { keyId: "A1", remoteJid, fromMe: true, status: "READ" },
    });
    expect(descartarAntesDeArquivar("evolution", JSON.stringify(upd("1@g.us")))).toBe("chat_sem_contato");
    expect(descartarAntesDeArquivar("evolution", JSON.stringify(upd(INDIVIDUAL)))).toBeNull();
  });

  it("corpo ilegível ou fora de forma segue o caminho normal (que o arquiva)", () => {
    for (const cru of ["{nao e json", "[1,2]", "null", JSON.stringify({ event: "messages.upsert", instance: "i" })]) {
      expect(descartarAntesDeArquivar("evolution", cru), cru).toBeNull();
    }
  });

  it("outros provedores nunca são descartados aqui", () => {
    expect(descartarAntesDeArquivar("zernio", JSON.stringify(upsert("1@g.us")))).toBeNull();
  });
});

describe("a rota", () => {
  it("mensagem de grupo: 200 ignorado, nada arquivado, nada decifrado, nada ingerido", async () => {
    const res = await POST(pedido(upsert("120363@g.us")), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "ignored", reason: "chat_sem_contato" } });
    expect(abertos).toHaveLength(0);
    expect(decifrados).toHaveLength(0);
    expect(ingeridos).toHaveLength(0);
  });

  it("mensagem individual: arquivada e ingerida como antes", async () => {
    const res = await POST(pedido(upsert(INDIVIDUAL)), ctx);
    expect(res.status).toBe(200);
    expect(abertos).toHaveLength(1);
    expect(ingeridos).toHaveLength(1);
  });

  it("connection.update continua arquivado e ingerido", async () => {
    await POST(pedido({ event: "connection.update", instance: "chip-01", data: { state: "close" } }), ctx);
    expect(abertos).toHaveLength(1);
    expect(ingeridos).toHaveLength(1);
  });
});

describe("lote misto: grupo nunca é gravado (REGRA ABSOLUTA)", () => {
  const SEGREDO_DO_GRUPO = "SEGREDO-DO-GRUPO-participante-9999";
  const doGrupo = { key: { remoteJid: "120363@g.us", participant: "5599@s.whatsapp.net", fromMe: false, id: "G1" }, pushName: SEGREDO_DO_GRUPO, message: { conversation: SEGREDO_DO_GRUPO } };
  const individual = { key: { remoteJid: INDIVIDUAL, fromMe: false, id: "P1" }, message: { conversation: "oi privado" } };

  it("messages.upsert misto: arquivo e ingestão recebem só o item privado", async () => {
    const res = await POST(pedido({ event: "messages.upsert", instance: "chip-01", data: [doGrupo, individual] }), ctx);
    expect(res.status).toBe(200);
    expect(abertos).toHaveLength(1);
    expect(ingeridos).toHaveLength(1);
    const arquivado = (abertos[0] as { rawBody: string }).rawBody;
    const ingerido = (ingeridos[0] as { rawBody: string }).rawBody;
    for (const corpo of [arquivado, ingerido]) {
      expect(corpo).not.toContain("@g.us");
      expect(corpo).not.toContain(SEGREDO_DO_GRUPO);
      expect(corpo).toContain("oi privado");
    }
  });

  it("messages.update (recibos) misto: o recibo do grupo não chega ao arquivo", async () => {
    const rec = (remoteJid: string, keyId: string) => ({ keyId, remoteJid, fromMe: true, status: "READ" });
    await POST(pedido({ event: "messages.update", instance: "chip-01", data: [rec("120363@g.us", "G9"), rec(INDIVIDUAL, "P9")] }), ctx);
    const arquivado = (abertos[0] as { rawBody: string }).rawBody;
    expect(arquivado).not.toContain("@g.us");
    expect(arquivado).not.toContain("G9");
    expect(arquivado).toContain("P9");
    expect((ingeridos[0] as { rawBody: string }).rawBody).not.toContain("G9");
  });

  it("lote sem grupo segue byte a byte como chegou", async () => {
    const cru = JSON.stringify({ event: "messages.upsert", instance: "chip-01", data: [individual] });
    await POST(pedido(cru), ctx);
    expect((abertos[0] as { rawBody: string }).rawBody).toBe(cru);
    expect((ingeridos[0] as { rawBody: string }).rawBody).toBe(cru);
  });

  it("a tradução também ignora grupo num lote misto (defesa em profundidade)", async () => {
    const { traduzirEvento } = await import("@/lib/channels/evolution/webhook");
    const r = traduzirEvento({ event: "messages.upsert", instance: "chip-01", data: [doGrupo, individual] });
    expect(r.envelopes).toHaveLength(1);
    expect(JSON.stringify(r.envelopes)).not.toContain("@g.us");
  });
});

describe("o segredo só é decifrado para quem confere assinatura", () => {
  it("Evolution (o token do caminho é a credencial): não decifra", async () => {
    await POST(pedido(upsert(INDIVIDUAL)), ctx);
    expect(decifrados).toHaveLength(0);
  });

  it("Zernio: decifra, porque verifica a assinatura", async () => {
    SESSAO.provider = "zernio";
    await POST(pedido({ event: "x" }), ctx);
    expect(decifrados).toHaveLength(1);
  });
});
