/**
 * Decrypt just-in-time de `ai_provider_credentials`.
 *
 * Usado pelo runtime de agents (S-13.08) e pelo endpoint `:revalidate`.
 * Plaintext só vive no objeto retornado — nunca é logado, persistido em cache
 * ou enviado pra Sentry. Caller é responsável por descartar a referência ao
 * término da request.
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { createAdminClient } from "@/lib/supabase/admin";

import type { Provider } from "./provider-validators";

export interface LoadedCredential {
  /** No Ollama (modelo local, sem chave) é um texto fixo sem valor. */
  apiKey: string;
  /** O endereço da credencial; só o Ollama tem (`null` nos demais). */
  baseUrl: string | null;
  provider: Provider;
  label: string;
}

export class CredentialUnavailableError extends Error {
  constructor(public readonly reason:
    | "not_found"
    | "inactive"
    | "not_validated"
    | "wrong_org"
    | "decrypt_failed",
  message: string,
  ) {
    super(message);
    this.name = "CredentialUnavailableError";
  }
}

interface CredentialRow {
  id: string;
  organization_id: string;
  provider: Provider;
  label: string;
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
  is_active: boolean;
  validated_at: string | null;
}

/**
 * Carrega e decifra a credencial in-memory.
 * - 404-equivalent: `CredentialUnavailableError("not_found")`
 * - inativa: `CredentialUnavailableError("inactive")`
 * - sem `validated_at`: `CredentialUnavailableError("not_validated")`
 * - org diferente: `CredentialUnavailableError("wrong_org")` (defensivo —
 *   admin client bypassa RLS, então filtro programático é obrigatório).
 */
export async function loadCredential(
  id: string,
  organizationId: string,
): Promise<LoadedCredential> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_provider_credentials")
    .select(
      "id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, is_active, validated_at",
    )
    .eq("id", id)
    .maybeSingle<CredentialRow>();

  if (error) {
    throw new CredentialUnavailableError("not_found", `query_error: ${error.message}`);
  }
  if (!data) {
    throw new CredentialUnavailableError("not_found", "credential não encontrada");
  }
  if (data.organization_id !== organizationId) {
    throw new CredentialUnavailableError("wrong_org", "credential pertence a outra org");
  }
  if (!data.is_active) {
    throw new CredentialUnavailableError("inactive", "credential desativada");
  }
  if (!data.validated_at) {
    throw new CredentialUnavailableError(
      "not_validated",
      "credential ainda não validada com o provedor",
    );
  }

  // Provedor sem chave (ollama): nada a decifrar; o destino é o endereço.
  if (data.provider === "ollama") {
    // `base_url` numa consulta própria, só para ele: a leitura dos demais
    // provedores não depende da coluna da migration 0260.
    const { data: end } = await admin
      .from("ai_provider_credentials")
      .select("base_url")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    return {
      apiKey: "ollama",
      baseUrl: (end as { base_url?: string | null } | null)?.base_url ?? null,
      provider: data.provider,
      label: data.label,
    };
  }

  let apiKey: string;
  try {
    apiKey = decryptKey({
      ciphertext: byteaToBuffer(data.api_key_encrypted),
      iv: byteaToBuffer(data.api_key_iv),
      tag: byteaToBuffer(data.api_key_tag),
    });
  } catch (err) {
    throw new CredentialUnavailableError(
      "decrypt_failed",
      err instanceof Error ? err.message : "decrypt_failed",
    );
  }

  return { apiKey, baseUrl: null, provider: data.provider, label: data.label };
}
