/**
 * RECONCILIAÇÃO DE ENTRADA do canal Evolution — busca na Evolution as mensagens de entrada que o
 * webhook nunca entregou ao CRM e as passa pelo MESMO caminho de ingestão do webhook.
 *
 * ─── Por que existe (medido em produção) ────────────────────────────────────
 *
 *   - Depois de uma reconexão do chip, a Evolution grava as mensagens que vêm da sincronização
 *     (com a `key` mínima `fromMe,id,remoteJid`) e NÃO as posta como `messages.upsert`. Caso
 *     medido: 15 mensagens de entrada de um chip em 05/11, no banco da Evolution e ausentes de
 *     `messages` e de `webhook_events_log`.
 *   - Com o app fora do ar, a Evolution tenta 10 vezes e desiste ("Tentativa 10/10 falhou"); o
 *     que ela desistiu de entregar some. Em 10/11 o app ficou 41 min fora.
 *
 * ─── O que ela faz ──────────────────────────────────────────────────────────
 *
 * Por sessão Evolution ativa e conectada: lê `POST /chat/findMessages` na janela (24 h por
 * padrão, até 168), descarta grupo/status/canal com a MESMA função do webhook
 * (`webhookSoDeChatSemContato` / `corpoSemChatsSemContato`), deixa de fora o que não tem direção
 * (`fromMe` ausente) e o que é técnico (chamada, reação, protocolo, sem conteúdo), confere quais
 * `external_id` já estão em `messages` da organização, e ingere as ausentes, da mais velha para a
 * mais nova, por `dispatchWahaEvent(..., { recuperada: true })`. A deduplicação é a de sempre:
 * `unique (organization_id, external_id)` + `23505`.
 *
 * ─── O que ela NÃO faz ──────────────────────────────────────────────────────
 *
 *   - Não envia nada, nem faz o sistema enviar: a marca `recuperada` corta despacho do agente,
 *     follow-up, demanda nova, automação e atendimento do motor de disparo. Valem só os efeitos
 *     que PARAM envio (opt-out; o lead conta como "respondeu" porque a linha existe em `messages`).
 *   - A mensagem `fromMe` (enviada pelo celular e perdida pelo webhook) também entra, pelo mesmo
 *     caminho e com a mesma marca. Ela NÃO pausa a IA (o "humano assumiu" de ontem não vale
 *     agora; ver `handleOutboundFromUserPhone`). Continua valendo o que a linha em si significa:
 *     o atendimento do motor a lê como "operador falou com o lead", que só PARA envio.
 *     A deduplicação é a mesma: o que o composer ou o motor gravaram já tem o `external_id`.
 *   - Não altera a instância nem o webhook da Evolution; só chamadas de leitura.
 *
 * Sem estado entre passadas: o que já entrou aparece como "já presente" na passada seguinte, e o
 * teto por passada (200) deixa o resto para a próxima.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { REF_KIND_SESSAO } from "@/lib/channels/health";
import { logger } from "@/lib/logger";
import { mensagemFoiRecuperada } from "@/lib/mensagens/recuperada";
import { dispatchWahaEvent, type OpcoesDeIngestao } from "@/lib/waha/ingest";
import type { WahaEnvelope } from "@/lib/waha/envelope";

import { buscarMensagens, estadoDaInstancia, type PaginaDeMensagens } from "./client";
import { resolveEvolutionCreds, type EvolutionCredentials, type EvolutionCredsLookup } from "./credentials";
import { corpoSemChatsSemContato, traduzirEvento, webhookSoDeChatSemContato } from "./webhook";

export const HORAS_PADRAO = 24;
export const HORAS_MAXIMO = 168;
/** Teto de mensagens INGERIDAS por passada, somando as sessões. O resto fica para a próxima. */
export const TETO_POR_PASSADA = 200;
/** Idade mínima da mensagem para a reconciliação olhar para ela (ver `reconciliarEntrada`). */
const CARENCIA_MS = 3 * 60_000;
const POR_PAGINA = 100;
/** Até 2.000 registros lidos por sessão por passada (a janela de 24 h de um chip tem dezenas). */
const MAX_PAGINAS = 20;
const LOTE_DE_CONSULTA = 100;
const MAX_SESSOES = 50;

export const TITULO_RECUPERADAS = "Mensagens recuperadas da conexão";

/**
 * Tipos que não são conteúdo do lead: chamada (a Evolution grava como `unknown` com `call`),
 * reação, protocolo (apagar, editar, efêmera), distribuição de chave, voto de enquete.
 */
const TIPOS_TECNICOS = new Set([
  "unknown",
  "call",
  "protocolMessage",
  "reactionMessage",
  "encReactionMessage",
  "senderKeyDistributionMessage",
  "pollUpdateMessage",
  "editedMessage",
  "keepInChatMessage",
  "pinInChatMessage",
  "messageContextInfo",
]);

export interface Ignoradas {
  /** Grupo, status, canal ou lista de transmissão: descartados pela função do webhook. */
  grupo_ou_status: number;
  /** `fromMe` ausente: sem saber se entrou ou saiu, não vira nem "do lead" nem "do celular". */
  sem_direcao: number;
  tecnico: number;
}

export type DesfechoDaSessao = "ok" | "desconectada" | "sem_credencial" | "erro";

export interface ResultadoDaSessao {
  channel_session_id: string;
  organization_id: string;
  apelido: string;
  desfecho: DesfechoDaSessao;
  lidas: number;
  ja_presentes: number;
  ausentes: number;
  ignoradas: Ignoradas;
  /** Ingeridas de fato nesta passada (a linha existe agora com a marca `recuperada`). */
  recuperadas: number;
  /** Ausentes que ficaram para a próxima passada (teto) ou leitura cortada no limite de páginas. */
  pendentes: number;
  falhas: number;
  erro?: string;
}

export interface ResultadoDaReconciliacao {
  dry_run: boolean;
  horas: number;
  sessoes: ResultadoDaSessao[];
  total_lidas: number;
  total_ausentes: number;
  total_recuperadas: number;
  /** Outra passada já rodava neste processo: esta não fez nada. */
  ocupada?: boolean;
}

export interface DepsDaReconciliacao {
  credenciais: (admin: SupabaseClient, lookup: EvolutionCredsLookup) => Promise<EvolutionCredentials | null>;
  estado: (creds: EvolutionCredentials) => Promise<string | null>;
  buscar: (
    creds: EvolutionCredentials,
    input: { desde: Date; ate: Date; pagina: number; porPagina: number },
  ) => Promise<PaginaDeMensagens>;
  ingerir: (
    admin: SupabaseClient,
    sessao: SessaoParaIngestao,
    envelope: WahaEnvelope,
    requestId: string,
    opcoes: OpcoesDeIngestao,
  ) => Promise<void>;
  agora: () => Date;
}

interface SessaoParaIngestao {
  id: string;
  organization_id: string;
  is_warmup_complete: boolean | null;
  warmup_started_at: string | null;
}

interface LinhaDeSessao extends SessaoParaIngestao {
  status: string | null;
  display_name: string | null;
  evolution_instance_name: string | null;
}

const DEPS_PADRAO: DepsDaReconciliacao = {
  credenciais: resolveEvolutionCreds,
  estado: (creds) => estadoDaInstancia(creds),
  buscar: buscarMensagens,
  ingerir: (admin, sessao, envelope, requestId, opcoes) =>
    dispatchWahaEvent(admin as Parameters<typeof dispatchWahaEvent>[0], sessao, envelope, requestId, opcoes),
  agora: () => new Date(),
};

/** `horas` da rota → janela válida. Fora de faixa ou ilegível = padrão (nunca janela gigante). */
export function horasDaJanela(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isInteger(n) || n < 1) return HORAS_PADRAO;
  return Math.min(n, HORAS_MAXIMO);
}

interface Candidata {
  externalId: string;
  timestamp: number;
  envelope: WahaEnvelope;
}

/** Separa os registros crus em candidatas (entrada individual com conteúdo) e ignoradas. */
export function classificarRegistros(
  instancia: string,
  registros: unknown[],
): { candidatas: Candidata[]; ignoradas: Ignoradas } {
  const ignoradas: Ignoradas = { grupo_ou_status: 0, sem_direcao: 0, tecnico: 0 };
  if (registros.length === 0) return { candidatas: [], ignoradas };

  // REGRA ABSOLUTA: grupo, status, canal e transmissão nunca chegam à ingestão. A triagem é a do
  // webhook, na mesma ordem: lote inteiro sem contato sai antes; lote misto perde só esses itens.
  const corpo = JSON.stringify({ event: "messages.upsert", instance: instancia, data: registros });
  let mantidos: unknown[];
  if (webhookSoDeChatSemContato(corpo)) {
    mantidos = [];
  } else {
    const filtrado = JSON.parse(corpoSemChatsSemContato(corpo)) as { data?: unknown };
    mantidos = Array.isArray(filtrado.data) ? filtrado.data : filtrado.data ? [filtrado.data] : [];
  }
  ignoradas.grupo_ou_status = registros.length - mantidos.length;

  const candidatas: Candidata[] = [];
  const vistos = new Set<string>();
  for (const r of mantidos) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const chave = (o.key && typeof o.key === "object" ? o.key : {}) as Record<string, unknown>;
    // Direção explícita: `fromMe` ausente não vira "do lead" nem "do celular" por omissão.
    if (typeof chave.fromMe !== "boolean") {
      ignoradas.sem_direcao++;
      continue;
    }
    const tipo = typeof o.messageType === "string" ? o.messageType : "";
    if (!o.message || typeof o.message !== "object" || TIPOS_TECNICOS.has(tipo)) {
      ignoradas.tecnico++;
      continue;
    }
    const traduzido = traduzirEvento({ event: "messages.upsert", instance: instancia, data: [r] });
    const envelope = traduzido.envelopes[0];
    const payload = envelope?.payload;
    const id = typeof payload?.id === "string" ? payload.id : "";
    // Sem id, sem corpo e sem mídia a ingestão descartaria em silêncio — e a passada seguinte a
    // contaria "ausente" de novo, para sempre. Fica contada aqui, uma vez por passada.
    // Só `message` (de entrada ou do celular): protocolo de edição/exclusão não é mensagem ausente.
    if (!envelope || envelope.event !== "message" || !id || (!payload?.body && !payload?.hasMedia)) {
      ignoradas.tecnico++;
      continue;
    }
    if (vistos.has(id)) continue;
    vistos.add(id);
    const ts = typeof o.messageTimestamp === "number" ? o.messageTimestamp : Number(o.messageTimestamp) || 0;
    candidatas.push({ externalId: id, timestamp: ts, envelope });
  }
  return { candidatas, ignoradas };
}

/** `external_id` (de `ids`) que já existem em `messages` da organização, com a marca de recuperada. */
async function presentes(
  admin: SupabaseClient,
  org: string,
  ids: string[],
): Promise<Map<string, { recuperada: boolean }>> {
  const saida = new Map<string, { recuperada: boolean }>();
  for (let i = 0; i < ids.length; i += LOTE_DE_CONSULTA) {
    const lote = ids.slice(i, i + LOTE_DE_CONSULTA);
    const { data, error } = await admin
      .from("messages")
      .select("external_id, metadata")
      .eq("organization_id", org)
      .in("external_id", lote);
    if (error) throw new Error(`consulta_de_presentes_falhou: ${String(error.message).slice(0, 120)}`);
    for (const m of (data ?? []) as Array<{ external_id: string; metadata: unknown }>) {
      saida.set(m.external_id, { recuperada: mensagemFoiRecuperada(m.metadata) });
    }
  }
  return saida;
}

/**
 * Abre o aviso da sessão na Central, ou soma no que já está aberto (sem empilhar repetidos).
 * `channel_number_alert` é o tipo dos avisos de conexão (o CHECK do banco já o aceita): o aviso é
 * sobre ESTE número, e o operador chega à conexão pela referência `channel_session`.
 */
async function avisarNaCentral(
  admin: SupabaseClient,
  sessao: { id: string; organization_id: string },
  apelido: string,
  recuperadasAgora: number,
  agora: Date,
): Promise<void> {
  const prefixo = `${TITULO_RECUPERADAS} "${apelido}"`;
  const { data: aberto, error: erroLeitura } = await admin
    .from("agent_inbox_items")
    .select("id, title")
    .eq("organization_id", sessao.organization_id)
    .eq("ref_kind", REF_KIND_SESSAO)
    .eq("ref_id", sessao.id)
    .eq("kind", "channel_number_alert")
    .eq("status", "open")
    .like("title", `${TITULO_RECUPERADAS}%`)
    .limit(1)
    .maybeSingle();
  if (erroLeitura) throw new Error(`aviso_ilegivel: ${String(erroLeitura.message).slice(0, 120)}`);

  const anterior = Number(/\((\d+)\)$/.exec(((aberto as { title?: string } | null)?.title ?? ""))?.[1] ?? 0);
  const total = anterior + recuperadasAgora;
  const quando = agora.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
  const title = `${prefixo} (${total})`;
  const body =
    `${total === 1 ? "1 mensagem desta conexão (recebida ou enviada pelo celular) estava" : `${total} mensagens desta conexão (recebidas ou enviadas pelo celular) estavam`} ` +
    `no WhatsApp e não tinha${total === 1 ? "" : "m"} chegado ao CRM (webhook perdido ou reconexão do chip). ` +
    `Elas entraram agora nas conversas, com a data original. Nada foi respondido automaticamente: ` +
    `confira as conversas e responda à mão o que precisar. Última recuperação: ${quando}.`;

  const { error } = aberto
    ? await admin
        .from("agent_inbox_items")
        .update({ title, body })
        .eq("organization_id", sessao.organization_id)
        .eq("id", (aberto as { id: string }).id)
    : await admin.from("agent_inbox_items").insert({
        organization_id: sessao.organization_id,
        kind: "channel_number_alert",
        severity: "warn",
        title,
        body,
        ref_kind: REF_KIND_SESSAO,
        ref_id: sessao.id,
      });
  if (error) throw new Error(`aviso_nao_gravado: ${String(error.message).slice(0, 120)}`);
}

function resultadoVazio(s: LinhaDeSessao, desfecho: DesfechoDaSessao): ResultadoDaSessao {
  return {
    channel_session_id: s.id,
    organization_id: s.organization_id,
    apelido: s.display_name ?? "sem nome",
    desfecho,
    lidas: 0,
    ja_presentes: 0,
    ausentes: 0,
    ignoradas: { grupo_ou_status: 0, sem_direcao: 0, tecnico: 0 },
    recuperadas: 0,
    pendentes: 0,
    falhas: 0,
  };
}

async function reconciliarSessao(
  admin: SupabaseClient,
  s: LinhaDeSessao,
  ctx: { deps: DepsDaReconciliacao; desde: Date; ate: Date; dryRun: boolean; requestId: string; restante: { n: number } },
): Promise<ResultadoDaSessao> {
  const r = resultadoVazio(s, "ok");
  const instancia = s.evolution_instance_name ?? "";
  // Desconectada é pulada sem erro: o que ela gravou antes da queda entra na passada seguinte
  // à volta (a janela cobre). Primeiro o estado do banco (de graça), depois o do transporte.
  if ((s.status ?? "").toUpperCase() !== "WORKING") return { ...r, desfecho: "desconectada" };
  const creds = await ctx.deps.credenciais(admin, { organizationId: s.organization_id, instance: instancia });
  if (!creds) return { ...r, desfecho: "sem_credencial" };
  if ((await ctx.deps.estado(creds)) !== "open") return { ...r, desfecho: "desconectada" };

  const registros: unknown[] = [];
  let cortada = false;
  for (let pagina = 1; ; pagina++) {
    const p = await ctx.deps.buscar(creds, { desde: ctx.desde, ate: ctx.ate, pagina, porPagina: POR_PAGINA });
    registros.push(...p.registros);
    if (p.registros.length < POR_PAGINA || pagina >= p.paginas) break;
    if (pagina >= MAX_PAGINAS) {
      cortada = true;
      break;
    }
  }
  r.lidas = registros.length;

  const { candidatas, ignoradas } = classificarRegistros(instancia, registros);
  r.ignoradas = ignoradas;
  const jaEstao = await presentes(admin, s.organization_id, candidatas.map((c) => c.externalId));
  const ausentes = candidatas.filter((c) => !jaEstao.has(c.externalId)).sort((a, b) => a.timestamp - b.timestamp);
  r.ja_presentes = candidatas.length - ausentes.length;
  r.ausentes = ausentes.length;
  if (ctx.dryRun) return r;

  const vez = ausentes.slice(0, Math.max(0, ctx.restante.n));
  r.pendentes = ausentes.length - vez.length + (cortada ? 1 : 0);
  ctx.restante.n -= vez.length;
  for (const c of vez) {
    try {
      await ctx.deps.ingerir(admin, s, c.envelope, ctx.requestId, { recuperada: true });
    } catch (err) {
      r.falhas++;
      logger.warn("[reconciliacao-entrada] mensagem não ingerida (a próxima passada tenta de novo)", {
        organization_id: s.organization_id,
        channel_session_id: s.id,
        detail: err instanceof Error ? err.message.slice(0, 120) : "erro",
        requestId: ctx.requestId,
      });
    }
  }
  if (vez.length) {
    // Conta o que ENTROU com a marca: a ingestão pode ter descartado (chat não endereçável) ou o
    // webhook pode ter chegado antes (aí a linha é dele, não recuperada).
    const depois = await presentes(admin, s.organization_id, vez.map((c) => c.externalId));
    r.recuperadas = [...depois.values()].filter((v) => v.recuperada).length;
  }
  return r;
}

let passadaEmCurso = false;

/**
 * Uma passada da reconciliação de entrada sobre todas as sessões Evolution ativas. A organização
 * de cada mensagem vem da SESSÃO (linha do banco), nunca de corpo de requisição. Falha de uma
 * sessão não derruba as outras.
 */
export async function reconciliarEntrada(
  admin: SupabaseClient,
  opcoes: { horas?: number; dryRun?: boolean; requestId: string; teto?: number },
  deps: Partial<DepsDaReconciliacao> = {},
): Promise<ResultadoDaReconciliacao> {
  const d: DepsDaReconciliacao = { ...DEPS_PADRAO, ...deps };
  const horas = horasDaJanela(opcoes.horas);
  const dryRun = opcoes.dryRun === true;
  const vazio: ResultadoDaReconciliacao = { dry_run: dryRun, horas, sessoes: [], total_lidas: 0, total_ausentes: 0, total_recuperadas: 0 };
  if (passadaEmCurso) return { ...vazio, ocupada: true };
  passadaEmCurso = true;
  try {
    const { data, error } = await admin
      .from("channel_sessions")
      .select("id, organization_id, status, display_name, evolution_instance_name, is_warmup_complete, warmup_started_at")
      .eq("provider", "evolution")
      .is("archived_at", null)
      .not("evolution_instance_name", "is", null)
      .limit(MAX_SESSOES);
    if (error) throw new Error(`sessoes_ilegiveis: ${String(error.message).slice(0, 120)}`);

    // A janela termina CARENCIA_MS antes de agora. Mensagem que acabou de chegar ainda está a
    // caminho pelo webhook; se a reconciliação a pegasse primeiro, ela nasceria "recuperada" e
    // perderia o atendimento normal (agente, motor) — a rotina roubaria do webhook o que ele
    // ia entregar. O que o webhook perdeu de verdade continua lá na passada seguinte.
    const ate = new Date(d.agora().getTime() - CARENCIA_MS);
    const desde = new Date(ate.getTime() - horas * 3_600_000);
    const restante = { n: opcoes.teto ?? TETO_POR_PASSADA };
    const saida = { ...vazio };
    for (const s of (data ?? []) as LinhaDeSessao[]) {
      let r: ResultadoDaSessao;
      try {
        r = await reconciliarSessao(admin, s, { deps: d, desde, ate, dryRun, requestId: opcoes.requestId, restante });
      } catch (err) {
        r = { ...resultadoVazio(s, "erro"), erro: err instanceof Error ? err.message.slice(0, 160) : "erro" };
        logger.warn("[reconciliacao-entrada] sessão falhou (as outras seguem)", {
          organization_id: s.organization_id,
          channel_session_id: s.id,
          detail: r.erro,
          requestId: opcoes.requestId,
        });
      }
      if (r.recuperadas > 0) {
        try {
          await avisarNaCentral(admin, s, r.apelido, r.recuperadas, ate);
        } catch (err) {
          // As mensagens já entraram; perder o aviso em silêncio esconderia a recuperação.
          logger.error("[reconciliacao-entrada] aviso na Central falhou", {
            organization_id: s.organization_id,
            channel_session_id: s.id,
            detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
            requestId: opcoes.requestId,
          });
        }
      }
      saida.sessoes.push(r);
      saida.total_lidas += r.lidas;
      saida.total_ausentes += r.ausentes;
      saida.total_recuperadas += r.recuperadas;
    }
    if (saida.total_recuperadas > 0 || saida.total_ausentes > 0) {
      logger.info("[reconciliacao-entrada] passada", {
        dry_run: dryRun,
        horas,
        ausentes: saida.total_ausentes,
        recuperadas: saida.total_recuperadas,
        requestId: opcoes.requestId,
      });
    }
    return saida;
  } finally {
    passadaEmCurso = false;
  }
}
