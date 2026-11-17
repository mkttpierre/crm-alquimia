/**
 * Quarentena e frequência por lead (PLANO-DISPAROS 5.4), como funções puras.
 *
 *   - quem recebeu todos os toques sem responder fica `quarentena.dias` (45) sem ser aberto de novo;
 *   - no máximo 1 abordagem fria (abertura) por lead a cada `diasEntreAbordagens` (30);
 *   - no máximo `maxSemRespostaMes` (3) mensagens do motor sem resposta dentro dessa mesma janela;
 *   - respondeu = sai da cadência (o motor já cancela os pendentes quando o lead escreve);
 *   - opt-out e parada continuam permanentes e valem antes de tudo (`motivoParaNaoContatar`, `contacts.is_blocked`).
 *
 * Quem consulta o banco é `repositorio-supabase.ts`; quem aplica é `motor.ts` (seleção da abertura e
 * cada toque). `ligado: false` desliga as três regras, e a organização volta a se comportar como antes.
 */
import type { Ritmo } from "./config";
import { MIN } from "./ritmo";

export type ConfigDeQuarentena = Ritmo["quarentena"];

const DIA = 24 * 60 * MIN;

export type SituacaoDoLead = {
  /** `disparo_quarentena.ate` do lead (null = nunca entrou). */
  quarentenaAte: Date | null;
  /** Quando saiu a última abertura (abordagem fria) para o lead, de qualquer chip. */
  ultimaAbordagemEm: Date | null;
  /** Mensagens do motor que saíram nos últimos `diasEntreAbordagens` dias, depois da última resposta do lead. */
  semRespostaNoMes: number;
};

export type PodeAbordar = { ok: true } | { ok: false; motivo: string };

/** Fim da quarentena de quem acabou de receber o último toque sem responder. */
export const fimDaQuarentena = (agora: Date, cfg: ConfigDeQuarentena) => new Date(agora.getTime() + cfg.dias * DIA);

/** O lead pode receber uma NOVA abordagem fria (abertura) agora? */
export function podeAbordar(s: SituacaoDoLead, cfg: ConfigDeQuarentena, agora: Date): PodeAbordar {
  if (!cfg.ligado) return { ok: true };
  if (s.quarentenaAte && s.quarentenaAte.getTime() > agora.getTime()) {
    return { ok: false, motivo: `lead em quarentena até ${s.quarentenaAte.toISOString().slice(0, 10)}` };
  }
  if (s.ultimaAbordagemEm && agora.getTime() - s.ultimaAbordagemEm.getTime() < cfg.diasEntreAbordagens * DIA) {
    return { ok: false, motivo: `já recebeu uma abordagem fria nos últimos ${cfg.diasEntreAbordagens} dias` };
  }
  if (s.semRespostaNoMes >= cfg.maxSemRespostaMes) {
    return { ok: false, motivo: `${s.semRespostaNoMes} mensagens sem resposta nos últimos ${cfg.diasEntreAbordagens} dias` };
  }
  return { ok: true };
}

/** Pode sair mais UMA mensagem do motor (toque) para quem ainda não respondeu? */
export function podeTocar(semRespostaNoMes: number, cfg: ConfigDeQuarentena): PodeAbordar {
  if (!cfg.ligado || semRespostaNoMes < cfg.maxSemRespostaMes) return { ok: true };
  return { ok: false, motivo: `limite de ${cfg.maxSemRespostaMes} mensagens sem resposta em ${cfg.diasEntreAbordagens} dias` };
}
