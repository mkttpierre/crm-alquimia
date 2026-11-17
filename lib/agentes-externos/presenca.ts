/**
 * PRESENÇA do agente externo: toda chamada autenticada grava `ultimo_uso_em` e `ultima_acao` (o NOME da ferramenta,
 * nunca dado pessoal) — no máximo UMA escrita a cada 30 s por agente.
 *
 * Duas travas, cada uma com o seu papel:
 *   - a memória deste processo poupa até a ida ao banco quando o agente chama 20 ferramentas num minuto;
 *   - o banco decide de verdade (`fn_marcar_uso_do_agente_externo`, migration 0256): o UPDATE só casa quando a última
 *     marca tem mais de 30 s. Com duas réplicas do app, a memória sozinha deixaria passar uma escrita por réplica.
 *
 * Nunca lança: presença é informação, não pode derrubar a ferramenta que o agente chamou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export const INTERVALO_DA_PRESENCA_MS = 30_000;

/**
 * Teto da memória: um token por agente, mas o processo vive meses. Passou do teto, sai o mais antigo (o `Map` guarda a
 * ordem de inserção, e cada tentativa reinsere o token no fim).
 */
export const TETO_DA_MEMORIA_DE_PRESENCA = 1_000;

const ultimaTentativa = new Map<string, number>();

function lembrar(apiTokenId: string, quando: number): void {
  ultimaTentativa.delete(apiTokenId);
  ultimaTentativa.set(apiTokenId, quando);
  while (ultimaTentativa.size > TETO_DA_MEMORIA_DE_PRESENCA) {
    const maisAntigo = ultimaTentativa.keys().next().value;
    if (maisAntigo === undefined) break;
    ultimaTentativa.delete(maisAntigo);
  }
}

/** Só para teste: quantos tokens a memória guarda agora. */
export function tamanhoDaMemoriaDePresenca(): number {
  return ultimaTentativa.size;
}

/** Grava a presença se a última marca deste token tem 30 s ou mais. Devolve se gravou. */
export async function registrarPresenca(
  admin: SupabaseClient,
  apiTokenId: string,
  acao: string,
  agora: Date = new Date(),
): Promise<boolean> {
  const antes = ultimaTentativa.get(apiTokenId);
  if (antes !== undefined && agora.getTime() - antes < INTERVALO_DA_PRESENCA_MS) return false;
  lembrar(apiTokenId, agora.getTime());

  try {
    const { data, error } = await admin.rpc("fn_marcar_uso_do_agente_externo", {
      p_api_token_id: apiTokenId,
      p_acao: acao.slice(0, 120),
    });
    if (error) {
      logger.warn("[agentes-externos] presença não gravada", { error: error.message });
      return false;
    }
    return data === true;
  } catch (err) {
    logger.warn("[agentes-externos] presença não gravada", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Só para teste: esquece as tentativas deste processo. */
export function esquecerPresencasParaTeste(): void {
  ultimaTentativa.clear();
}
