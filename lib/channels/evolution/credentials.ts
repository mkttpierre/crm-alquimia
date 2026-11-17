/**
 * Credenciais do canal Evolution API — **por sessão**, com env como fallback.
 *
 * Mesmo desenho de `../zernio/credentials.ts`: duas organizações na mesma
 * instalação podem apontar para servidores Evolution DIFERENTES (um container
 * por negócio), então URL e apikey vivem na linha de `channel_sessions`, cifrada
 * pelas mesmas RPCs do resto do repo (`lib/webhooks/secrets.ts`). O env
 * (`EVOLUTION_API_BASE_URL` + `EVOLUTION_API_KEY`) é só o fallback de quem tem um
 * servidor único.
 *
 * A busca leva a ORGANIZAÇÃO junto pelo motivo da issue #236: o nome da instância
 * é identificador do PROVIDER, e `maybeSingle()` com duas linhas devolve
 * `data: null` + `PGRST116` — que, com o `error` descartado, mandaria o envio
 * para a conta do `.env`. O filtro por organização está aqui; o índice único
 * parcial, na migration 0233.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface EvolutionCredentials {
  baseUrl: string;
  apiKey: string;
  /** O `sessionRef` do canal: nome da instância no servidor. */
  instance: string;
  /** De onde veio — para log de diagnóstico, nunca para o payload. */
  source: "session" | "env";
}

export interface EvolutionCredsLookup {
  /** Resolvido de fonte confiável (sessão, linha já escopada, token do webhook). */
  organizationId: string;
  /** `channel_sessions.evolution_instance_name`. */
  instance: string;
}

/**
 * `||` e `trim()`, não `??`: o `.env.example` entrega chaves vazias, e string
 * vazia é valor para o `??` — montaria uma URL sem host. Ver o mesmo defeito
 * medido em `zernioBaseUrl`.
 */
function limparBase(url: string | null | undefined): string | null {
  const t = url?.trim().replace(/\/+$/, "");
  return t ? t : null;
}

export function evolutionBaseUrlFromEnv(): string | null {
  return limparBase(process.env.EVOLUTION_API_BASE_URL);
}

/** Credencial do ambiente. `null` = não configurada (noop, nunca erro). */
export function evolutionCredsFromEnv(instance: string): EvolutionCredentials | null {
  const baseUrl = evolutionBaseUrlFromEnv();
  const apiKey = process.env.EVOLUTION_API_KEY?.trim();
  if (!baseUrl || !apiKey || !instance) return null;
  return { baseUrl, apiKey, instance, source: "env" };
}

/**
 * Credencial gravada na sessão desta organização. `null` = a sessão não tem
 * chave gravada (cai no env). LANÇA quando a consulta falha — descartar o erro
 * era metade do defeito da #236.
 *
 * Uma sessão com chave e SEM URL própria usa a URL do env: a chave sozinha não
 * endereça nada, e exigir os dois na linha obrigaria a repetir o servidor em
 * toda sessão de uma instalação de servidor único.
 */
export async function evolutionCredsForInstance(
  admin: SupabaseClient,
  lookup: EvolutionCredsLookup,
): Promise<EvolutionCredentials | null> {
  const { organizationId, instance } = lookup;
  if (!organizationId || !instance) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("evolution_instance_name, evolution_base_url, evolution_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("evolution_instance_name", instance);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `evolution_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const cifrado = data?.evolution_token_encrypted;
  if (!data || !cifrado) return null;

  const apiKey = await decryptWebhookSecret(admin, cifrado as unknown as string, {
    contexto: `evolution-token:${organizationId}:${instance}`,
  });
  // Decifra que falha devolve null (GUC da chave ausente): cai no env em vez de
  // derrubar o envio; o `source` deixa a diferença visível para quem depura, e o
  // aviso sai uma vez por instância (cada envio repetiria o mesmo erro).
  if (!apiKey) return null;

  const baseUrl = limparBase(data.evolution_base_url as string | null) ?? evolutionBaseUrlFromEnv();
  if (!baseUrl) return null;

  return { baseUrl, apiKey, instance: data.evolution_instance_name as string, source: "session" };
}

/** Sessão primeiro, env como fallback: com a chave gravada, o env deixa de valer. */
export async function resolveEvolutionCreds(
  admin: SupabaseClient,
  lookup: EvolutionCredsLookup,
): Promise<EvolutionCredentials | null> {
  return (await evolutionCredsForInstance(admin, lookup)) ?? evolutionCredsFromEnv(lookup.instance);
}
