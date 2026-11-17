/** Identifica a recusa estruturada do canal, mesmo quando o corpo vem truncado. */
export function semWhatsapp(erro: string): boolean {
  const inicio = erro.indexOf("{");
  if (inicio < 0) return false;
  const corpo = erro.slice(inicio);
  try {
    const contem = (valor: unknown): boolean => {
      if (valor === null || typeof valor !== "object") return false;
      if (Array.isArray(valor)) return valor.some(contem);
      return Object.entries(valor).some(([chave, v]) => (chave === "exists" && v === false) || contem(v));
    };
    return contem(JSON.parse(corpo) as unknown);
  } catch {
    return /"exists"\s*:\s*false\b/.test(corpo);
  }
}
