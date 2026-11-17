/**
 * Funis do operador, a parte pura: o tempo em texto e a leitura do comando `/atalho`. Os funis em si moram no banco
 * (`operator_funnels`, migration 0248, que absorveu a lista fixa que vivia aqui); a execução está em
 * `lib/disparo/atendimento/sequencia-operador.ts`.
 */
/**
 * Duração para o operador: "45 s" abaixo de 1 min; até 5 min, minutos e segundos ("~1 min 24 s": a sequência do funil
 * de valores, na cadência de 3 s e 29-34 s, dura ~1 min 24 s); daí em diante, minutos arredondados para cima ("~7 min").
 */
export function duracaoEmTexto(seg: number): string {
  const total = Math.max(0, Math.round(seg));
  if (total < 60) return `${total} s`;
  if (total < 300) {
    const resto = total % 60;
    return `~${Math.floor(total / 60)} min${resto ? ` ${resto} s` : ""}`;
  }
  return `~${Math.ceil(total / 60)} min`;
}

const semBarra =(t: string) => t.trim().replace(/^\//, "").toLowerCase();

/**
 * O texto da caixa é, inteiro, um comando `/atalho` (sem espaço)? Devolve o atalho sem a barra, em minúsculas; null =
 * é texto normal. Quem decide se o atalho é de um FUNIL é o banco (`operator_funnels.atalho`, migration 0248).
 */
export function atalhoDoComando(texto: string): string | null {
  const t = texto.trim();
  if (!t.startsWith("/") || /\s/.test(t) || t.length < 2) return null;
  return semBarra(t);
}
