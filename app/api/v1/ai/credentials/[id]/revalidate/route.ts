import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/credentials/:id/revalidate (admin)
 *
 * Decifra a credential, faz ping síncrono ao provider e atualiza
 * `validated_at` / `validation_error` / `models_available`. Diferente do POST
 * de criação, aqui esperamos o resultado pra devolver ao usuário (botão "Test").
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { patchDeValidacao, validateProviderCredential } from "@/lib/ai/provider-validators";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, models_tools, is_active, created_by, created_at, updated_at, base_url";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  // Pra revalidate ignoramos o gate `validated_at` do loadCredential — fazemos
  // a leitura bruta e decifragem direta.
  const { data: row, error: fetchErr } = await admin
    .from("ai_provider_credentials")
    .select(
      "id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, is_active, base_url",
    )
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", "Erro ao consultar credential.", 500, { requestId });
  }
  if (!row || row.organization_id !== activeOrg.orgId) {
    return fail("not_found", t("Credential não encontrada."), 404, { requestId });
  }
  if (!row.is_active) {
    return fail("credential_inactive", t("Credential desativada."), 409, { requestId });
  }

  // Leitura direta + decifragem (sem passar pelo gate `validated_at` do
  // loadCredential — revalidate aceita credenciais ainda não validadas).
  //
  // O Ollama (modelo local) não tem chave: não há o que decifrar, e quem
  // responde é o servidor do endereço gravado (`base_url`), conferido de novo
  // pela política de rede dentro do validador.
  let apiKey: string | null = null;
  if (row.provider !== "ollama") {
    try {
      apiKey = decryptKey({
        ciphertext: byteaToBuffer(row.api_key_encrypted),
        iv: byteaToBuffer(row.api_key_iv),
        tag: byteaToBuffer(row.api_key_tag),
      });
    } catch (err) {
      console.error("[ai.credentials] decrypt failed during revalidate", err);
      return fail("decrypt_failed", t("Falha ao decifrar credential."), 500, { requestId });
    }
  }

  const result = await validateProviderCredential(row.provider, {
    apiKey,
    baseUrl: (row as { base_url?: string | null }).base_url ?? null,
  });
  // Regrava a lista viva (`models_available`, `models_tools`) e a data dela:
  // é o que o botão "Atualizar modelos" da tela de Provedores aciona.
  const patch = patchDeValidacao(result);

  const { data: updated, error: updErr } = await admin
    .from("ai_provider_credentials")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select(SAFE_COLUMNS)
    .single();

  if (updErr || !updated) {
    return fail("internal_error", "Erro ao atualizar credential.", 500, { requestId });
  }

  await audit({
    action: "ai.credential_revalidated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_provider_credential",
    resourceId: id,
    requestId,
    metadata: {
      provider: row.provider,
      label: row.label,
      ok: result.ok,
      error: result.ok ? null : result.error,
    },
  });

  return ok(updated, { requestId });
}
