/**
 * GET /api/v1/media-library — a biblioteca de mídia da organização ativa (áudios, imagens,
 * documentos que a casa reenvia), com as respostas rápidas que usam cada arquivo.
 *
 * A RLS `tenant_isolation_media_library_all` já limita aos arquivos da org; o
 * `.eq("organization_id")` é a segunda trava, com a org resolvida do cookie validado.
 * O arquivo em si NÃO vem aqui: `/api/v1/media-library/[id]/file` entrega (URL assinada).
 */
import { createHash, randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const COLS = "id, kind, name, description, mime, size_bytes, legacy_names, tags, created_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("media_library")
    .select(COLS)
    .eq("organization_id", org.orgId)
    .order("name", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar a biblioteca de mídia.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

/** Limite de um arquivo da biblioteca (vídeo curto de WhatsApp cabe; o corpo da rota aceita até 60 MB). */
export const LIMITE_DA_BIBLIOTECA_BYTES = 50 * 1024 * 1024;

const RETORNO = "id, kind, name, mime, size_bytes";

function tipoDoMime(mime: string): "audio" | "image" | "video" | "document" {
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

function extensao(nome: string, mime: string): string {
  const doNome = /\.([a-z0-9]{1,8})$/i.exec(nome)?.[1]?.toLowerCase();
  if (doNome) return doNome;
  return mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
}

/**
 * POST /api/v1/media-library — sobe um arquivo para a biblioteca (multipart `file`, `name` opcional). agent+.
 * O arquivo vai para `whatsapp-media/<org>/biblioteca/<sha256>.<ext>` (o motor só envia dessa pasta) e ganha uma
 * linha em `media_library`. O mesmo arquivo de novo (mesmo sha256 na org) devolve a linha que já existe, com 200.
 * Org da sessão, nunca do corpo; service role com `organization_id` explícito (o bucket não tem policy de usuário).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("validation_failed", "Envie o arquivo no campo `file` (multipart).", 422, { requestId });
  }
  const arquivo = form.get("file");
  if (!(arquivo instanceof File) || arquivo.size === 0) {
    return fail("validation_failed", "Envie o arquivo no campo `file` (multipart).", 422, { requestId });
  }
  if (arquivo.size > LIMITE_DA_BIBLIOTECA_BYTES) {
    return fail("payload_too_large", "O arquivo passa de 50 MB.", 413, { requestId });
  }
  const nomeInformado = form.get("name");
  const nome = (typeof nomeInformado === "string" && nomeInformado.trim() ? nomeInformado.trim() : arquivo.name || "arquivo").slice(0, 200);
  const mime = arquivo.type || "application/octet-stream";
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const admin = createAdminClient();
  const { data: existente, error: e1 } = await admin
    .from("media_library")
    .select(RETORNO)
    .eq("organization_id", org.orgId)
    .eq("sha256", sha256)
    .maybeSingle();
  if (e1) return fail("internal_error", "Erro ao consultar a biblioteca de mídia.", 500, { requestId });
  if (existente) return ok(existente, { status: 200, requestId });

  const storagePath = `${org.orgId}/biblioteca/${sha256}.${extensao(arquivo.name, mime)}`;
  const { error: e2 } = await admin.storage.from("whatsapp-media").upload(storagePath, bytes, { contentType: mime, upsert: true });
  if (e2) return fail("internal_error", "Não consegui guardar o arquivo.", 500, { requestId });

  const { data: criada, error: e3 } = await admin
    .from("media_library")
    .insert({
      organization_id: org.orgId,
      kind: tipoDoMime(mime),
      name: nome,
      storage_path: storagePath,
      mime,
      size_bytes: arquivo.size,
      sha256,
      source: "upload",
    })
    .select(RETORNO)
    .single();
  if (e3 || !criada) return fail("internal_error", "Não consegui registrar o arquivo na biblioteca.", 500, { requestId });

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "media_library.uploaded",
    resourceType: "media_library",
    resourceId: (criada as { id: string }).id,
    requestId,
    metadata: { kind: tipoDoMime(mime), size_bytes: arquivo.size },
  });
  return ok(criada, { status: 201, requestId });
}
