import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channel-sessions — lista os canais WhatsApp da org (do DB).
 *   Acessível a qualquer membro (usado pelo seletor do inbox e pela sidebar).
 * POST /api/v1/channel-sessions — conecta um NOVO número (cria a sessão com
 *   nome único e inicia no WAHA). Admin only.
 *
 * organization_id resolvido da sessão (cookie) — nunca do body.
 */
import { coletarChipMudo } from "@/lib/channels/evolution/chip-mudo";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { connectWahaChannel, ChannelConnectionError } from "@/lib/channels/connect-waha";
import { connectEvolutionChannel, servidorDeQrConfigurado } from "@/lib/channels/connect-evolution";
import { createAdminClient } from "@/lib/supabase/admin";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { createChannelSchema } from "@/lib/schemas/channels";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient } from "@/lib/waha/client";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export const CHANNEL_COLUMNS =
  "id, provider, waha_session_name, display_name, phone_number, status, status_reason, last_health_check_at, last_status_change_at, daily_message_limit, is_warmup_complete, created_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });

  const supabase = await createClient();
  const base = () =>
    supabase
      .from("channel_sessions")
      .select(CHANNEL_COLUMNS)
      .eq("organization_id", activeOrg.orgId);
  // Canais arquivados sobrevivem só como âncora das FKs RESTRICT
  // (conversations/messages). Para o usuário eles foram excluídos.
  //
  // Tolerante à coluna ausente porque esta é a PRIMEIRA tela de quem já tem
  // número ligado: num clone que subiu o código sem a migration 0106, o filtro
  // devolveria 42703 → 500 → "Nenhum número conectado ainda", convidando o
  // operador a parear de novo um número que já está no ar. Sem a coluna, nada
  // está arquivado, e a lista sem o filtro é a lista certa (ver lib/channels/archived).
  const { data, error, schemaOutdated } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
    () => base().order("created_at", { ascending: true }),
  );
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const channels = await Promise.all((data ?? []).map(async (canal) => ({
    ...canal,
    ...(canal.provider === "evolution" ? { chip_mudo: await coletarChipMudo(supabase, activeOrg.orgId, canal) } : {}),
  })));
  return ok(channels, {
    requestId,
    ...(schemaOutdated ? { meta: { schema_outdated: true } } : {}),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;
  if (await mfaEmDivida()) return fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, { requestId });

  // WAHA quando configurado (comportamento de sempre); sem ele, a Evolution (instalação local de um comando).
  const waha = getWahaClient();
  if (!waha && !servidorDeQrConfigurado()) {
    return fail(
      "waha_not_configured",
      t("O WhatsApp (WAHA) não está configurado neste ambiente: faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY. Configure-as e tente de novo."),
      503,
      { requestId },
    );
  }

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createChannelSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  try {
    const pedido = {
      organizationId: activeOrg.orgId, idempotencyKey: req.headers.get("Idempotency-Key") ?? "",
      userId: user.id, requestId, displayName: parsed.data.display_name,
    };
    const result = waha
      ? await connectWahaChannel(await createClient(), createAdminClient(), waha, pedido)
      : await connectEvolutionChannel(createAdminClient(), pedido);
    return ok(result.channel, { requestId, status: result.replay ? 200 : 201 });
  } catch (error) {
    if (error instanceof ChannelConnectionError) return fail(error.code,
      error.code === "connection_in_progress" ? t("A conexão ainda está sendo preparada. Aguarde e tente novamente.") : t("Não foi possível concluir a conexão. Abra Conexões para tentar novamente ou reparar o número."),
      error.status, { requestId, details: error.technical });
    return fail("internal_error", t("Não foi possível concluir a conexão. Tente novamente."), 500, { requestId });
  }
}
