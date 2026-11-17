import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { executeCallWebhook } from "@/lib/automation/actions/call-webhook";
import type { ActionCtx } from "@/lib/automation/types";

/**
 * O VALOR DE UM NEGÓCIO SIGILOSO NÃO SAI PARA O WEBHOOK DE SAÍDA.
 *
 * O `call_webhook` posta para uma URL de terceiro (n8n, planilha, CRM externo). Em negócio de `valor_sigiloso` o `value_cents`
 * é a comissão do operador: nem a projeção `lead` nem o payload do evento (`lead.won`, que antes da 0251 levava o valor)
 * podem carregá-lo. Teste com o corpo REAL que chega a um servidor HTTP de verdade.
 */

function ctxCom(lead: Record<string, unknown>, payload: Record<string, unknown>): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Automação de teste",
    requestId: "req-1",
    event: { id: "evt-1", organization_id: "org-1", event_type: "lead.won", entity_kind: "crm_lead", entity_id: "lead-1", payload, metadata: {}, consumed_by: [], attempts: 0 },
    context: { lead },
  };
}

describe("call_webhook — valor sigiloso", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function enviar(ctx: ActionCtx): Promise<string> {
    let corpo = "";
    server = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on("data", (c) => partes.push(c));
      req.on("end", () => {
        corpo = Buffer.concat(partes).toString("utf8");
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const r = await executeCallWebhook(ctx, { url: `http://127.0.0.1:${port}/hook` }, { skipUrlCheck: true });
    expect(r.status).toBe("success");
    return corpo;
  }

  it("negócio sigiloso: nem a projeção do lead nem o payload do evento levam o valor", async () => {
    const corpo = await enviar(ctxCom({ id: "lead-1", title: "Venda — Maria", status: "won", value_cents: 49371, currency: "BRL", valor_sigiloso: true }, { lead_id: "lead-1", value_cents: 49371 }));
    const env = JSON.parse(corpo) as { data: { lead: Record<string, unknown>; value_cents?: number; lead_id?: string } };
    expect(env.data.lead).not.toHaveProperty("value_cents");
    expect(env.data).not.toHaveProperty("value_cents");
    expect(env.data.lead_id).toBe("lead-1");
    expect(env.data.lead.title).toBe("Venda — Maria");
    expect(corpo).not.toContain("49371");
    expect(corpo).not.toMatch(/valor_sigiloso/);
  });

  it("negócio comum continua levando o valor (o recurso não mudou para quem não usa produto interno)", async () => {
    const corpo = await enviar(ctxCom({ id: "lead-1", title: "Comum", value_cents: 5000, currency: "BRL", valor_sigiloso: false }, { lead_id: "lead-1", value_cents: 5000 }));
    const env = JSON.parse(corpo) as { data: { lead: { value_cents: number }; value_cents: number } };
    expect(env.data.lead.value_cents).toBe(5000);
    expect(env.data.value_cents).toBe(5000);
  });
});
