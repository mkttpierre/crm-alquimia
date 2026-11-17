import { normalizar } from "../leitura";
import { MIN } from "../ritmo";

/** São Paulo não tem horário de verão desde 2019 (mesmo piso do motor). */
const FUSO_SAO_PAULO_MIN = -180;
const DIA_MS = 24 * 60 * MIN;
/** Sem dia explícito, o retorno de "mês que vem" fica no dia 5, por decisão do operador. */
export const DIA_PADRAO_MES_SEGUINTE = 5;

/** Só interpreta a promessa: domingo/feriado são ajustados pela janela ao enfileirar. Não lê o relógio. */
export function dataDoRetorno(texto: string, agora: Date): Date | null {
  const t = normalizar(texto).replace(/\s+/g, " ").trim();
  const local = new Date(agora.getTime() + FUSO_SAO_PAULO_MIN * MIN);
  const ano = local.getUTCFullYear();
  const mes = local.getUTCMonth();
  const dia = local.getUTCDate();
  const asNove = (a: number, m: number, d: number) => new Date(Date.UTC(a, m, d, 9) - FUSO_SAO_PAULO_MIN * MIN);
  const daqui = (dias: number) => new Date(asNove(ano, mes, dia).getTime() + dias * DIA_MS);
  const proximoMes = /\bmes que vem\b|\bproximo mes\b/.test(t);
  const explicito = /\bdia\s+(\d{1,2})\b/.exec(t) ?? /\b(\d{1,2})\s+do\s+(?:mes que vem|proximo mes)\b/.exec(t);
  if (explicito) {
    const d = Number(explicito[1]);
    if (d < 1 || d > 31) return null;
    const alvoMes = mes + (proximoMes || d < dia ? 1 : 0);
    const alvo = asNove(ano, alvoMes, d);
    const calendario = new Date(alvo.getTime() + FUSO_SAO_PAULO_MIN * MIN);
    return calendario.getUTCDate() === d ? alvo : null; // não inventa dia 31 em fevereiro
  }
  if (/\bdepois de amanha\b/.test(t)) return daqui(2);
  if (/\bamanha\b/.test(t)) return daqui(1);
  const semana = /\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?\b/.exec(t);
  if (semana) {
    const dias = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
    const alvo = dias.indexOf(semana[1]!);
    const hoje = local.getUTCDay();
    // "sexta que vem" é a próxima sexta; "sexta da semana que vem" explicita a semana seguinte.
    const distancia = /\bsemana que vem\b/.test(t)
      ? (8 - (hoje || 7)) + (alvo + 6) % 7
      : (alvo - hoje + 7) % 7 || 7;
    return daqui(distancia);
  }
  if (/\bsemana que vem\b/.test(t)) return daqui(7); // sem dia: mesmo dia da semana, sete dias depois
  if (proximoMes) return asNove(ano, mes + 1, DIA_PADRAO_MES_SEGUINTE);
  return null;
}
