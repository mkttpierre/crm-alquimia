/** Validação do upload outbound (Onda 2). Allowlist por categoria + teto por tipo. */
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

export type MessageKind = "image" | "video" | "audio" | "document";

/**
 * Posse do objeto no bucket: o path DEVE estar sob {org}/{conversation}/
 * (chaves do Storage são literais — sem semântica de traversal).
 *
 * Morava dentro do módulo de transporte do provider legado e não tinha nada a
 * ver com o canal: valida um path do NOSSO Storage, antes de qualquer coisa
 * tocar um provider. Ficar lá obrigava o handler de envio a importar do módulo
 * do provider — o acoplamento que o invariante 1 de
 * `docs/doctrine/restricao-de-canal.md` proíbe.
 */
export function isMediaPathOwnedBy(path: string, orgId: string, conversationId: string): boolean {
  return path.startsWith(`${orgId}/${conversationId}/`);
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);

/**
 * Os containers de vídeo que o WhatsApp reproduz. Fora deles (`.mov` do iPhone, `.webm`, `.mkv`) o
 * arquivo subia com extensão `.bin`, a Evolution deduzia `application/octet-stream` pelo nome e o
 * vídeo nunca tocava do outro lado — e o `video/webm` ainda era convertido em ÁUDIO pelo
 * transcodificador de nota de voz e mandado como vídeo. Recusar na tela, com o motivo, é melhor
 * que uma falha muda no aparelho do cliente.
 */
const VIDEO_MIMES = new Set(["video/mp4", "video/3gpp"]);

const MB = 1024 * 1024;

/**
 * Teto por tipo. Vídeo e áudio: 16 MB, o limite do WhatsApp para mídia que chega como vídeo ou
 * nota de voz (acima disso o canal aceita o pedido e a mídia não sai). Imagem e documento seguem
 * com o teto do bucket.
 */
export const LIMITE_POR_TIPO_BYTES: Record<MessageKind, number> = {
  image: MAX_MEDIA_BYTES,
  video: 16 * MB,
  audio: 16 * MB,
  document: MAX_MEDIA_BYTES,
};

const ACIMA_DO_BUCKET = "Arquivo acima de 50MB.";
const VIDEO_ACIMA = "Vídeo acima de 16 MB. O WhatsApp não aceita vídeo maior que isso.";
const AUDIO_ACIMA = "Áudio acima de 16 MB. O WhatsApp não aceita áudio maior que isso.";
const VIDEO_FORMATO = "Vídeo precisa estar em MP4 para o WhatsApp reproduzir.";
const TIPO_NAO_SUPORTADO = "Tipo de arquivo não suportado.";
const ARQUIVO_VAZIO = "Arquivo vazio.";

/** Todo texto de recusa: a tela o passa por `t()`, então cada um precisa de tradução no dicionário. */
export const MENSAGENS_DE_RECUSA = [
  ACIMA_DO_BUCKET,
  VIDEO_ACIMA,
  AUDIO_ACIMA,
  VIDEO_FORMATO,
  TIPO_NAO_SUPORTADO,
  ARQUIVO_VAZIO,
] as const;

const ACIMA_DO_LIMITE: Record<MessageKind, string> = {
  image: ACIMA_DO_BUCKET,
  video: VIDEO_ACIMA,
  audio: AUDIO_ACIMA,
  document: ACIMA_DO_BUCKET,
};

type Ok = { ok: true; kind: MessageKind };
type Fail = { ok: false; code: "unsupported_media_type" | "payload_too_large" | "validation_failed"; message: string };

function tipoDoMime(base: string): MessageKind | null {
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("video/")) return "video";
  if (base.startsWith("audio/")) return "audio";
  if (DOCUMENT_MIMES.has(base)) return "document";
  return null;
}

export function validateOutboundMedia(mime: string, sizeBytes: number): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: ARQUIVO_VAZIO };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: ACIMA_DO_BUCKET };
  }
  const base = mime.split(";")[0]!.trim().toLowerCase();
  const kind = tipoDoMime(base);
  if (!kind) return { ok: false, code: "unsupported_media_type", message: TIPO_NAO_SUPORTADO };
  if (kind === "video" && !VIDEO_MIMES.has(base)) {
    return { ok: false, code: "unsupported_media_type", message: VIDEO_FORMATO };
  }
  if (sizeBytes > LIMITE_POR_TIPO_BYTES[kind]) {
    return { ok: false, code: "payload_too_large", message: ACIMA_DO_LIMITE[kind] };
  }
  return { ok: true, kind };
}

/**
 * O que a tela diz ANTES de subir o arquivo: `null` = pode subir. É a MESMA regra que a rota de
 * upload aplica — a tela só poupa o operador de esperar o upload de algo que vai ser recusado.
 */
export function recusaDoAnexo(mime: string, sizeBytes: number): string | null {
  const veredito = validateOutboundMedia(mime, sizeBytes);
  return veredito.ok ? null : veredito.message;
}
