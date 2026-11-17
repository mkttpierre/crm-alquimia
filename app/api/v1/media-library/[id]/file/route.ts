/**
 * GET /api/v1/media-library/[id]/file — abre o arquivo da biblioteca: 302 para URL assinada
 * (TTL 10 min) do bucket privado `whatsapp-media`. Pensado para ser o `src` de <audio>/<img>
 * (o cookie de sessão vai junto por ser same-origin) e para o composer baixar o anexo.
 *
 * A posse é checada ANTES de assinar: a linha tem de existir para a org ativa (RLS + filtro
 * explícito), e o caminho do objeto tem de estar sob `<org>/biblioteca/`. O admin client só
 * assina depois disso — nunca com id vindo do body.
 */
import { urlAssinadaDoNavegador } from "@/lib/supabase/url-assinada";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_S = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("validation_failed", "Id inválido.", 422, { requestId });

  const supabase = await createClient();
  const { data: item, error } = await supabase
    .from("media_library")
    .select("storage_path")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao buscar o arquivo.", 500, { requestId });
  if (!item || !item.storage_path.startsWith(`${org.orgId}/biblioteca/`)) {
    return fail("not_found", "Arquivo não encontrado.", 404, { requestId });
  }

  const admin = createAdminClient();
  const { data: signed, error: signErr } = await admin.storage
    .from("whatsapp-media")
    .createSignedUrl(item.storage_path, SIGNED_URL_TTL_S);
  if (signErr || !signed?.signedUrl) return fail("internal_error", "Erro ao abrir o arquivo.", 500, { requestId });

  const res = NextResponse.redirect(urlAssinadaDoNavegador(signed.signedUrl), 302);
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("X-Request-Id", requestId);
  return res;
}
