/**
 * Uma duração em milissegundos, no tamanho que se lê: horas até 2 dias, dias daí em diante (uma casa decimal).
 * Devolve número e unidade; quem desenha traduz a unidade.
 */
const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

export type DuracaoLegivel = { tipo: "menos_de_uma_hora" } | { tipo: "horas"; valor: number } | { tipo: "dias"; valor: number };

export function duracaoLegivel(ms: number): DuracaoLegivel {
  if (!Number.isFinite(ms) || ms < HORA_MS) return { tipo: "menos_de_uma_hora" };
  if (ms < 2 * DIA_MS) return { tipo: "horas", valor: Math.round((ms / HORA_MS) * 10) / 10 };
  return { tipo: "dias", valor: Math.round((ms / DIA_MS) * 10) / 10 };
}
