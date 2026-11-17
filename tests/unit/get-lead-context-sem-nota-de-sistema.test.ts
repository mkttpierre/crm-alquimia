import { describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * Nota de tela (`messages.type = 'system'`) não é fala de ninguém.
 *
 * A nota de ligação ("Ligação do D10…") é gravada com `direction = 'outbound'`, e o histórico do turno
 * transforma toda `outbound` em fala do assistente. Sem o filtro, o agente lia a instrução ao operador como
 * algo que ELE mesmo disse ao lead. O dublê aplica o filtro só quando o SQL o pede: é a consulta que tem de
 * excluir a nota, não o dublê.
 */
const HISTORICO = [
  { direction: "inbound", type: "text", body: "Oi, quero saber o preço", sent_at: new Date("2026-11-13T12:00:00Z") },
  { direction: "outbound", type: "system", body: "Ligação do D10: ligar para o lead", sent_at: new Date("2026-11-13T12:01:00Z") },
  { direction: "outbound", type: "text", body: "Claro! Te mando agora.", sent_at: new Date("2026-11-13T12:02:00Z") },
].map((m) => ({ media_url: null, media_storage_path: null, media_mime: null, media_derived_text: null, ...m }));

function dbFalso() {
  const consultas: string[] = [];
  return {
    consultas,
    db: {
      query: async (sql: string) => {
        consultas.push(sql);
        if (sql.includes("from contacts")) {
          return {
            rows: [
              {
                name: "Carlos",
                display_name: null,
                email: null,
                phone_number: "+5511900000000",
                tags: [],
                is_blocked: false,
                source: "whatsapp",
                consent: null,
                is_anonymized: false,
              },
            ],
          };
        }
        if (sql.includes("from messages")) {
          const filtra = /type\s*<>\s*'system'/.test(sql);
          // A consulta real ordena desc e o código inverte: devolve do mais novo ao mais antigo.
          return { rows: HISTORICO.filter((m) => !filtra || m.type !== "system").slice().reverse() };
        }
        return { rows: [] };
      },
    },
  };
}

const KNOBS = { historyLimit: 20, maxTokens: 10_000 };
const ENTRADA = { tenantId: "org-1", leadId: "contato-1", conversationId: "conv-1", fuso: "America/Sao_Paulo" };

describe("histórico do turno sem a nota de sistema", () => {
  it("a nota de ligação (type=system, outbound) não entra como fala do assistente", async () => {
    const { db } = dbFalso();
    const r = await getLeadContext(db as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto falhou");
    expect(r.context.messages.map((m) => m.body)).toEqual(["Oi, quero saber o preço", "Claro! Te mando agora."]);
    expect(r.context.messages.some((m) => m.body.includes("Ligação do D10"))).toBe(false);
  });
});
