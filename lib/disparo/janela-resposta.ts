/**
 * Janela das RESPOSTAS (a automática do atendimento e a sequência do operador), todo dia, sem feriado: a mesma regra
 * de `daJanelaDeResposta` do atendimento, aqui para o MOTOR conferir de novo na hora do envio (auditoria 3, A4).
 * Antes ela só valia no planejamento: uma parte que falhou às 21h58 e voltou em +10 min, um chip pausado que voltou à
 * noite ou um `/funil-valores` pedido às 23h saíam fora de hora. Padrão 8h–22h (`janelaRespostaSchema`).
 */
import type { Ritmo } from "./config";
import { dentroDaJanela, horaDeResponder, type Sortear } from "./ritmo";

export type JanelaDeResposta = { inicioMin: number; fimMin: number };

export const JANELA_RESPOSTA_PADRAO: JanelaDeResposta = { inicioMin: 8 * 60, fimMin: 22 * 60 };

function ritmoDaJanela(j: JanelaDeResposta, ritmo: Ritmo): Ritmo {
  const bloco = { inicio: j.inicioMin, fim: j.fimMin };
  return { ...ritmo, feriados: [], janela: { semana: [bloco], sabado: [bloco], domingo: [bloco] } };
}

export const dentroDaJanelaDeResposta = (t: Date, j: JanelaDeResposta, ritmo: Ritmo) => dentroDaJanela(t, ritmoDaJanela(j, ritmo));

/** O começo da próxima janela de resposta (mais um sorteio de minutos), a partir de `t`. */
export const proximaJanelaDeResposta = (t: Date, j: JanelaDeResposta, ritmo: Ritmo, sortear: Sortear) =>
  horaDeResponder(t, ritmoDaJanela(j, ritmo), sortear, true);
