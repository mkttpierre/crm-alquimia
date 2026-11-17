import { comandoDaConversa } from "./comando-da-conversa";

export type EstadoDaConversa = "nao_iniciados" | "em_espera" | "em_atendimento" | "bot" | "finalizados";

export type FatosDoEstado = {
  status: string;
  assigned_to_user_id: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  bot_silenced_until?: string | null;
  contacts?: { force_human?: boolean | null; is_blocked?: boolean | null } | null;
};

/**
 * Aba do multiatendimento. Prioridade: Finalizados > Bot > Não iniciados > Em espera > Em atendimento.
 *
 * "Bot" pergunta QUEM MANDA (`comandoDaConversa`), nunca o status: `ai_handling`
 * só é escrito pelo botão "Devolver ao automático" e não descreve o comando
 * (cerca em `tests/unit/fila-tem-uma-definicao-so.test.ts`).
 * `automaticoDaOrg` undefined = "não sei", tratado como há automático (mesma regra do comando).
 */
export function estadoDaConversa(conversa: FatosDoEstado, automaticoDaOrg?: boolean): EstadoDaConversa {
  if (conversa.status === "closed") return "finalizados";
  const { comando } = comandoDaConversa({
    status: conversa.status,
    automaticoDaOrg,
    assigned_to_user_id: conversa.assigned_to_user_id,
    bot_silenced_until: conversa.bot_silenced_until ?? null,
    force_human: conversa.contacts?.force_human ?? null,
    is_blocked: conversa.contacts?.is_blocked ?? null,
  });
  if (comando.quem === "encerrada") return "finalizados";
  if (comando.quem === "automatico") return "bot";
  if (!conversa.assigned_to_user_id && !conversa.last_outbound_at) return "nao_iniciados";
  if (conversa.last_outbound_at && (!conversa.last_inbound_at || Date.parse(conversa.last_outbound_at) > Date.parse(conversa.last_inbound_at))) return "em_espera";
  return "em_atendimento";
}
