/**
 * O ÚNICO caminho do motor de disparo até um canal de verdade — o envio ao lead
 * (`criarEnvioReal`) e o aviso ao celular do operador (`criarEnvioDeAviso`) passam
 * pelo mesmo `enviarPeloChip` e pelas mesmas travas.
 *
 * Existe nesta etapa mas não roda: o motor só chama `enviarReal` quando
 * `envioRealLiberado` diz sim, e esta função confere a trava DE NOVO antes de
 * tocar no banco ou no adapter (defesa em profundidade: um chamador futuro que
 * esqueça a checagem ainda bate aqui). Não nomeia provider — pede o adapter do
 * canal ligado ao chip (`disparo_chips.channel_session_id`) pelo seam de
 * `lib/channels`, como manda o lint de canal.
 *
 * Mídia (áudio, imagem, vídeo, documento): o envio aponta para a
 * `media_library` da MESMA organização (`disparo_envios.midia_id`); o arquivo
 * vai ao canal como URL assinada do bucket privado `whatsapp-media`, nunca em
 * base64. O caminho do objeto tem de estar sob `<org>/biblioteca/` (a mesma
 * posse que a rota `/api/v1/media-library/[id]/file` confere). Texto junto de
 * imagem/vídeo/documento vira legenda; áudio não tem legenda — o atendimento
 * já separa áudio e texto em duas partes (`montarPartes`), e um áudio com
 * texto que chegue aqui é recusado antes de qualquer envio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { urlParaOCanal } from "@/lib/messaging/media/url-para-o-canal";

import {
  CHANNEL_SESSION_REF_COLUMNS,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
  type OutboundKind,
  type OutboundMedia,
} from "@/lib/channels";

import type { EnvioDeAviso, EnvioReal } from "./motor";
import { destinoPermitido, envioRealLiberado, MOTIVO_ALLOWLIST } from "./trava";

export const BUCKET_DA_MIDIA = "whatsapp-media";
/** Tempo para o canal baixar o arquivo; a URL não fica guardada em lugar nenhum. */
const VALIDADE_DA_URL_SEG = 600;

const TIPOS_DE_MIDIA = new Set<string>(["audio", "image", "video", "document"]);

type MidiaDoEnvio = { kind: OutboundKind; media: OutboundMedia };

// A função mora em lib/messaging/media (o envio manual também a usa); re-exportada para quem já importava daqui.
export { urlParaOCanal };

async function midiaDoEnvio(db: SupabaseClient, org: string, midiaId: string, texto: string): Promise<MidiaDoEnvio> {
  const { data: item, error } = await db
    .from("media_library")
    .select("kind, name, storage_path, mime")
    .eq("organization_id", org)
    .eq("id", midiaId)
    .maybeSingle();
  if (error) throw new Error(`disparo_midia: ${error.message}`);
  if (!item || !String(item.storage_path).startsWith(`${org}/biblioteca/`)) {
    throw new Error("disparo_midia_indisponivel: arquivo fora da biblioteca da organização");
  }
  const kind = String(item.kind);
  if (!TIPOS_DE_MIDIA.has(kind)) throw new Error(`disparo_midia_tipo: tipo de mídia desconhecido (${kind})`);
  if (kind === "audio" && texto.trim()) throw new Error("disparo_audio_com_texto: áudio não leva legenda; separe em duas partes");

  const { data: assinada, error: e2 } = await db.storage.from(BUCKET_DA_MIDIA).createSignedUrl(item.storage_path as string, VALIDADE_DA_URL_SEG);
  if (e2 || !assinada?.signedUrl) throw new Error(`disparo_midia_url: ${e2?.message ?? "URL assinada não gerada"}`);
  return {
    kind: kind as OutboundKind,
    media: {
      url: urlParaOCanal(assinada.signedUrl),
      mime: item.mime as string,
      filename: (item.name as string | null) ?? null,
      caption: kind === "audio" ? null : texto.trim() || null,
    },
  };
}

type DestinoDoEnvio = {
  org: string;
  chipId: string;
  /** Se informado, o chip TEM de estar ligado a esta sessão de canal (o aviso nunca sai por outro chip). */
  canalEsperado: string | null;
  telefone: string | null;
  texto: string;
  midiaId: string | null;
  /** "digitando/gravando" antes do envio (funil do operador). */
  presenca?: { tipo: "digitando" | "gravando"; ms: number } | null;
};

/** O ÚNICO trecho que fala com o canal: chip → sessão → adapter. Os dois envios (lead e operador) passam por aqui. */
async function enviarPeloChip(db: SupabaseClient, d: DestinoDoEnvio) {
  const org = d.org;
  const { data: chip, error } = await db
    .from("disparo_chips")
    .select("channel_session_id")
    .eq("organization_id", org)
    .eq("id", d.chipId)
    .maybeSingle();
  if (error) throw new Error(`disparo_chip: ${error.message}`);
  if (!chip?.channel_session_id) throw new Error("disparo_chip_sem_canal: o chip não está ligado a um canal");
  if (d.canalEsperado && chip.channel_session_id !== d.canalEsperado) {
    throw new Error("disparo_aviso_outro_chip: o chip não é o da conversa de origem");
  }

  const { data: sessao, error: e2 } = await db
    .from("channel_sessions")
    .select(`${CHANNEL_SESSION_REF_COLUMNS}, archived_at`)
    .eq("organization_id", org)
    .eq("id", chip.channel_session_id)
    .maybeSingle();
  if (e2) throw new Error(`disparo_canal: ${e2.message}`);
  if (!sessao || sessao.archived_at) throw new Error("disparo_canal_indisponivel: canal arquivado ou de outra organização");

  const ref = sessao as unknown as ChannelSessionRef;
  const adapter = getAdapter(ref.provider);
  const to = adapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: d.telefone, waIdentity: null });
  if (!to) throw new Error("disparo_sem_destinatario: lead sem endereço neste canal");
  const envelope = {
    organizationId: org,
    sessionRef: resolveSessionRef(ref),
    to,
    ...(d.presenca && d.presenca.ms > 0 ? { presence: { kind: d.presenca.tipo === "gravando" ? ("recording" as const) : ("composing" as const), ms: d.presenca.ms } } : {}),
  };
  if (!d.midiaId) return adapter.send({ ...envelope, kind: "text", body: d.texto });
  const midia = await midiaDoEnvio(db, org, d.midiaId, d.texto);
  return adapter.send({ ...envelope, kind: midia.kind, media: midia.media });
}

/**
 * A conversa do contato neste chip; cria se não existir. Nasce `resolved`: aparece em "Todas" na hora, sem
 * encher a Fila, e quando o lead responde `fn_service_inbound` reabre como `open`. Se o recebimento criar a
 * mesma conversa entre o select e o insert (23505 no índice único por contato e canal), usa a dele.
 */
async function conversaDoEnvio(db: SupabaseClient, org: string, contactId: string, sessaoId: string): Promise<string | null> {
  const buscar = async () => {
    const { data } = await db
      .from("conversations")
      .select("id")
      .eq("organization_id", org)
      .eq("contact_id", contactId)
      .eq("channel_session_id", sessaoId)
      .maybeSingle();
    return (data?.id as string | undefined) ?? null;
  };
  const existente = await buscar();
  if (existente) return existente;
  const { data, error } = await db
    .from("conversations")
    .insert({ organization_id: org, contact_id: contactId, channel_session_id: sessaoId, status: "resolved", is_group: false, channel: "whatsapp" })
    .select("id")
    .single();
  if (!error && data) return data.id as string;
  return buscar();
}

/**
 * O eco do envio chegou pelo webhook ANTES do espelho e gravou a linha como `external_device` (do celular).
 * O `external_id` é o que o canal devolveu a ESTE envio, então a linha é do motor: ganha `sent_via='automation'`
 * e a marca `espelho_do_disparo`, preservando o resto do metadata. Só toca linha `external_device` — nunca uma
 * linha do composer ou da IA que por acaso tivesse o mesmo id. Nunca lança (quem chama já está no `try`).
 */
async function assumirEcoDoMotor(db: SupabaseClient, org: string, externalId: string): Promise<void> {
  const { data: eco } = await db
    .from("messages")
    .select("id, sent_via, metadata")
    .eq("organization_id", org)
    .eq("external_id", externalId)
    .maybeSingle();
  if (!eco || eco.sent_via !== "external_device") return;
  const anterior = eco.metadata && typeof eco.metadata === "object" ? (eco.metadata as Record<string, unknown>) : {};
  const { error } = await db
    .from("messages")
    .update({ sent_via: "automation", metadata: { ...anterior, espelho_do_disparo: true } })
    .eq("organization_id", org)
    .eq("id", eco.id as string);
  if (error) logger.error("disparo_espelho_eco_nao_assumido", { organization_id: org, code: error.code });
}

/**
 * Espelha o envio na conversa (`messages`), para o atendente ver no inbox o que o motor mandou, na hora.
 * Abertura fria e toque de quem nunca respondeu criam a conversa (ver `conversaDoEnvio`).
 * Nunca lança: a mensagem já saiu, e uma falha aqui não pode virar reenvio.
 */
async function espelharNaConversa(
  db: SupabaseClient,
  d: { org: string; chipId: string; leadId: string; texto: string; midiaId: string | null; externalId: string | null },
): Promise<void> {
  try {
    const { data: chip } = await db.from("disparo_chips").select("channel_session_id").eq("organization_id", d.org).eq("id", d.chipId).maybeSingle();
    const { data: lead } = await db.from("crm_leads").select("contact_id").eq("organization_id", d.org).eq("id", d.leadId).maybeSingle();
    if (!chip?.channel_session_id || !lead?.contact_id) {
      logger.error("disparo_espelho_sem_vinculo", { organization_id: d.org, lead_id: d.leadId, chip_id: d.chipId });
      return;
    }
    const conversaId = await conversaDoEnvio(db, d.org, lead.contact_id as string, chip.channel_session_id as string);
    if (!conversaId) {
      logger.error("disparo_espelho_sem_conversa", { organization_id: d.org, lead_id: d.leadId, chip_id: d.chipId });
      return;
    }

    let tipo = "text";
    let midia: { storage_path: string; mime: string } | null = null;
    if (d.midiaId) {
      const { data: item } = await db.from("media_library").select("kind, storage_path, mime").eq("organization_id", d.org).eq("id", d.midiaId).maybeSingle();
      if (item) {
        tipo = String(item.kind);
        midia = { storage_path: item.storage_path as string, mime: item.mime as string };
      }
    }
    const agora = new Date().toISOString();
    const { error } = await db.from("messages").insert({
      organization_id: d.org,
      conversation_id: conversaId,
      channel_session_id: chip.channel_session_id,
      contact_id: lead.contact_id,
      external_id: d.externalId,
      type: tipo,
      direction: "outbound",
      status: "sent",
      body: d.texto.trim() || null,
      media_storage_path: midia?.storage_path ?? null,
      media_mime: midia?.mime ?? null,
      sent_via: "automation",
      sent_at: agora,
      metadata: { espelho_do_disparo: true },
    });
    // 23505: o eco do canal (`SEND_MESSAGE` / `fromMe`) chegou antes e já gravou esta mensagem — como
    // "enviada pelo celular", porque o webhook não tem como saber que foi o motor. Não há o que espelhar,
    // mas a linha passa a dizer a verdade: é do motor.
    if (error) {
      if (error.code === "23505" && d.externalId) await assumirEcoDoMotor(db, d.org, d.externalId);
      else logger.error("disparo_espelho_insert_falhou", { organization_id: d.org, lead_id: d.leadId, chip_id: d.chipId, code: error.code });
      return;
    }
    await db
      .from("conversations")
      .update({
        last_outbound_at: agora,
        last_message_at: agora,
        last_message_preview: tipo === "text" ? d.texto.slice(0, 120) : `[${tipo}]`,
      })
      .eq("organization_id", d.org)
      .eq("id", conversaId);
  } catch {
    logger.error("disparo_espelho_falhou", { organization_id: d.org, lead_id: d.leadId, chip_id: d.chipId });
  }
}

export function criarEnvioReal(db: SupabaseClient, ambiente: Record<string, string | undefined>): EnvioReal {
  return async ({ config, chipId, lead, texto, midiaId, presenca }) => {
    if (!envioRealLiberado(config, ambiente)) {
      throw new Error("disparo_trava: envio real não liberado (modo e DISPARO_REAL_LIBERADO)");
    }
    // Defesa em profundidade da allowlist: o motor já barra antes, mas este é o único caminho ao canal.
    if (!destinoPermitido(lead.telefone, ambiente)) throw new Error(`disparo_trava: ${MOTIVO_ALLOWLIST}`);
    let saida;
    try {
      saida = await enviarPeloChip(db, { org: config.organizationId, chipId, canalEsperado: null, telefone: lead.telefone, texto, midiaId, presenca });
    } catch (erro) {
      logger.error("disparo_canal_falhou_sem_espelho", { organization_id: config.organizationId, lead_id: lead.id, chip_id: chipId });
      throw erro;
    }
    await espelharNaConversa(db, { org: config.organizationId, chipId, leadId: lead.id, texto, midiaId, externalId: saida.externalId });
    return saida;
  };
}

/**
 * Aviso ao celular pessoal do operador, pelo chip em que a lead conversa. É o mesmo
 * caminho do `criarEnvioReal` (`enviarPeloChip`) e as MESMAS travas: modo real E
 * DISPARO_REAL_LIBERADO=sim, mais a allowlist `DISPARO_SO_PARA` — com ela definida, o
 * número do operador também tem de estar na lista, senão o aviso é barrado. Só texto.
 */
export function criarEnvioDeAviso(db: SupabaseClient, ambiente: Record<string, string | undefined>): EnvioDeAviso {
  return async ({ config, chipId, canalId, destino, texto }) => {
    if (!envioRealLiberado(config, ambiente)) {
      throw new Error("disparo_trava: envio real não liberado (modo e DISPARO_REAL_LIBERADO)");
    }
    if (!destinoPermitido(destino, ambiente)) throw new Error(`disparo_trava: ${MOTIVO_ALLOWLIST}`);
    return enviarPeloChip(db, { org: config.organizationId, chipId, canalEsperado: canalId, telefone: destino, texto, midiaId: null });
  };
}
