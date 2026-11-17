/**
 * Cliente mínimo da Evolution API v2 — só o que o adapter usa.
 *
 * Referência de formato: o cliente do um CRM anterior (`src/lib/evolution.ts`),
 * que fala com a mesma API em produção há meses. Autenticação por header
 * `apikey` — NUNCA em query string (doutrina do CLAUDE.md: vaza em log).
 *
 * Funções puras sobre `EvolutionCredentials`: não consultam banco, não decidem
 * regra de negócio. Os erros lançam `evolution_<status>: <corpo truncado>` — o
 * PREFIXO é o contrato (o adapter lê o status HTTP dele, como `statusHttpDoErroWaha`).
 */
import type { EvolutionCredentials } from "./credentials";

const TIMEOUT_PADRAO_MS = 30_000;
const TIMEOUT_MIDIA_MS = 120_000;
const TIMEOUT_ESTADO_MS = 5_000;

/** `evolution_404: {...}` → 404. Lê o PREFIXO, não varre o corpo anexado. */
export function statusHttpDoErroEvolution(msg: string): number | null {
  const m = /^evolution_(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : null;
}

async function chamar<T>(
  creds: EvolutionCredentials,
  metodo: "GET" | "POST" | "DELETE",
  caminho: string,
  corpo?: unknown,
  limiteMs = TIMEOUT_PADRAO_MS,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${creds.baseUrl}${caminho}/${encodeURIComponent(creds.instance)}`, {
    method: metodo,
    headers: {
      apikey: creds.apiKey,
      ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(limiteMs)]) : AbortSignal.timeout(limiteMs),
  });
  if (!res.ok) {
    throw new Error(`evolution_${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface RespostaDeEnvio {
  key?: { id?: string };
}

/** O id que a Evolution devolve no envio — o `external_id` que o webhook repete. */
export function idDaRespostaDeEnvio(r: unknown): string | null {
  const id = (r as RespostaDeEnvio | null)?.key?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function enviarTexto(
  creds: EvolutionCredentials,
  input: { number: string; text: string; replyToExternalId?: string | null },
): Promise<unknown> {
  return chamar(creds, "POST", "/message/sendText", {
    number: input.number,
    text: input.text,
    linkPreview: false,
    // Citação: a Evolution quer a chave da mensagem citada. Só o id é o que
    // temos (o `external_id` da linha), e basta para ela montar a referência.
    ...(input.replyToExternalId ? { quoted: { key: { id: input.replyToExternalId } } } : {}),
  });
}

/** Tipo de mídia que a Evolution entende, a partir do `kind` do envelope. */
export function mediatypeDe(kind: string): "image" | "video" | "document" {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  return "document";
}

const EXTENSAO_DO_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
};

/**
 * A Evolution 2.3.7 ignora o `mimetype` do corpo e deduz o tipo pelo nome do arquivo (`mime.lookup`).
 * Nome sem a extensão certa vira `mimetype: "false"` e o WhatsApp nunca entrega a mídia. Daí a extensão.
 */
function nomeComExtensao(nome: string | null | undefined, mime: string): string {
  const base = nome?.trim() || "arquivo";
  const ext = EXTENSAO_DO_MIME[mime.toLowerCase()];
  if (!ext) return base;
  const atual = /\.([a-z0-9]+)$/i.exec(base)?.[1]?.toLowerCase();
  const equivalente = ext === "jpg" ? ["jpg", "jpeg"] : [ext];
  return atual && equivalente.includes(atual) ? base : `${base}.${ext}`;
}

export async function enviarMidia(
  creds: EvolutionCredentials,
  input: {
    number: string;
    kind: string;
    url: string;
    mime: string;
    filename?: string | null;
    caption?: string | null;
  },
): Promise<unknown> {
  return chamar(
    creds,
    "POST",
    "/message/sendMedia",
    {
      number: input.number,
      mediatype: mediatypeDe(input.kind),
      mimetype: input.mime,
      // A API aceita URL pública ou base64 no mesmo campo.
      media: input.url,
      fileName: nomeComExtensao(input.filename, input.mime),
      ...(input.caption ? { caption: input.caption } : {}),
    },
    TIMEOUT_MIDIA_MS,
  );
}

/** Bolha de voz. `encoding: true` pede à Evolution a conversão para ogg/opus. */
export async function enviarAudio(
  creds: EvolutionCredentials,
  input: { number: string; url: string },
): Promise<unknown> {
  return chamar(
    creds,
    "POST",
    "/message/sendWhatsAppAudio",
    { number: input.number, audio: input.url, encoding: true },
    TIMEOUT_MIDIA_MS,
  );
}

/** Teto da presença: a Evolution segura a chamada enquanto ela dura. */
export const PRESENCA_MAX_MS = 25_000;

/**
 * "digitando…"/"gravando áudio…" por `delayMs` (até 25 s). A Evolution só responde quando o tempo acaba, então o
 * limite da chamada é o tempo da presença mais uma folga.
 */
export async function enviarPresenca(
  creds: EvolutionCredentials,
  input: { number: string; presence: "composing" | "recording"; delayMs: number },
): Promise<void> {
  const delay = Math.max(0, Math.min(input.delayMs, PRESENCA_MAX_MS));
  await chamar(creds, "POST", "/chat/sendPresence", { number: input.number, presence: input.presence, delay }, delay + 10_000);
}

/** `open` = conectado; `connecting`/`close` = mensagem não entra nem sai. */
export async function estadoDaInstancia(creds: EvolutionCredentials, signal?: AbortSignal): Promise<string | null> {
  const r = await chamar<{ instance?: { state?: string }; state?: string }>(
    creds,
    "GET",
    "/instance/connectionState",
    undefined,
    TIMEOUT_ESTADO_MS,
    signal,
  );
  const estado = r.instance?.state ?? r.state;
  return typeof estado === "string" ? estado : null;
}

/** Leitura de histórico: mais folga que a consulta de estado, bem menos que o envio de mídia. */
const TIMEOUT_LEITURA_MS = 15_000;

export interface PaginaDeMensagens {
  total: number;
  paginas: number;
  /** Os registros crus da tabela `Message` da Evolution (key, pushName, messageType, message, messageTimestamp…). */
  registros: unknown[];
}

function inteiroOuZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Mensagens gravadas na instância numa janela de tempo (`POST /chat/findMessages`). SÓ LEITURA.
 *
 * Contrato da 2.3.7 (`fetchMessages`): `where.messageTimestamp` só filtra com `gte` E `lte`;
 * `page` é 1-based e `offset` é o TAMANHO da página; ordem do mais novo para o mais velho.
 * `where.key.fromMe: false` é ignorado por ela (valor falsy), por isso a direção é filtrada
 * por quem chama. Resposta fora de forma vira página vazia: quem chama conta "zero lidas".
 */
export async function buscarMensagens(
  creds: EvolutionCredentials,
  input: { desde: Date; ate: Date; pagina: number; porPagina: number },
): Promise<PaginaDeMensagens> {
  const r = await chamar<{ messages?: { total?: unknown; pages?: unknown; records?: unknown } } | null>(
    creds,
    "POST",
    "/chat/findMessages",
    {
      where: { messageTimestamp: { gte: input.desde.toISOString(), lte: input.ate.toISOString() } },
      page: input.pagina,
      offset: input.porPagina,
    },
    TIMEOUT_LEITURA_MS,
  );
  const m = r?.messages;
  if (!m || !Array.isArray(m.records)) return { total: 0, paginas: 0, registros: [] };
  return { total: inteiroOuZero(m.total), paginas: inteiroOuZero(m.pages), registros: m.records };
}

export async function baixarMidia(
  creds: EvolutionCredentials,
  idMensagem: string,
): Promise<{ base64: string; mimetype: string | null } | null> {
  const r = await chamar<{ base64?: string; mimetype?: string }>(
    creds,
    "POST",
    "/chat/getBase64FromMediaMessage",
    { message: { key: { id: idMensagem } } },
    TIMEOUT_MIDIA_MS,
  );
  if (!r.base64) return null;
  return { base64: r.base64, mimetype: r.mimetype ?? null };
}

export async function fotoDePerfil(
  creds: EvolutionCredentials,
  number: string,
): Promise<string | null> {
  const r = await chamar<{ profilePictureUrl?: string | null }>(
    creds,
    "POST",
    "/chat/fetchProfilePictureUrl",
    { number },
  );
  return r.profilePictureUrl || null;
}

/** Preserva os ajustes editáveis da instância; falhar não impede o socorro por QR. */
export async function prepararInstancia(creds: EvolutionCredentials): Promise<string | null> {
  try {
    const settings = await chamar<Record<string, unknown> | null>(creds, "GET", "/settings/find", undefined, 3_000);
    if (!settings || typeof settings.syncFullHistory !== "boolean") throw new Error("evolution_settings_unavailable");
    // wavoipToken é somente de leitura; não reenviar campos privados ou desconhecidos.
    const campos = ["rejectCall", "msgCall", "groupsIgnore", "alwaysOnline", "readMessages", "readStatus"];
    const body = Object.fromEntries(campos.filter((key) => key in settings).map((key) => [key, settings[key]]));
    await chamar(creds, "POST", "/settings/set", { ...body, syncFullHistory: false }, 3_000);
    return null;
  } catch {
    return "Não foi possível desativar a sincronização do histórico. O pareamento pode continuar; confira as configurações do serviço.";
  }
}

/**
 * Cria a instância no servidor Evolution (`POST /instance/create`). Única chamada que NÃO leva o nome da
 * instância no caminho (ele vai no corpo), por isso não passa por `chamar`. O QR sai depois, por
 * `conectarInstancia`. Nome já em uso (403) é `ja_existia`, não erro: criar a mesma conexão duas vezes
 * (clique repetido, reenvio) precisa dar a mesma instância.
 */
export async function criarInstancia(
  servidor: { baseUrl: string; apiKey: string },
  instanceName: string,
): Promise<"criada" | "ja_existia"> {
  const res = await fetch(`${servidor.baseUrl}/instance/create`, {
    method: "POST",
    headers: { apikey: servidor.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: false }),
    signal: AbortSignal.timeout(TIMEOUT_PADRAO_MS),
  });
  if (res.ok) return "criada";
  const corpo = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 403 && /already in use|já está em uso/i.test(corpo)) return "ja_existia";
  throw new Error(`evolution_${res.status}: ${corpo}`);
}

/** Solicita o QR e o código atuais. O chamador forçado prepara ANTES do logout. */
export async function conectarInstancia(creds: EvolutionCredentials, configurada = false): Promise<{ base64?: string; pairingCode?: string; warning: string | null }> {
  const warning = configurada ? null : await prepararInstancia(creds);
  const resposta = await chamar<{ base64?: string; pairingCode?: string }>(creds, "GET", "/instance/connect", undefined, 10_000);
  return { ...resposta, warning };
}

/** Encerra a sessão sem excluir a instância. */
export async function deslogarInstancia(creds: EvolutionCredentials): Promise<void> {
  await chamar(creds, "DELETE", "/instance/logout", undefined, 5_000);
}

/** Remove a instância do servidor (a 2.3.7 desloga antes, se ela estiver aberta). */
export async function excluirInstancia(creds: EvolutionCredentials): Promise<void> {
  await chamar(creds, "DELETE", "/instance/delete", undefined, 5_000);
}

/** Teto real inclui consultas em andamento; aborta a última ao vencer o prazo. */
export async function aguardarInstanciaFechada(creds: EvolutionCredentials): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("evolution_logout_timeout")); }, 10_000);
  });
  const poll = async () => {
    while (!controller.signal.aborted) {
      if (await estadoDaInstancia(creds, controller.signal) === "close") return;
      if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("evolution_logout_timeout");
  };
  try { await Promise.race([poll(), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

/**
 * Os eventos que o CRM consome (`./webhook.ts`). `MESSAGES_UPSERT` e `CONNECTION_UPDATE`
 * eram os únicos assinados; sem os demais, a mensagem enviada pelo celular, a ligação,
 * o status de entrega, a edição e a exclusão nunca chegavam — sem erro em lugar nenhum.
 */
export const EVENTOS_DO_WEBHOOK = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "MESSAGES_DELETE",
  // Edição avulsa (existe na 2.3.7 em uso: `messages.edited` no dist). A tradução a entende.
  "MESSAGES_EDITED",
  "SEND_MESSAGE",
  "CONNECTION_UPDATE",
  "CALL",
] as const;

/**
 * O servidor Evolution desta instalação entrega TODOS os eventos por um webhook global
 * (`WEBHOOK_GLOBAL_*` no compose do instalador), e a Evolution não expõe essa configuração
 * pela API. Quem sabe é o ambiente: `EVOLUTION_WEBHOOK_GLOBAL` = `true` (o instalador grava).
 * Com ele, instância sem webhook PRÓPRIO é o estado normal, não um defeito a avisar.
 */
export function webhookGlobalLigado(): boolean {
  return ["1", "true", "sim", "on"].includes((process.env.EVOLUTION_WEBHOOK_GLOBAL || "").trim().toLowerCase());
}

interface WebhookDaInstancia {
  url?: unknown;
  enabled?: unknown;
  headers?: unknown;
  events?: unknown;
  webhookByEvents?: unknown;
  webhookBase64?: unknown;
}

/**
 * Garante que o webhook da instância assina `EVENTOS_DO_WEBHOOK`, SEM novo QR.
 *
 * Lê a configuração atual e só ACRESCENTA eventos: URL, cabeçalhos, formato e os
 * eventos que já estavam (ex.: `QRCODE_UPDATED`) são devolvidos como vieram. A URL
 * nunca é inventada aqui — ela carrega o token do caminho, e quem a cadastrou foi a
 * conexão; sem URL o webhook não existe, e isso é aviso, não conserto silencioso —
 * salvo com o webhook GLOBAL do servidor ligado (`webhookGlobalLigado`), onde a lista de
 * eventos vem do compose e não há nada a acrescentar na instância.
 * Já completo, não escreve nada.
 *
 * Mesma forma de `prepararInstancia`: falhar devolve um aviso (sem o corpo do
 * servidor) e nunca impede a reconexão.
 */
export async function assinarEventosDoWebhook(creds: EvolutionCredentials): Promise<string | null> {
  try {
    const atual = await chamar<WebhookDaInstancia | null>(creds, "GET", "/webhook/find", undefined, 3_000);
    const url = typeof atual?.url === "string" ? atual.url.trim() : "";
    if (!url) {
      // Webhook global: os eventos chegam pela URL do servidor, não por uma da instância.
      if (webhookGlobalLigado()) return null;
      return "Esta conexão não tem webhook cadastrado no serviço de WhatsApp: o CRM não recebe as mensagens dela. Confira a configuração do serviço.";
    }
    const jaAssinados = Array.isArray(atual?.events) ? atual.events.filter((e): e is string => typeof e === "string") : [];
    const faltam = EVENTOS_DO_WEBHOOK.filter((e) => !jaAssinados.includes(e));
    if (faltam.length === 0) return null;
    await chamar(
      creds,
      "POST",
      "/webhook/set",
      {
        webhook: {
          enabled: atual?.enabled !== false,
          url,
          ...(atual?.headers && typeof atual.headers === "object" ? { headers: atual.headers } : {}),
          byEvents: atual?.webhookByEvents === true,
          base64: atual?.webhookBase64 === true,
          events: [...jaAssinados, ...faltam],
        },
      },
      3_000,
    );
    return null;
  } catch {
    return "Não foi possível atualizar os eventos que o WhatsApp avisa ao CRM (mensagens enviadas pelo celular, ligações, edições e exclusões). A conexão segue; tente Reconectar de novo mais tarde.";
  }
}
