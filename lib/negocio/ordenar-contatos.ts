export function ordenarContatos<T>(linhas: T[], coluna: keyof T, direcao: "asc" | "desc"): T[] {
  return [...linhas].sort((a, b) => {
    const x = a[coluna];
    const y = b[coluna];
    if (x == null) return y == null ? 0 : 1;
    if (y == null) return -1;
    const resultado = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "pt-BR", { sensitivity: "base" });
    return direcao === "asc" ? resultado : -resultado;
  });
}
