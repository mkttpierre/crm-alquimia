/**
 * `Idempotency-Key` guardada no BANCO (`idempotency_keys`, migration 0001), não em memória.
 *
 * Por que o banco: a chave tem de valer entre processos (duas réplicas, um reinício no meio do envio). O unique
 * `(organization_id, key, endpoint)` da tabela é a reserva atômica: quem insere primeiro é dono do pedido; quem
 * recebe `23505` lê a linha e devolve o que ela diz — "ainda em andamento" ou a resposta já guardada. Sem tabela nova
 * e sem função nova: a mesma tabela que a ferramenta MCP de envio já usa.
 *
 * A linha nasce com `status_code = 102` (em andamento) e é concluída com o status e o corpo da resposta. Um processo
 * que morre no meio deixa a chave em andamento até expirar (24 h): a repetição daquela chave recebe "em andamento" e
 * NUNCA envia de novo — envio em dobro é pior que envio incerto. Um clique novo traz chave nova e não é afetado.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";

export const STATUS_EM_ANDAMENTO = 102;
const TTL_MS = 24 * 60 * 60 * 1000;

export type RespostaGuardada =
  | { data: unknown }
  | { error: { code: string; message: string } };

export interface AlvoDaChave {
  organizationId: string;
  /** Rota + ator: a chave de um usuário nunca lê a resposta guardada de outro. */
  endpoint: string;
  chave: string;
}

export type Reserva =
  | { tipo: "nova" }
  | { tipo: "em_andamento" }
  | { tipo: "conflito" }
  | { tipo: "repetida"; status: number; corpo: RespostaGuardada };

/** A chave do cabeçalho, ou null. Aparada e com teto: é texto do cliente. */
export function chaveDoPedido(headers: Headers): string | null {
  return headers.get("idempotency-key")?.trim().slice(0, 200) || null;
}

/** `bytea` em hex, no formato que o PostgREST aceita e devolve (`\x…`). */
export function hashDoPedido(corpo: unknown): string {
  return `\\x${createHash("sha256").update(JSON.stringify(corpo)).digest("hex")}`;
}

function falhaFechada(requestId: string): ApiError {
  return new ApiError(500, "internal_error", undefined, requestId, "Não foi possível registrar o envio. Nada foi enviado; tente de novo.");
}

/**
 * Reserva a chave para este pedido. Falha FECHADA: se o banco não responde, lança — melhor recusar o envio do que
 * mandar sem a proteção que impede a duplicata.
 */
export async function reservarChave(
  supabase: SupabaseClient,
  alvo: AlvoDaChave,
  hash: string,
  requestId: string,
): Promise<Reserva> {
  const { error } = await supabase.from("idempotency_keys").insert({
    organization_id: alvo.organizationId,
    endpoint: alvo.endpoint,
    key: alvo.chave,
    request_hash: hash,
    status_code: STATUS_EM_ANDAMENTO,
    response_body: { em_andamento: true },
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
  });
  if (!error) return { tipo: "nova" };
  if (error.code !== "23505") throw falhaFechada(requestId);

  const { data, error: erroLeitura } = await supabase
    .from("idempotency_keys")
    .select("request_hash, status_code, response_body")
    .eq("organization_id", alvo.organizationId)
    .eq("endpoint", alvo.endpoint)
    .eq("key", alvo.chave)
    .maybeSingle();
  if (erroLeitura || !data) throw falhaFechada(requestId);
  const linha = data as { request_hash: string; status_code: number; response_body: RespostaGuardada };
  if (String(linha.request_hash).toLowerCase() !== hash.toLowerCase()) return { tipo: "conflito" };
  if (linha.status_code === STATUS_EM_ANDAMENTO) return { tipo: "em_andamento" };
  return { tipo: "repetida", status: linha.status_code, corpo: linha.response_body };
}

/**
 * Guarda a resposta do pedido dono da chave. Se não conseguir, a chave fica "em andamento": a repetição recebe 409
 * e não envia — o desfecho seguro. Por isso não lança.
 */
export async function concluirChave(
  supabase: SupabaseClient,
  alvo: AlvoDaChave,
  status: number,
  corpo: RespostaGuardada,
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("idempotency_keys")
      .update({ status_code: status, response_body: corpo })
      .eq("organization_id", alvo.organizationId)
      .eq("endpoint", alvo.endpoint)
      .eq("key", alvo.chave);
    return !error;
  } catch {
    return false;
  }
}
