/**
 * Webhook GLOBAL da Evolution (instalação local de um comando).
 *
 * A Evolution aceita UMA url global para todas as instâncias e não deixa pôr cabeçalho nela, então o
 * segredo vai no caminho (o `EVOLUTION_WEBHOOK_TOKEN` do ambiente, mínimo de 16 caracteres). Com esse
 * token a conexão não sai de `webhook_path_token`, e sim do NOME DA INSTÂNCIA que vem no corpo: só entre
 * as conexões do servidor único da instalação (sem `evolution_base_url`, o que o índice único da
 * instância garante), não arquivadas. É a mesma chave que `ingest.ts` confere depois
 * (`instancia_divergente`).
 *
 * Mora aqui, e não na rota, porque a doutrina de canal proíbe nomear provider fora de `lib/channels/`
 * (`scripts/lint-channels.ts`): a rota `webhooks/channel/[token]` só pergunta "este token é o global?".
 */
import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";

export const TOKEN_GLOBAL_MIN = 16;

/** O token do caminho é o global? Comparação em tempo constante; segredo ausente ou curto nunca vale. */
export function ehTokenGlobal(token: string, esperado: string | undefined): boolean {
  const segredo = (esperado || "").trim();
  if (segredo.length < TOKEN_GLOBAL_MIN) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(segredo);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** O nome da instância no corpo do webhook, ou `null` (corpo ilegível ou sem `instance`). */
export function instanciaDoCorpo(corpo: string): string | null {
  try {
    const instancia = (JSON.parse(corpo) as { instance?: unknown }).instance;
    return typeof instancia === "string" && instancia.trim() !== "" ? instancia : null;
  } catch {
    return null;
  }
}

const COLUNAS = "id, organization_id, provider, display_name, phone_number, webhook_secret_encrypted";

/** A conexão ativa da instância, com a mesma tolerância à coluna `archived_at` ausente do caminho por token. */
export function buscarConexaoDaInstancia(admin: SupabaseClient, instancia: string) {
  // Sem `organization_id` de propósito: o segredo global autentica o servidor, não uma organização, e a
  // organização sai DESTA linha (exata pelo índice único parcial da instância; ver o teste
  // `canal-consulta-por-organizacao`). O padrão `base()` é o de `queryTolerantToMissingArchived`.
  const base = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("provider", "evolution")
      .eq("evolution_instance_name", instancia)
      .is("evolution_base_url", null);
  return queryTolerantToMissingArchived(
    () => base(`${COLUNAS}, ${ARCHIVED_AT}`).is(ARCHIVED_AT, null).maybeSingle(),
    () => base(COLUNAS).maybeSingle(),
  );
}
