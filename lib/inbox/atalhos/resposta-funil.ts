/** Formato de resposta e mapeamento de erro do Postgres das rotas de funil (`app/api/v1/funnels`). */
import { fail } from "@/lib/api/wrappers";

import type { FunilGravado } from "./repositorio-funis";
import { duracaoDoFunilMs } from "./schema-funil";

export const paraResposta = (f: FunilGravado) => ({
  id: f.id,
  nome: f.nome,
  atalho: f.atalho,
  palavras_chave: f.palavras_chave,
  favorito: f.favorito,
  compartilhado: f.owner_user_id === null,
  passos: f.passos,
  duracao_ms: duracaoDoFunilMs(f.passos),
});

export function erroDoFunil(e: unknown, requestId: string): Response {
  const { code: codigo, message } = (e as { code?: string; message?: string } | null) ?? {};
  // A RPC levanta `P0001` com a mensagem `funnel_modelo_pessoal` (passo com modelo pessoal alheio ou invisível).
  const code = codigo === "P0001" && message === "funnel_modelo_pessoal" ? message : codigo;
  if (code === "funnel_modelo_pessoal") return fail("funnel_modelo_pessoal", "Uma mensagem não existe ou não pode ser usada neste funil por ser pessoal.", 422, { requestId });
  if (code === "23505") return fail("funnel_atalho_taken", "Já existe um funil com esse atalho nesta organização.", 409, { requestId });
  if (code === "23503") return fail("validation_failed", "Um dos passos aponta para uma mensagem que não existe mais.", 422, { requestId });
  if (code === "42501") return fail("forbidden", "Você não pode alterar este funil.", 403, { requestId });
  return fail("internal_error", "Erro ao gravar o funil.", 500, { requestId });
}
