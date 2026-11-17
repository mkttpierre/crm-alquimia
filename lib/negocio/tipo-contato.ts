/** Classifica??o baseada nos campos conhecidos de metadados da origem. */
export function tipoContato(metadata: unknown): "pessoa" | "empresa" {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "pessoa";
  const dados = metadata as Record<string, unknown>;
  return ["empresa", "company", "cnpj", "razao_social"].some((chave) => {
    const valor = dados[chave];
    return typeof valor === "string" && valor.trim().length > 0;
  }) ? "empresa" : "pessoa";
}
