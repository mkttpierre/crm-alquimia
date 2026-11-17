import { describe, expect, it } from "vitest";

import { semConfirmacaoDoWhatsApp } from "@/lib/inbox/sem-confirmacao";

/**
 * "Enviada" e "o WhatsApp nunca confirmou" não podem ter a mesma cara.
 *
 * Em 05/11/2026 o celular-b da organização B ficou ~4 h conectado mas sem entregar: 11 envios do
 * motor ficaram com status `sent` e `ack` nulo (a Evolution nunca mandou nem o SERVER_ACK) e
 * a tela os mostrava com o mesmo 1 tique de uma mensagem saudável.
 */

const AGORA = new Date("2026-11-05T18:00:00Z");
const minAtras = (m: number) => new Date(AGORA.getTime() - m * 60_000).toISOString();

const base = {
  direction: "outbound",
  status: "sent",
  ack: null,
  sent_via: "automation",
  metadata: {},
} as const;

describe("semConfirmacaoDoWhatsApp", () => {
  it("enviada pelo motor, sem nenhum ack e com mais de 10 min: sem confirmação", () => {
    expect(semConfirmacaoDoWhatsApp({ ...base, sent_at: minAtras(30) }, AGORA)).toBe(true);
  });

  it("recém-enviada ainda pode estar chegando: não alerta", () => {
    expect(semConfirmacaoDoWhatsApp({ ...base, sent_at: minAtras(2) }, AGORA)).toBe(false);
  });

  it("qualquer ack (mesmo o 1 tique do servidor) tira o alerta", () => {
    expect(semConfirmacaoDoWhatsApp({ ...base, ack: 1, sent_at: minAtras(30) }, AGORA)).toBe(false);
    expect(semConfirmacaoDoWhatsApp({ ...base, ack: 2, status: "delivered", sent_at: minAtras(30) }, AGORA)).toBe(false);
  });

  it("mensagem recebida nunca é alertada", () => {
    expect(semConfirmacaoDoWhatsApp({ ...base, direction: "inbound", sent_at: minAtras(30) }, AGORA)).toBe(false);
  });

  it("histórico importado do CRM antigo não tem ack e não é alertado", () => {
    expect(semConfirmacaoDoWhatsApp({ ...base, metadata: { importado: true }, sent_at: minAtras(30) }, AGORA)).toBe(false);
  });

  it("digitada no celular (external_device) não é alertada: o eco do aparelho não traz ack", () => {
    expect(semConfirmacaoDoWhatsApp({ ...base, sent_via: "external_device", sent_at: minAtras(30) }, AGORA)).toBe(false);
  });

  it("antiga (mais de 3 dias) não é alertada: o aviso é para o que ainda dá para agir", () => {
    expect(semConfirmacaoDoWhatsApp({ ...base, sent_at: minAtras(60 * 24 * 4) }, AGORA)).toBe(false);
  });

  it("falha já tem o seu próprio aviso", () => {
    expect(semConfirmacaoDoWhatsApp({ ...base, status: "failed", sent_at: minAtras(30) }, AGORA)).toBe(false);
  });
});
