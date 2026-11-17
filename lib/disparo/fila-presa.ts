/**
 * Fila presa em chip parado (E4): só leitura e aviso.
 *
 * `vencidos` busca a fila POR CHIP e a realocação (`resolverSemChip`) só cuida de linha sem chip. Então o envio vencido
 * de um chip vermelho, pausado, desligado ou com a conexão caída fica parado para sempre — medido em produção: 67 envios
 * em três chips — e ninguém sabia. Mover a fila para outro chip NÃO é decisão do motor: cada lead tem o seu chip (e a
 * regra de `chip_origem` vale). Aqui só se conta e se avisa: UM aviso por organização na Central, atualizado no lugar
 * quando os números mudam, e fechado quando nenhum chip parado tem fila vencida.
 */
import type { EstadoChip, SaudeChip } from "./fila";
import { MIN } from "./ritmo";

/**
 * Atraso mínimo do envio mais antigo para contar como preso. Abaixo disso é o chip que acabou de parar (freio de
 * 10 min depois de uma falha, reconexão rápida): avisar seria ruído.
 */
export const ATRASO_MINIMO_DA_FILA_PRESA_MIN = 30;

/** Começo fixo do título do aviso: é por ele que o aviso aberto da organização é achado. */
export const PREFIXO_AVISO_FILA_PRESA = "Disparo: envios vencidos presos em chip parado";

/** Um chip da organização (inclusive os que não entram na volta) e a conexão dele. `conexao` null = sem sessão ligada. */
export type SituacaoDoChip = { id: string; nome: string; estado: EstadoChip; saude: SaudeChip; pausadoAte: Date | null; conexao: string | null };

const CONEXOES_DE_PE = new Set(["WORKING", "OPEN"]);

/**
 * Por que o chip não manda (null = está de pé). A conexão só conta com o envio real: no ensaio (simulado) o motor não
 * fala com o canal. A pausa curta (`pausado_ate` de um chip não vermelho, o freio de 10 min) é passageira: não conta.
 */
export function motivoDoChipParado(s: SituacaoDoChip, real: boolean): string | null {
  const r: string[] = [];
  if (s.saude === "vermelho") r.push("saúde vermelha");
  if (s.estado === "pausado" || s.estado === "desligado") r.push(`chip ${s.estado}`);
  if (real) {
    if (!s.conexao) r.push("sem conexão ligada");
    else if (!CONEXOES_DE_PE.has(s.conexao.toUpperCase())) r.push(`conexão ${s.conexao}`);
  }
  return r.length ? r.join(", ") : null;
}

export type ChipComFilaPresa = { nome: string; motivo: string; total: number; desde: Date };

/** Só os chips cuja fila venceu há pelo menos `ATRASO_MINIMO_DA_FILA_PRESA_MIN`. */
export function filaPresaQueConta(chips: ChipComFilaPresa[], agora: Date): ChipComFilaPresa[] {
  return chips.filter((c) => c.total > 0 && agora.getTime() - c.desde.getTime() >= ATRASO_MINIMO_DA_FILA_PRESA_MIN * MIN);
}

const hora = (d: Date, fusoMinutos: number) => {
  const l = new Date(d.getTime() + fusoMinutos * MIN);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(l.getUTCDate())}/${p(l.getUTCMonth() + 1)} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
};

/** O texto do aviso. Determinístico (sem "há X min"), para a volta seguinte só regravar quando algo mudou. */
export function textoDaFilaPresa(chips: ChipComFilaPresa[], fusoMinutos: number): { titulo: string; corpo: string } {
  const total = chips.reduce((t, c) => t + c.total, 0);
  const linhas = [...chips]
    .sort((a, b) => a.desde.getTime() - b.desde.getTime())
    .map((c) => `• ${c.nome} (${c.motivo}): ${c.total} ${c.total === 1 ? "envio vencido" : "envios vencidos"}, o mais antigo desde ${hora(c.desde, fusoMinutos)}`);
  return {
    titulo: `${PREFIXO_AVISO_FILA_PRESA} (${total} no total)`,
    corpo: [
      "Estes envios já venceram e não saem porque o chip deles está parado:",
      ...linhas,
      "O motor não os passa para outro chip (cada lead tem o seu chip, e a regra de chip de origem vale): decida se devolve o chip ou cancela a fila dele. Este aviso se atualiza sozinho e fecha quando a fila andar.",
    ].join("\n"),
  };
}
