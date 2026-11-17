/**
 * Efeitos pós-entrada de uma mensagem RECUPERADA (reconciliação de entrada: chegou horas ou dias
 * depois, sem webhook). Só o opt-out roda — é o efeito que PARA envio. Abrir demanda (o lead novo
 * dispara gatilho de etapa e automação), autorizar por campanha, acelerar o follow-up e pedir o
 * despacho do agente ficam de fora: cada um pode terminar numa mensagem enviada sozinha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const garantirLead = vi.fn(async () => ({ criado: false, motivo: "ja_existia" }));
const acelerar = vi.fn(async () => undefined);
const autorizar = vi.fn(async () => undefined);
const auditou = vi.fn(async () => undefined);
vi.mock("@/lib/leads/nascimento-do-lead", () => ({ garantirLeadDaConversa: (...a: unknown[]) => garantirLead(...(a as [])) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ acelerarPipelineDeEventos: (...a: unknown[]) => acelerar(...(a as [])) }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: (...a: unknown[]) => autorizar(...(a as [])) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditou(...(a as [])) }));

import { aplicarEfeitosPosEntrada, type EntradaDeMensagem } from "./pos-entrada";

function dublarAdmin() {
  const rpcs: string[] = [];
  const updates: Array<{ tabela: string; valores: unknown }> = [];
  const admin = {
    rpc: async (nome: string, args: { p_event_type?: string }) => {
      rpcs.push(`${nome}:${args?.p_event_type ?? ""}`);
      return { data: null, error: null };
    },
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      q.update = (valores: unknown) => {
        updates.push({ tabela, valores });
        return q;
      };
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: { metadata: { ai_gate: "allowlist" }, ai_authorized_at: null, settings: {} }, error: null });
      q.then = (r: (x: unknown) => void) => r({ data: null, error: null });
      return q;
    },
  };
  return { admin: admin as never, rpcs, updates };
}

const entrada = (texto: string, extra: Partial<EntradaDeMensagem> = {}): EntradaDeMensagem => ({
  organizationId: "org-1",
  contactId: "c-1",
  conversationId: "conv-1",
  messageId: "m-1",
  channelSessionId: "s-1",
  texto,
  nomeDoContato: "Maria",
  origem: "teste",
  ...extra,
});

beforeEach(() => {
  garantirLead.mockClear();
  acelerar.mockClear();
  autorizar.mockClear();
  auditou.mockClear();
});

describe("pós-entrada de mensagem recuperada", () => {
  it("controle: mensagem viva abre demanda, acelera e pede despacho do agente", async () => {
    const { admin, rpcs } = dublarAdmin();
    await aplicarEfeitosPosEntrada(admin, entrada("oi"));
    expect(garantirLead).toHaveBeenCalledTimes(1);
    expect(acelerar).toHaveBeenCalledTimes(1);
    expect(rpcs).toContain("emit_event:ai_agent.dispatch_requested");
  });

  it("recuperada: nem demanda, nem aceleração, nem despacho", async () => {
    const { admin, rpcs } = dublarAdmin();
    await aplicarEfeitosPosEntrada(admin, entrada("oi", { recuperada: true }));
    expect(garantirLead).not.toHaveBeenCalled();
    expect(acelerar).not.toHaveBeenCalled();
    expect(autorizar).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
  });

  it("recuperada com pedido de saída AINDA bloqueia o contato (efeito que para envio)", async () => {
    const { admin, updates } = dublarAdmin();
    await aplicarEfeitosPosEntrada(admin, entrada("pare de me mandar mensagem", { recuperada: true }));
    expect(updates).toContainEqual({
      tabela: "contacts",
      valores: expect.objectContaining({ is_blocked: true, blocked_reason: "stop_keyword" }),
    });
  });
});
