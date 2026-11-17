/**
 * A mensagem que SAIU do CRM mas o WhatsApp nunca confirmou.
 *
 * Toda mensagem entregue ao servidor do WhatsApp gera um `SERVER_ACK` em ~1 s (o 1 tique). Quando
 * o chip está "conectado" mas a sessão está morta (zumbi), a Evolution aceita o envio e responde
 * 201 com o id, mas nenhum ack volta: o CRM guarda `status = sent`, `ack = null`, e a tela mostrava
 * o mesmo 1 tique de uma mensagem boa. Medido em 05/11/2026 (celular-b da organização B, 11 envios).
 *
 * Só vale para o que o motor/CRM enviou (`sent_via` diferente de `external_device`): o eco do que o
 * dono digita no celular não traz ack. E só para o recente: depois de alguns dias ninguém age mais.
 */

export const MIN_SEM_CONFIRMACAO = 10;
export const DIAS_DA_JANELA = 3;

export type MensagemParaConfirmacao = {
  direction: string;
  status: string;
  ack: number | null | undefined;
  sent_via?: string | null;
  sent_at: string;
  metadata?: Record<string, unknown> | null;
};

export function semConfirmacaoDoWhatsApp(m: MensagemParaConfirmacao, agora: Date = new Date()): boolean {
  if (m.direction !== "outbound" || m.status !== "sent") return false;
  if (m.ack !== null && m.ack !== undefined) return false;
  if (m.sent_via === "external_device") return false;
  if (m.metadata && m.metadata.importado === true) return false;
  const idadeMin = (agora.getTime() - new Date(m.sent_at).getTime()) / 60_000;
  return idadeMin > MIN_SEM_CONFIRMACAO && idadeMin <= DIAS_DA_JANELA * 24 * 60;
}
