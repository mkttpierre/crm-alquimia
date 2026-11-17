export type Entrada = { tipos: string[]; explicacao?: string | null; tabela?: string | null; perguntaKit?: string | null; etapa?: string; retornoEm?: string | null; avisos?: string[]; precisaOperador?: boolean; motivo?: string | null; objecoes?: string[]; parada?: boolean };
export function acoesEquivalentes(esperado: string, obtido: string): boolean {
  return esperado === obtido || (esperado === "funil_valores" && obtido === "explicacao_e_valores") || (["nada", "operador"].includes(esperado) && ["nada", "operador"].includes(obtido));
}
export function classificarSaida(e: Entrada): string {
  const tipos = e.tipos.map(t => t.replace(/:seq$/, "")).filter(t => !t.startsWith("followup_") && t !== "retorno_reserva");
  if (e.etapa === "nao_contatar" || e.etapa === "perdido") return "encerrar";
  if (e.retornoEm) return "retorno_data";
  if (e.avisos?.includes("compra") || e.etapa === "pronto_fechar") return "operador_venda";
  if (e.precisaOperador || e.parada || e.avisos?.includes("operador")) return "operador";
  const tem = (s?: string | null) => !!s && tipos.includes(s);
  if (tem(e.tabela) && tem(e.explicacao)) return "explicacao_e_valores";
  if (tem(e.tabela)) return "funil_valores";
  if (tem(e.perguntaKit)) return "pergunta_kit";
  if (tipos.some(t => e.objecoes?.includes(t) || t.startsWith("obj_"))) return "objecao_modelo";
  return tipos.length ? "resposta_modelo" : "nada";
}
