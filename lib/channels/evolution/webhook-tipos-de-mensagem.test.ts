/**
 * MENSAGEM DE CONVERSA INDIVIDUAL NÃO SOME POR SER DE UM TIPO QUE NÃO LEMOS.
 *
 * Medido em produção (10/11/2026): 3 `templateMessage` recebidos sumiram. A
 * tradução não achava texto, a ingestão descartava "sem texto e sem mídia" e o
 * evento era arquivado como `processed` — o pior jeito de perder, porque nada
 * reclama.
 *
 * Duas metades: (1) os tipos que o lead lê ou escolhe viram o texto visível;
 * (2) o tipo que continua desconhecido entra com um texto fixo e deixa log.
 * E o controle: envelope técnico (protocolo, chave de grupo, reação…) segue
 * fora — virar bolha de conversa seria ruído, não mensagem.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => {}) }));

import { traduzirEvento, type EvolutionEnvelope } from "@/lib/channels/evolution/webhook";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

const upsert = (data: unknown) => ({ event: "messages.upsert", instance: "chip-01", data }) as EvolutionEnvelope;
const item = (message: unknown, fromMe = false) => ({
  key: { remoteJid: "5581999990000@s.whatsapp.net", fromMe, id: "3EB0AAA" },
  pushName: "Maria",
  messageTimestamp: 1_760_000_000,
  message,
});
const corpo = (message: unknown, fromMe = false) =>
  traduzirEvento(upsert(item(message, fromMe))).envelopes[0]?.payload?.body ?? null;

beforeEach(() => warn.mockClear());

describe("tipos que o lead lê ou escolhe viram o texto visível", () => {
  it("templateMessage (hydratedTemplate): título, conteúdo e rodapé", () => {
    const b = corpo({
      templateMessage: {
        hydratedTemplate: {
          hydratedTitleText: "Pedido 123",
          hydratedContentText: "Seu pedido saiu para entrega",
          hydratedFooterText: "Loja X",
        },
      },
    });
    expect(b).toContain("Pedido 123");
    expect(b).toContain("Seu pedido saiu para entrega");
    expect(b).toContain("Loja X");
  });

  it("templateMessage (hydratedFourRowTemplate)", () => {
    expect(
      corpo({ templateMessage: { hydratedFourRowTemplate: { hydratedContentText: "Confirma o horário?" } } }),
    ).toBe("Confirma o horário?");
  });

  it("templateMessage (interactiveMessageTemplate)", () => {
    expect(
      corpo({ templateMessage: { interactiveMessageTemplate: { body: { text: "Escolha uma opção" } } } }),
    ).toBe("Escolha uma opção");
  });

  it("templateButtonReplyMessage: o botão que o lead tocou", () => {
    expect(corpo({ templateButtonReplyMessage: { selectedId: "b1", selectedDisplayText: "Quero comprar" } })).toBe(
      "Quero comprar",
    );
  });

  it("buttonsResponseMessage e listResponseMessage continuam lidos", () => {
    expect(corpo({ buttonsResponseMessage: { selectedButtonId: "1", selectedDisplayText: "Sim" } })).toBe("Sim");
    expect(corpo({ listResponseMessage: { title: "Kit 3", singleSelectReply: { selectedRowId: "r3" } } })).toBe(
      "Kit 3",
    );
    expect(corpo({ listResponseMessage: { description: "Kit com 3 unidades" } })).toBe("Kit com 3 unidades");
  });

  it("interactiveResponseMessage: o texto da resposta", () => {
    expect(
      corpo({
        interactiveResponseMessage: {
          body: { text: "Agendar visita" },
          nativeFlowResponseMessage: { name: "x", paramsJson: "{}" },
        },
      }),
    ).toBe("Agendar visita");
  });

  it("interactiveMessage: cabeçalho e corpo", () => {
    const b = corpo({ interactiveMessage: { header: { title: "Oferta" }, body: { text: "Só hoje" } } });
    expect(b).toContain("Oferta");
    expect(b).toContain("Só hoje");
  });

  it.each(["pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3"])(
    "%s: a pergunta e as opções",
    (tipo) => {
      const b = corpo({ [tipo]: { name: "Qual sabor?", options: [{ optionName: "Uva" }, { optionName: "Limão" }] } });
      expect(b).toContain("[Enquete]");
      expect(b).toContain("Qual sabor?");
      expect(b).toContain("Uva");
      expect(b).toContain("Limão");
    },
  );

  it("contactsArrayMessage: nome e telefone de cada cartão", () => {
    const vcard = (n: string, t: string) => `BEGIN:VCARD\nVERSION:3.0\nFN:${n}\nTEL;type=CELL:${t}\nEND:VCARD`;
    const b = corpo({
      contactsArrayMessage: {
        displayName: "2 contatos",
        contacts: [
          { displayName: "Ana", vcard: vcard("Ana", "+55 81 99999-0001") },
          { displayName: "Bia", vcard: vcard("Bia", "+55 81 99999-0002") },
        ],
      },
    });
    expect(b).toContain("[Contatos]");
    expect(b).toContain("Ana");
    expect(b).toContain("Bia");
    expect(b?.replace(/\D/g, "")).toContain("999990002");
  });

  it("contactMessage NÃO é reescrito: o vCard cru segue para a ingestão (a tela o desenha como cartão)", () => {
    const t = traduzirEvento(upsert(item({ contactMessage: { displayName: "Ana", vcard: "BEGIN:VCARD\nFN:Ana\nEND:VCARD" } })));
    expect(t.envelopes[0]!.payload?.body).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("tipo desconhecido em conversa individual entra com texto fixo e log", () => {
  it("vira '[mensagem de tipo não suportado: <tipo>]'", () => {
    expect(corpo({ eventMessage: { name: "Aniversário" }, messageContextInfo: {} })).toBe(
      "[mensagem de tipo não suportado: eventMessage]",
    );
  });

  it("e deixa log com o tipo (sem o conteúdo)", () => {
    corpo({ eventMessage: { name: "Aniversário secreto" } });
    expect(warn).toHaveBeenCalledTimes(1);
    const [, campos] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(campos.tipo).toBe("eventMessage");
    expect(JSON.stringify(campos)).not.toContain("Aniversário");
  });

  it("templateMessage sem nenhum texto legível também não some", () => {
    expect(corpo({ templateMessage: { fourRowTemplate: {} } })).toBe(
      "[mensagem de tipo não suportado: templateMessage]",
    );
  });

  it("a ingestão GRAVA a mensagem de template (antes, descartava sem texto e sem mídia)", async () => {
    const inseridas: Array<Record<string, unknown>> = [];
    const consulta = (): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "maybeSingle") return async () => ({ data: null, error: null });
            if (prop === "then") return (r: (v: unknown) => void) => r({ data: [], error: null });
            return () => consulta();
          },
        },
      );
    const admin = {
      from: () => ({
        select: () => consulta(),
        update: () => consulta(),
        insert: (linha: Record<string, unknown>) => ({
          select: () => ({
            maybeSingle: async () => {
              inseridas.push(linha);
              return { data: { id: "msg-1" }, error: null };
            },
          }),
        }),
      }),
      rpc: async (fn: string) => {
        if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
        if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
        return { data: null, error: null };
      },
    };
    const envelope = traduzirEvento(
      upsert(item({ templateMessage: { hydratedTemplate: { hydratedContentText: "Seu código é 1234" } } })),
    ).envelopes[0]!;

    await dispatchWahaEvent(admin as never, { id: "sessao-1", organization_id: "org-1" } as never, envelope, "req-1");

    expect(inseridas, "o template sumiu na ingestão").toHaveLength(1);
    expect(inseridas[0]!.body).toBe("Seu código é 1234");
  });
});

describe("envelopes técnicos seguem fora (não são mensagem de ninguém)", () => {
  it.each([
    ["protocolMessage", { protocolMessage: { type: 0, key: { id: "X" } } }],
    ["senderKeyDistributionMessage", { senderKeyDistributionMessage: { groupId: "g" }, messageContextInfo: {} }],
    ["messageContextInfo sozinho", { messageContextInfo: { deviceListMetadata: {} } }],
    ["reactionMessage", { reactionMessage: { text: "👍", key: { id: "X" } } }],
    ["pollUpdateMessage", { pollUpdateMessage: { vote: { encPayload: "..." } } }],
    ["editedMessage", { editedMessage: { message: { protocolMessage: {} } } }],
    ["albumMessage", { albumMessage: { expectedImageCount: 2 } }],
    ["keepInChatMessage", { keepInChatMessage: { key: { id: "X" } } }],
    ["pinInChatMessage", { pinInChatMessage: { key: { id: "X" } } }],
  ])("%s não vira texto", (_nome, message) => {
    expect(corpo(message)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("mensagem sem conteúdo nenhum (stub) não ganha texto inventado", () => {
    expect(corpo(undefined)).toBeNull();
  });

  it("tipo desconhecido VINDO DO CELULAR do operador (fromMe) não ganha texto fixo", () => {
    expect(corpo({ eventMessage: { name: "x" } }, true)).toBeNull();
  });
});
