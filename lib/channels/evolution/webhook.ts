/**
 * Webhook de entrada da Evolution API v2 — contrato do fio e tradução para o
 * formato interno.
 *
 * ─── Por que traduzir para o envelope do WAHA, e não escrever uma ingestão ─────
 *
 * Os dois canais falam com o WhatsApp Web (Baileys) por baixo: o `data` de um
 * `messages.upsert` da Evolution é, campo a campo, o `_data` que o WAHA/NOWEB
 * entrega (`key.remoteJid`, `key.remoteJidAlt`, `pushName`, `message.*Message`).
 * A ingestão do WAHA (`lib/waha/ingest.ts`) já resolve identidade (phone/@lid),
 * dedup por `external_id`, eco do próprio envio, pausa da IA por digitação no
 * celular, opt-out e despacho do agente — 1000 linhas de regra aprendida com
 * defeito real. Reescrever isso aqui seria perder paridade de comportamento sem
 * perceber; traduzir o formato e reaproveitar é a mesma escolha do adapter WAHA
 * ("o mais burro possível").
 *
 * O que esta tradução decide, e só isso:
 *   - o NOME do evento (`messages.upsert` e `send.message` → `message`,
 *     `connection.update` → `session.status`, edição → `message.edited`,
 *     exclusão → `message.revoked`, ...);
 *   - a LIGAÇÃO (`call`) não vira envelope: sai em `ligacoes` e vira nota de
 *     tela (`type=system`) em `./ligacoes.ts` — nunca mensagem;
 *   - o id da mensagem é o id CRU do Baileys (`key.id`), o mesmo que o envio
 *     devolve em `key.id` — por isso o eco casa por `external_id` sem precisar
 *     de `echoExternalIds`;
 *   - a mídia vira uma referência `evolution-media:<id>`: a Evolution não expõe
 *     URL pública do anexo, o adapter baixa por `getBase64FromMediaMessage`.
 *
 * ─── O contrato é LOOSE, pela mesma razão do WAHA ──────────────────────────────
 * Webhook real traz campo que ninguém catalogou; `.strict()` transformaria
 * "mensagem entra" em "mensagem descartada". Só ganham tipo os campos que o
 * código lê sem guarda própria.
 */
import { z } from "zod";

import { logger } from "@/lib/logger";
import { parseVcard } from "@/lib/messaging/contact-card";
import { lerEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";
import type { WahaEnvelope } from "@/lib/waha/envelope";

const texto = z.string().nullish();
const booleano = z.boolean().nullish();

/** O envelope externo: o mínimo para saber de quem é o evento e o que ele é. */
export const evolutionEnvelopeSchema = z.looseObject({
  event: z.string(),
  instance: z.string(),
  // `unknown().optional()`: no Zod 4 um `unknown` solto é OBRIGATÓRIO.
  data: z.unknown().optional(),
});
export type EvolutionEnvelope = z.infer<typeof evolutionEnvelopeSchema>;

export function lerEnvelopeEvolution(rawBody: string): LeituraDeEnvelope<EvolutionEnvelope> {
  return lerEnvelope(rawBody, evolutionEnvelopeSchema);
}

const chaveSchema = z.looseObject({
  remoteJid: texto,
  remoteJidAlt: texto,
  participant: texto,
  participantAlt: texto,
  fromMe: booleano,
  id: texto,
});

const mensagemSchema = z.looseObject({
  key: chaveSchema,
  pushName: texto,
  message: z.unknown().optional(),
  messageType: texto,
  messageTimestamp: z.unknown().optional(),
});
type MensagemEvolution = z.infer<typeof mensagemSchema>;

const atualizacaoSchema = z.looseObject({
  keyId: texto,
  messageId: texto,
  remoteJid: texto,
  // Algumas versões trazem o chat só dentro de `key`.
  key: z.looseObject({ remoteJid: texto }).nullish(),
  fromMe: booleano,
  status: texto,
});

const exclusaoSchema = z.looseObject({
  id: texto,
  keyId: texto,
  remoteJid: texto,
  key: z.looseObject({ remoteJid: texto }).nullish(),
});

/** Ligação (`WACallEvent` do Baileys). `date` chega como ISO (Date serializado) ou epoch. */
const chamadaSchema = z.looseObject({
  id: texto,
  chatId: texto,
  from: texto,
  status: texto,
  isGroup: booleano,
  groupJid: texto,
  isVideo: booleano,
  fromMe: booleano,
  callerPn: texto,
  date: z.unknown().optional(),
});

/** Ligação vista no lote: a ingestão a grava como nota de tela (`./ligacoes.ts`). */
export interface LigacaoVista {
  id: string;
  /** O chat do outro lado (JID). */
  chat: string;
  /** Quem iniciou, quando o evento diz (JID). */
  de: string | null;
  /** Telefone de quem ligou, quando o chat é `@lid`. */
  telefone: string | null;
  /** `offer`, `ringing`, `accept`, `reject`, `timeout`, `terminate` (minúsculo). */
  estado: string;
  /** ISO; null se o evento não trouxe hora legível. */
  quando: string | null;
  video: boolean;
  /** O evento afirma que a ligação saiu deste número. */
  fromMe: boolean;
}

const conexaoSchema = z.looseObject({
  state: texto,
  instance: texto,
  // 428 (precondition required) e 401 (logout) chegam aqui; o freio de saúde do motor de disparo os lê.
  statusReason: z.unknown().optional(),
});

/** Estado de conexão como o freio de saúde o guarda: minúsculo, com o código quando houver. */
export interface ConexaoVista {
  estado: string;
  codigo: number | null;
}

function codigoDe(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

/** `MESSAGES_UPSERT` e `messages.upsert` são o mesmo evento, conforme a config. */
export function eventoCanonico(evento: string): string {
  return evento.trim().toLowerCase().replace(/_/g, ".");
}

/** O `state` da Evolution → o vocabulário de status do CRM (uppercase). */
export function statusDoEstado(estado: string | null | undefined): string | null {
  switch ((estado ?? "").toLowerCase()) {
    case "open":
      return "WORKING";
    case "connecting":
      return "STARTING";
    case "close":
    case "closed":
      return "STOPPED";
    default:
      return null;
  }
}

/** Status de entrega da Evolution → o `ack` numérico que a ingestão grava. */
export function ackDoStatus(status: string | null | undefined): number | null {
  switch ((status ?? "").toUpperCase()) {
    case "PENDING":
      return 0;
    case "SERVER_ACK":
      return 1;
    case "DELIVERY_ACK":
      return 2;
    case "READ":
      return 3;
    case "PLAYED":
      return 4;
    default:
      // ERROR e vocabulário novo: sem ack. Inventar um número rebaixaria o
      // status de uma mensagem que já foi entregue.
      return null;
  }
}

const SEM_CONTATO = /@(newsletter|broadcast)$/;

/** Chat que nunca vira conversa: status, canal e lista de transmissão. */
function chatIgnorado(jid: string): boolean {
  return jid === "status@broadcast" || SEM_CONTATO.test(jid);
}

/**
 * O chat nunca vira contato NO CRM: grupo (`@g.us`), status, canal e lista de
 * transmissão. Grupo é decisão de produto ("grupos não fazem binding CRM"), e
 * a ingestão já o descartava — só que DEPOIS de arquivar o corpo cru.
 */
function jidSemContato(jid: unknown): boolean {
  return typeof jid === "string" && (jid.endsWith("@g.us") || chatIgnorado(jid));
}

/**
 * Este webhook inteiro é de chat sem contato? Respondido ANTES de qualquer
 * escrita, para o descarte não custar uma linha de 10 KB em `webhook_events_log`
 * (medido: 11.806 de 11.811 eventos de mensagem eram de grupo).
 *
 * Entram os eventos que carregam um chat (`EVENTOS_COM_CHAT`: mensagem recebida
 * e enviada, status/edição, exclusão, edição avulsa e ligação): o resto —
 * `connection.update`, QR, logout — alimenta a saúde do chip e segue o caminho
 * normal. E só se TODOS os itens forem sem contato: um lote com uma
 * conversa individual no meio é processado inteiro. Corpo ilegível ou fora de
 * forma devolve `false`, para o caminho normal arquivá-lo e recusá-lo.
 */
export function webhookSoDeChatSemContato(rawBody: string): boolean {
  const r = separarChatsSemContato(rawBody);
  return r !== null && r.mantidos.length === 0;
}

/** Eventos cujo `data` é a mensagem inteira (`key` + `message`): a recebida e a enviada pela API. */
const EVENTOS_DE_MENSAGEM = new Set(["messages.upsert", "send.message"]);

/** O item é de chat sem contato (grupo, status, canal, transmissão)? */
function itemSemContato(evento: string, item: Record<string, unknown>): boolean {
  const chave = item.key && typeof item.key === "object" ? (item.key as Record<string, unknown>) : null;
  if (EVENTOS_DE_MENSAGEM.has(evento)) return jidSemContato(chave?.remoteJid);
  if (evento === "call") {
    // Ligação em grupo pode vir só com `isGroup: true`, sem `@g.us` em lugar nenhum do corpo.
    return item.isGroup === true || [item.groupJid, item.chatId, item.from].some(jidSemContato);
  }
  return jidSemContato(item.remoteJid) || jidSemContato(chave?.remoteJid);
}

const EVENTOS_COM_CHAT = new Set([...EVENTOS_DE_MENSAGEM, "messages.update", "messages.delete", "messages.edited", "call"]);

/** Ligação de grupo pode não citar `@g.us`: o pré-filtro também olha a marca `isGroup`. */
const MARCA_DE_GRUPO = /"isGroup"\s*:\s*true/;

/**
 * Separa os itens de um lote de mensagens entre os de chat sem contato (grupo,
 * status, canal, transmissão) e os demais. `null` = não é lote de mensagens
 * legível (corpo ilegível, fora de forma, ou outro evento): segue o caminho normal.
 */
function separarChatsSemContato(
  rawBody: string,
): { envelope: Record<string, unknown>; mantidos: unknown[]; removidos: number } | null {
  // Pré-filtro barato: quase toda mensagem individual não cita nenhum destes.
  if (
    !rawBody.includes("@g.us") &&
    !rawBody.includes("@newsletter") &&
    !rawBody.includes("@broadcast") &&
    !MARCA_DE_GRUPO.test(rawBody)
  ) {
    return null;
  }
  const leitura = lerEnvelopeEvolution(rawBody);
  if (!leitura.ok) return null;
  const evento = eventoCanonico(leitura.envelope.event);
  if (!EVENTOS_COM_CHAT.has(evento)) return null;

  const itens = itensDe(leitura.envelope.data);
  if (itens.length === 0) return null;
  const mantidos = itens.filter((item) => {
    if (!item || typeof item !== "object") return true; // fora de forma: o caminho normal conta como descartado
    return !itemSemContato(evento, item as Record<string, unknown>);
  });
  return { envelope: leitura.envelope as Record<string, unknown>, mantidos, removidos: itens.length - mantidos.length };
}

/**
 * O corpo do webhook SEM os itens de chat sem contato. REGRA ABSOLUTA: grupo
 * nunca é gravado — nem mensagem, nem contato, nem log —, e o filtro de lote
 * inteiro (`webhookSoDeChatSemContato`) deixava passar o grupo que vem num lote
 * misto, com conteúdo e participantes, para `webhook_events_log`. Sem grupo no
 * lote devolve o corpo ORIGINAL, byte a byte. Nunca lança.
 */
export function corpoSemChatsSemContato(rawBody: string): string {
  const r = separarChatsSemContato(rawBody);
  if (!r || r.removidos === 0 || r.mantidos.length === 0) return rawBody;
  const { data, ...resto } = r.envelope;
  return JSON.stringify({ ...resto, data: Array.isArray(data) ? r.mantidos : r.mantidos[0] });
}

type Conteudo = Record<string, unknown>;

/** Mensagem efêmera / visualização única embrulha o conteúdo real uma camada abaixo. */
function desembrulhar(msg: unknown): Conteudo {
  let atual: unknown = msg;
  for (let i = 0; i < 3; i++) {
    if (!atual || typeof atual !== "object") return {};
    const o = atual as Conteudo;
    const interno = [o.ephemeralMessage, o.viewOnceMessage, o.viewOnceMessageV2]
      .map((w) => (w && typeof w === "object" ? (w as { message?: unknown }).message : undefined))
      .find((m) => m && typeof m === "object");
    if (!interno) return o;
    atual = interno;
  }
  return atual && typeof atual === "object" ? (atual as Conteudo) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function campo(o: unknown, nome: string): unknown {
  return o && typeof o === "object" ? (o as Conteudo)[nome] : undefined;
}

const TIPOS_COM_MIDIA = [
  "imageMessage",
  "videoMessage",
  "ptvMessage",
  "audioMessage",
  "documentMessage",
  "documentWithCaptionMessage",
  "stickerMessage",
] as const;

function numeroOuNulo(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Localização compartilhada → texto legível. Sem isto a mensagem chegava sem
 * corpo nem mídia e a ingestão a descartava pela guarda de corpo vazio.
 */
function textoDeLocalizacao(conteudo: Conteudo): string | null {
  const loc = conteudo.locationMessage ?? conteudo.liveLocationMessage;
  if (!loc || typeof loc !== "object") return null;
  const lat = numeroOuNulo(campo(loc, "degreesLatitude"));
  const lng = numeroOuNulo(campo(loc, "degreesLongitude"));
  const nome = str(campo(loc, "name"));
  const endereco = str(campo(loc, "address"));
  const partes = [nome, endereco].filter((x): x is string => !!x).join(" — ");
  const coords = lat !== null && lng !== null ? `(${lat}, ${lng})` : "";
  return ["[Localização]", partes, coords].filter(Boolean).join(" ");
}

/** As partes não vazias, uma por linha; null se nenhuma. */
function linhas(...partes: Array<string | null>): string | null {
  const ok = partes.filter((p): p is string => !!p && p.trim().length > 0);
  return ok.length ? ok.join("\n") : null;
}

/** Template de empresa (o lead lê título, conteúdo e rodapé). */
function textoDeTemplate(conteudo: Conteudo): string | null {
  const t = conteudo.templateMessage;
  if (!t || typeof t !== "object") return null;
  for (const forma of ["hydratedTemplate", "hydratedFourRowTemplate"]) {
    const h = campo(t, forma);
    const texto = linhas(
      str(campo(h, "hydratedTitleText")),
      str(campo(h, "hydratedContentText")),
      str(campo(h, "hydratedFooterText")),
    );
    if (texto) return texto;
  }
  return textoInterativo(campo(t, "interactiveMessageTemplate"));
}

/** `interactiveMessage` e o template interativo: cabeçalho, corpo e rodapé. */
function textoInterativo(m: unknown): string | null {
  if (!m || typeof m !== "object") return null;
  return linhas(
    str(campo(campo(m, "header"), "title")),
    str(campo(campo(m, "body"), "text")),
    str(campo(campo(m, "footer"), "text")),
  );
}

/** Enquete criada pelo contato: a pergunta e as opções que ele ofereceu. */
function textoDeEnquete(conteudo: Conteudo): string | null {
  const e = conteudo.pollCreationMessage ?? conteudo.pollCreationMessageV2 ?? conteudo.pollCreationMessageV3;
  if (!e || typeof e !== "object") return null;
  const opcoes = Array.isArray(campo(e, "options"))
    ? (campo(e, "options") as unknown[]).map((o) => str(campo(o, "optionName"))).filter((o): o is string => !!o)
    : [];
  const pergunta = str(campo(e, "name"));
  return ["[Enquete]", pergunta, opcoes.length ? `(${opcoes.join(" / ")})` : null].filter(Boolean).join(" ");
}

/**
 * Vários cartões de contato numa mensagem só. Diferente do `contactMessage`
 * (um cartão), que segue como vCard cru para a ingestão — a tela o desenha
 * como cartão a partir do corpo (`lib/messaging/contact-card.ts`).
 */
function textoDeContatos(conteudo: Conteudo): string | null {
  const a = conteudo.contactsArrayMessage;
  if (!a || typeof a !== "object") return null;
  const cartoes = Array.isArray(campo(a, "contacts")) ? (campo(a, "contacts") as unknown[]) : [];
  const nomes = cartoes
    .map((c) => {
      const card = parseVcard(str(campo(c, "vcard")));
      const nome = card?.name ?? str(campo(c, "displayName"));
      const tel = card?.phone_number || null;
      return nome && tel && nome !== tel ? `${nome} (${tel})` : (nome ?? tel);
    })
    .filter((n): n is string => !!n);
  return ["[Contatos]", nomes.join(", ") || str(campo(a, "displayName"))].filter(Boolean).join(" ");
}

/** O texto que o atendente lê: texto puro, legenda, resposta de botão/lista, template, enquete. */
export function textoDaMensagem(conteudo: Conteudo): string | null {
  return (
    str(conteudo.conversation) ??
    str(campo(conteudo.extendedTextMessage, "text")) ??
    str(campo(conteudo.imageMessage, "caption")) ??
    str(campo(conteudo.videoMessage, "caption")) ??
    str(campo(conteudo.documentMessage, "caption")) ??
    str(campo(conteudo.buttonsResponseMessage, "selectedDisplayText")) ??
    str(campo(conteudo.templateButtonReplyMessage, "selectedDisplayText")) ??
    str(campo(conteudo.listResponseMessage, "title")) ??
    str(campo(conteudo.listResponseMessage, "description")) ??
    str(campo(campo(conteudo.interactiveResponseMessage, "body"), "text")) ??
    textoInterativo(conteudo.interactiveMessage) ??
    textoDeTemplate(conteudo) ??
    textoDeEnquete(conteudo) ??
    textoDeContatos(conteudo) ??
    textoDeLocalizacao(conteudo) ??
    null
  );
}

/**
 * Chaves de `message` que NÃO são mensagem de ninguém — ficam sem texto e a
 * ingestão as descarta como antes:
 *   - `messageContextInfo`: metadados que acompanham o conteúdo real;
 *   - `senderKeyDistributionMessage`: troca de chave de criptografia;
 *   - `protocolMessage`: apagar, mensagem temporária, sincronização, edição;
 *   - `editedMessage`: edição de mensagem que já existe (não é mensagem nova);
 *   - `reactionMessage` / `encReactionMessage`: reação a mensagem existente;
 *   - `pollUpdateMessage`: voto CRIPTOGRAFADO numa enquete — ilegível aqui;
 *   - `keepInChatMessage` / `pinInChatMessage`: fixar/guardar mensagem existente;
 *   - `albumMessage`: cabeçalho de álbum — cada foto chega como mensagem própria;
 *   - `contactMessage`: não é técnico, mas já entra pela ingestão (vCard cru).
 * Edição e "apagar para todos" que chegam como protocolo viram `message.edited` /
 * `message.revoked` ANTES desta lista ser consultada (`protocoloDoConteudo`).
 * A ligação não chega como mensagem: tem evento próprio (`call`).
 */
const CHAVES_SEM_MENSAGEM = new Set([
  "messageContextInfo",
  "senderKeyDistributionMessage",
  "protocolMessage",
  "editedMessage",
  "reactionMessage",
  "encReactionMessage",
  "pollUpdateMessage",
  "keepInChatMessage",
  "pinInChatMessage",
  "albumMessage",
  "contactMessage",
]);

/** O primeiro tipo de conteúdo que não sabemos ler; null se só há envelope técnico. */
function tipoNaoSuportado(conteudo: Conteudo): string | null {
  for (const [chave, valor] of Object.entries(conteudo)) {
    if (CHAVES_SEM_MENSAGEM.has(chave)) continue;
    // Escalares soltos (`base64`, `mediaUrl` que a Evolution acrescenta) não são tipo.
    if (valor && typeof valor === "object") return chave;
  }
  return null;
}

/**
 * Edição e "apagar para todos" que chegam como PROTOCOLO, não como mensagem nova.
 * `protocolMessage.type` do WhatsApp: 14 = MESSAGE_EDIT (o texto novo vem em
 * `editedMessage`), 0 = REVOKE. O `key.id` do protocolo é o da mensagem ORIGINAL —
 * é por ele que a linha é achada; o id do evento não casaria nada.
 */
type Protocolo = { tipo: "edicao"; alvo: string; corpo: string } | { tipo: "exclusao"; alvo: string };

function protocolo(p: unknown): Protocolo | null {
  if (!p || typeof p !== "object") return null;
  const alvo = str(campo(campo(p, "key"), "id"));
  if (!alvo) return null;
  const tipo = campo(p, "type");
  const editada = campo(p, "editedMessage");
  if (editada && typeof editada === "object" && (tipo == null || tipo === 14 || tipo === "MESSAGE_EDIT")) {
    // Edição sem texto legível não zera o corpo: trocar o útil pelo vazio é pior que não aplicar.
    const corpo = textoDaMensagem(desembrulhar(editada));
    return corpo ? { tipo: "edicao", alvo, corpo } : null;
  }
  if (tipo === 0 || tipo === "REVOKE") return { tipo: "exclusao", alvo };
  return null;
}

/** O protocolo dentro do conteúdo de uma mensagem: direto, ou embrulhado em `editedMessage` (Baileys 7). */
function protocoloDoConteudo(msg: unknown): Protocolo | null {
  const c = desembrulhar(msg);
  return protocolo(c.protocolMessage) ?? protocolo(campo(campo(c.editedMessage, "message"), "protocolMessage"));
}

function envelopeDoProtocolo(instancia: string, p: Protocolo): WahaEnvelope {
  return p.tipo === "edicao"
    ? { event: "message.edited", session: instancia, payload: { id: p.alvo, editedMessageId: p.alvo, body: p.corpo } }
    : { event: "message.revoked", session: instancia, payload: { id: p.alvo, revokedMessageId: p.alvo } };
}

/** Hora da ligação: ISO (Date serializado) ou epoch em segundos/milissegundos. */
function quandoDe(v: unknown): string | null {
  const ms =
    typeof v === "string" ? Date.parse(v) : typeof v === "number" && Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function mimeDaMidia(conteudo: Conteudo): string | null {
  for (const tipo of TIPOS_COM_MIDIA) {
    const m = str(campo(conteudo[tipo], "mimetype"));
    if (m) return m;
  }
  return null;
}

/** Epoch em segundos. Aceita número ou string numérica; o resto é "sem hora". */
function timestampDe(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Prefixo da referência de mídia que o adapter sabe resolver. */
export const PREFIXO_MIDIA = "evolution-media:";

/** `evolution-media:<id>` → `<id>`; null para qualquer outra URL. */
export function idDaReferenciaDeMidia(url: string): string | null {
  return url.startsWith(PREFIXO_MIDIA) && url.length > PREFIXO_MIDIA.length
    ? url.slice(PREFIXO_MIDIA.length)
    : null;
}

/** `"sem_id"`: item válido no schema mas sem identidade — contado, não calado. */
function traduzirMensagem(instancia: string, m: MensagemEvolution): WahaEnvelope | "sem_id" | null {
  const k = m.key;
  const jid = k.remoteJid ?? "";
  const id = k.id ?? "";
  // REGRA ABSOLUTA: grupo (@g.us) também não vira envelope, nem num lote misto.
  if (jid && jidSemContato(jid)) return null;
  if (!jid || !id) return "sem_id";

  const conteudo = desembrulhar(m.message);
  const temMidia = TIPOS_COM_MIDIA.some((t) => t in conteudo);
  const fromMe = k.fromMe === true;

  // Mensagem de ENTRADA de tipo que não lemos não pode sumir: sem texto e sem
  // mídia a ingestão a descartava e o evento ia para `processed` (3
  // `templateMessage` perdidos assim em produção, 10/11/2026). Entra com texto
  // fixo e o tipo vai para o log — o tipo, nunca o conteúdo.
  let corpo = textoDaMensagem(conteudo);
  if (!corpo && !temMidia && !fromMe) {
    const tipo = tipoNaoSuportado(conteudo);
    if (tipo) {
      corpo = `[mensagem de tipo não suportado: ${tipo.slice(0, 60)}]`;
      logger.warn("evolution.webhook: tipo de mensagem não suportado entrou como texto fixo", {
        instancia,
        tipo: tipo.slice(0, 60),
      });
    }
  }

  return {
    event: "message",
    session: instancia,
    payload: {
      id,
      // `from` é sempre o CHAT: na ingestão do WAHA, mensagem `fromMe` traz o
      // chat em `from` (NOWEB) e `to` é opcional — mandamos os dois.
      from: jid,
      ...(fromMe ? { to: jid } : {}),
      fromMe,
      body: corpo,
      hasMedia: temMidia,
      ...(temMidia ? { mediaUrl: `${PREFIXO_MIDIA}${id}`, mimetype: mimeDaMidia(conteudo) } : {}),
      timestamp: timestampDe(m.messageTimestamp),
      _data: {
        pushName: m.pushName ?? null,
        message: conteudo,
        key: {
          remoteJidAlt: k.remoteJidAlt ?? null,
          participantAlt: k.participantAlt ?? null,
        },
      },
    },
  };
}

function itensDe(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  return data && typeof data === "object" ? [data] : [];
}

export interface EventosTraduzidos {
  envelopes: WahaEnvelope[];
  /** Itens do `data` que não passaram no contrato — contados, nunca silenciados. */
  descartados: number;
  /** Itens válidos no schema mas sem `key.id` (ou sem `remoteJid`) — contados, nunca silenciados. */
  semId: number;
  /** `message.failed` (status ERROR da Evolution). Fora de `envelopes` de propósito: não é ack. */
  falhas: WahaEnvelope[];
  /** O evento não é um dos que o CRM consome (não é erro). */
  ignorado: boolean;
  /** Mudanças de conexão vistas no lote (não alteram os envelopes; só alimentam a saúde do chip). */
  conexoes: ConexaoVista[];
  /** Ligações vistas no lote. Fora de `envelopes` de propósito: viram nota de tela, nunca mensagem. */
  ligacoes: LigacaoVista[];
}

/**
 * Evolution → envelopes WAHA, um por item do `data`.
 *
 * Item fora do contrato é CONTADO em `descartados` (e a rota o devolve no corpo
 * e no arquivo do webhook), não engolido: o caso que este arquivo existe para
 * evitar é "200 com carimbo de normalidade para mensagem que sumiu".
 */
export function traduzirEvento(envelope: EvolutionEnvelope): EventosTraduzidos {
  const evento = eventoCanonico(envelope.event);
  const instancia = envelope.instance;
  const saida: EventosTraduzidos = {
    envelopes: [],
    descartados: 0,
    semId: 0,
    falhas: [],
    ignorado: false,
    conexoes: [],
    ligacoes: [],
  };

  // `send.message` é o `messageRaw` do que saiu pela API — o mesmo formato do
  // `messages.upsert`. Vira `message` com `fromMe`: a ingestão casa pelo
  // `external_id` com a linha que o composer ou o motor já gravaram (o id que o
  // envio devolveu é este `key.id`) e só grava o que não nasceu aqui.
  if (EVENTOS_DE_MENSAGEM.has(evento)) {
    for (const item of itensDe(envelope.data)) {
      const r = mensagemSchema.safeParse(item);
      if (!r.success) {
        saida.descartados++;
        continue;
      }
      // REGRA ABSOLUTA: grupo nunca vira envelope — nem mensagem, nem edição, nem exclusão.
      if (r.data.key.remoteJid && jidSemContato(r.data.key.remoteJid)) continue;
      const p = protocoloDoConteudo(r.data.message);
      if (p) {
        saida.envelopes.push(envelopeDoProtocolo(instancia, p));
        continue;
      }
      // `send.message` é SEMPRE saída deste número, diga o `key.fromMe` o que disser: tratá-lo
      // como entrada acordaria IA e atendimento para uma mensagem que nós mesmos mandamos.
      const m = evento === "send.message" ? { ...r.data, key: { ...r.data.key, fromMe: true } } : r.data;
      const t = traduzirMensagem(instancia, m);
      if (t === "sem_id") saida.semId++;
      else if (t) saida.envelopes.push(t);
    }
    return saida;
  }

  if (evento === "messages.update") {
    for (const item of itensDe(envelope.data)) {
      const r = atualizacaoSchema.safeParse(item);
      if (!r.success) {
        saida.descartados++;
        continue;
      }
      const id = r.data.keyId ?? r.data.messageId;
      // REGRA ABSOLUTA: grupo é ignorado por completo, também no status de entrega
      // de um lote misto (o filtro de lote só descarta quando TODOS são sem contato).
      if (jidSemContato(r.data.remoteJid) || jidSemContato(r.data.key?.remoteJid)) continue;
      // Edição: o texto novo vem no conteúdo (`message`, ou `update.message` na forma crua
      // do Baileys). O `status` que acompanha não é ack e não é lido.
      const raw = item as Record<string, unknown>;
      const p = protocoloDoConteudo(raw.message) ?? protocoloDoConteudo(campo(raw.update, "message"));
      if (p) {
        saida.envelopes.push(envelopeDoProtocolo(instancia, p));
        continue;
      }
      // Falha de envio: vira `message.failed`, FORA dos acks (nenhum número inventado
      // rebaixa mensagem entregue; quem preserva delivered/read é o handler).
      if (id && r.data.fromMe !== false && (r.data.status ?? "").toUpperCase() === "ERROR") {
        saida.falhas.push({ event: "message.failed", session: instancia, payload: { id } });
        continue;
      }
      const ack = ackDoStatus(r.data.status);
      // Ack de mensagem que NÃO é nossa (recibo de leitura de inbound) não
      // atualiza linha nenhuma; e status sem número não tem o que gravar.
      if (!id || ack === null || r.data.fromMe === false) continue;
      saida.envelopes.push({ event: "message.ack", session: instancia, payload: { id, ack } });
    }
    return saida;
  }

  if (evento === "messages.delete") {
    for (const item of itensDe(envelope.data)) {
      const r = exclusaoSchema.safeParse(item);
      if (!r.success) {
        saida.descartados++;
        continue;
      }
      // REGRA ABSOLUTA: exclusão em grupo de lote misto também não passa.
      if (jidSemContato(r.data.remoteJid) || jidSemContato(r.data.key?.remoteJid)) continue;
      const id = r.data.id ?? r.data.keyId;
      if (id) {
        saida.envelopes.push({
          event: "message.revoked",
          session: instancia,
          payload: { id, revokedMessageId: id },
        });
      }
    }
    return saida;
  }

  // Edição avulsa: o `data` é o próprio protocolo de edição (ou a mensagem que o carrega).
  if (evento === "messages.edited") {
    for (const item of itensDe(envelope.data)) {
      if (!item || typeof item !== "object") {
        saida.descartados++;
        continue;
      }
      if (itemSemContato(evento, item as Record<string, unknown>)) continue;
      const p = protocolo(item) ?? protocoloDoConteudo(campo(item, "message"));
      if (p) saida.envelopes.push(envelopeDoProtocolo(instancia, p));
      else saida.descartados++;
    }
    return saida;
  }

  // Ligação: nota de tela, nunca mensagem. Cada estado (tocou, atendeu, recusou,
  // não atendeu, encerrou) chega como um item; quem junta pelo `id` é `./ligacoes.ts`.
  if (evento === "call") {
    for (const item of itensDe(envelope.data)) {
      const r = chamadaSchema.safeParse(item);
      if (!r.success) {
        saida.descartados++;
        continue;
      }
      // REGRA ABSOLUTA: ligação de grupo não deixa rastro, nem num lote misto.
      if (itemSemContato(evento, r.data)) continue;
      const id = r.data.id;
      const chat = r.data.chatId ?? r.data.from;
      const estado = (r.data.status ?? "").toLowerCase();
      if (!id || !chat || !/^[a-z_]{2,30}$/.test(estado)) {
        saida.semId++;
        continue;
      }
      saida.ligacoes.push({
        id,
        chat,
        de: r.data.from ?? null,
        telefone: r.data.callerPn ?? null,
        estado,
        quando: quandoDe(r.data.date),
        video: r.data.isVideo === true,
        fromMe: r.data.fromMe === true,
      });
    }
    return saida;
  }

  if (evento === "connection.update") {
    const r = conexaoSchema.safeParse(envelope.data);
    if (!r.success) {
      saida.descartados++;
      return saida;
    }
    const estado = (r.data.state ?? "").toLowerCase();
    if (/^[a-z_]{2,30}$/.test(estado)) saida.conexoes.push({ estado, codigo: codigoDe(r.data.statusReason) });
    const status = statusDoEstado(r.data.state);
    if (status) {
      saida.envelopes.push({ event: "session.status", session: instancia, payload: { status } });
    }
    return saida;
  }

  // Logout explícito da instância: não vira envelope (a ingestão não o consome), mas o freio de saúde precisa dele.
  if (evento === "logout.instance") saida.conexoes.push({ estado: "logout", codigo: null });

  saida.ignorado = true;
  return saida;
}
