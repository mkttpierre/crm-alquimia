import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/channel-sessions/[id] — health check AO VIVO de um canal.
 *
 * Consulta o status real no WAHA, grava `last_health_check_at` (+ sincroniza
 * `status`) no DB e devolve o estado atual. É a fonte de verdade quando o
 * usuário abre a Central de Conexões ou está aguardando o QR ser escaneado.
 *
 * O health check ao vivo é do canal pareado por QR: o canal oficial não tem
 * sessão no transporte para consultar (`waha_session_name` é NULL nele, por
 * construção da união do `channel_sessions_provider_ref_check`), e perguntar
 * assim mesmo pediria `/api/sessions/null` ao WAHA.
 *
 * `?impact=1` acrescenta `deletion_impact` — o PREFLIGHT da exclusão. Vive num
 * parâmetro e não no corpo padrão porque esta rota é POLLADA enquanto o usuário
 * espera o QR, e o preflight custa seis contagens; quem precisa dele é o diálogo
 * de exclusão, uma vez, ao abrir. Contrato em `ChannelDeletionImpact`.
 *
 * Qualquer membro da org pode consultar. organization_id vem da sessão.
 */
import { estadoDaInstancia } from "@/lib/channels/evolution/client";
import { statusDoEstado } from "@/lib/channels/evolution/webhook";
import { resolveEvolutionCreds } from "@/lib/channels/evolution/credentials";
import { assertWahaConnectionIdle, ChannelConnectionError } from "@/lib/channels/connect-waha";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_EVOLUTION, CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { revogarInstanciaEvolution } from "@/lib/channels/evolution/revogar";
import { numeroObservadoDaSessao } from "@/lib/channels/numero-observado";
import { isChannelStatus } from "@/lib/schemas/channels";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";
import { chipsDaConexao, retirarChipDoMotor } from "@/lib/disparo-painel/operacoes";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

/**
 * Idade máxima do carimbo `last_health_check_at` antes de o GET regravá-lo sem
 * que nada tenha mudado. A Central pollava esta rota a cada 3 s e cada UPDATE
 * custava ~89 ms (medido) mais um evento de Realtime. O único leitor do carimbo
 * é o "Verificado <data>" da Central de Conexões, que não precisa de mais
 * precisão que isso.
 */
const CARIMBO_SAUDE_MAX_IDADE_MS = 60_000;

/**
 * O que a exclusão deste canal vai fazer, e ao custo de quê — para o diálogo
 * poder dizer a verdade ANTES do clique.
 *
 * `outcome` é a decisão real da rota DELETE, calculada pela mesma função: se as
 * duas discordassem, a tela prometeria uma coisa e o servidor faria outra.
 */
export interface ChannelDeletionImpact {
  /** `delete` apaga a linha; `archive` esconde o canal e preserva tudo abaixo. */
  outcome: "delete" | "archive";
  /**
   * Referências com ON DELETE RESTRICT: o Postgres RECUSA apagar a linha
   * enquanto elas existirem. É o que torna o arquivamento obrigatório, não uma
   * preferência.
   */
  history: { conversations: number; messages: number; agent_versions: number };
  /**
   * Referências com ON DELETE CASCADE que NÃO são estado de runtime: sumiriam em
   * silêncio junto com a linha. `ai_routers` leva os `ai_router_members` dele
   * atrás; `channel_knobs` é o ajuste anti-ban que o operador calibrou;
   * `before_send_traces` é auditoria durável de decisão de envio.
   *
   * Warm-up, saúde, pacing e cópias recentes também cascateiam e NÃO entram aqui
   * de propósito: são contadores derivados, que se regeneram sozinhos.
   */
  configuration: { ai_routers: number; channel_knobs: number; before_send_traces: number };
  /**
   * O número é chip do motor de disparo (`disparo_chips` que não está `desligado`)? A exclusão o tira do motor e
   * cancela os envios pendentes dele (`retirarChipDoMotor`), sem mexer na saúde. Não decide apagar-ou-arquivar: a FK
   * do chip para a conexão é `set null`, e o histórico do motor aponta para o CHIP, que fica.
   */
  disparo: { chips_no_motor: number };
}

/** Tabelas que apontam para `channel_sessions` e cujo conteúdo decide o desfecho. */
type DependentTable =
  | "conversations"
  | "messages"
  | "ai_agent_versions"
  | "ai_routers"
  | "channel_knobs"
  | "before_send_traces";

/**
 * Conta tudo que está pendurado no canal, com o CLIENTE ADMIN e filtro explícito
 * de organização.
 *
 * O cliente do usuário não serve aqui: `ai_routers`, `channel_knobs` e
 * `before_send_traces` nasceram no apêndice do baseline e não têm policy de RLS
 * para o papel `authenticated`. Uma contagem que volta zero por falta de
 * permissão é indistinguível de "não há nada" — e o zero silencioso reabriria
 * exatamente o defeito que esta função existe para fechar. Com o admin, o filtro
 * de tenancy é responsabilidade nossa e vem de `orgId`, resolvido da sessão.
 */
async function loadDeletionImpact(
  orgId: string,
  channelSessionId: string,
): Promise<ChannelDeletionImpact> {
  const admin = createAdminClient();
  // Chips do motor: poucos por conexão, então a leitura traz as linhas e o filtro de estado é aqui.
  const chips = await chipsDaConexao(admin, orgId, channelSessionId);
  const chipsNoMotor = chips.ok ? chips.chips.filter((c) => c.estado !== "desligado").length : 0;
  // `select("*")` com `head` não devolve linha nenhuma — só o contador. Pedir uma
  // coluna concreta quebraria em `channel_knobs`, cuja chave é (org, sessão): ela
  // não tem `id`.
  const count = async (table: DependentTable): Promise<number> => {
    const { count: n } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("channel_session_id", channelSessionId);
    return n ?? 0;
  };

  const [conversations, messages, agentVersions, routers, knobs, traces] = await Promise.all([
    count("conversations"),
    count("messages"),
    count("ai_agent_versions"),
    count("ai_routers"),
    count("channel_knobs"),
    count("before_send_traces"),
  ]);

  const history = { conversations, messages, agent_versions: agentVersions };
  const configuration = {
    ai_routers: routers,
    channel_knobs: knobs,
    before_send_traces: traces,
  };
  const nada =
    Object.values(history).every((n) => n === 0) &&
    Object.values(configuration).every((n) => n === 0);

  return { outcome: nada ? "delete" : "archive", history, configuration, disparo: { chips_no_motor: chipsNoMotor } };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });

  const supabase = await createClient();
  const { data: session } = await supabase
    .from("channel_sessions")
    .select("id, provider, evolution_instance_name, waha_session_name, display_name, phone_number, status, last_health_check_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!session) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const impact =
    req.nextUrl.searchParams.get("impact") === "1"
      ? await loadDeletionImpact(activeOrg.orgId, id)
      : null;
  const comImpacto = <T extends object>(corpo: T): T & { deletion_impact?: ChannelDeletionImpact } =>
    impact ? { ...corpo, deletion_impact: impact } : corpo;

  if (user.support?.access_mode === "support_readonly") return ok(comImpacto({ ...session, waha_configured: false }), { requestId });
  const waha = getWahaClient();
  // Canal oficial não tem sessão no transporte para consultar — `waha_session_name`
  // é NULL nele por CHECK, e perguntar assim mesmo pediria `/api/sessions/null`.
  const nomeSessao =
    session.provider === CHANNEL_PROVIDER_WAHA ? session.waha_session_name : null;
  const evolution = session.provider === "evolution" && session.evolution_instance_name;
  if ((!waha || !nomeSessao) && !evolution) {
    // Nada a checar ao vivo (transporte fora do ar, ou canal que não vive nele):
    // devolve o que está no DB, sinalizando que o estado não foi confirmado agora.
    return ok(comImpacto({ ...session, waha_configured: false }), { requestId });
  }

  let liveStatus = session.status as string;
  let phoneNumber = session.phone_number as string | null;
  try {
    if (evolution) {
      const creds = await resolveEvolutionCreds(createAdminClient(), { organizationId: activeOrg.orgId, instance: evolution });
      if (!creds) throw new Error("evolution_not_configured");
      const estado = await estadoDaInstancia(creds);
      const status = statusDoEstado(estado);
      if (!status) throw new Error("evolution_unknown_state");
      liveStatus = status;
    } else if (waha && nomeSessao) {
      const remote = await waha.getVerifiedSession(nomeSessao);
      liveStatus = remote?.status ?? "STOPPED";
      // O número vem do JID (`<phone>@c.us`), e a regra de quando ele VALE mora
      // em `numeroObservadoDaSessao` — inclusive por que não basta gravar sempre.
      // O que havia aqui só preenchia a coluna VAZIA, então um re-pareamento com
      // outro aparelho deixava o banco mentindo para sempre.
      phoneNumber = numeroObservadoDaSessao({
        jid: typeof remote?.me?.id === "string" ? remote.me.id : null,
        statusAoVivo: liveStatus,
        gravado: phoneNumber,
      });
    }
  } catch {
    return fail("connection_status_failed", "Não foi possível conferir a conexão. Tente novamente.", 502, { requestId });
  }

  // Sincroniza o DB: status/telefone só se mudaram; o carimbo de saúde só quando
  // algo mudou ou quando o gravado já passou de CARIMBO_SAUDE_MAX_IDADE_MS.
  const agora = Date.now();
  const gravadoEm = session.last_health_check_at
    ? Date.parse(session.last_health_check_at as string)
    : Number.NaN;
  const carimboVencido =
    Number.isNaN(gravadoEm) || agora - gravadoEm > CARIMBO_SAUDE_MAX_IDADE_MS;
  const checkedAt = new Date(agora).toISOString();
  const patch: Record<string, unknown> = {};
  if (isChannelStatus(liveStatus) && liveStatus !== session.status) {
    patch.status = liveStatus;
    patch.last_status_change_at = checkedAt;
  }
  if (phoneNumber && phoneNumber !== session.phone_number) patch.phone_number = phoneNumber;
  if (Object.keys(patch).length > 0 || carimboVencido) patch.last_health_check_at = checkedAt;
  const carimboDevolvido = (patch.last_health_check_at as string | undefined) ?? (session.last_health_check_at as string);

  const gravar = (corpo: Record<string, unknown>) =>
    supabase
      .from("channel_sessions")
      .update(corpo)
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id);

  let phoneConflict = false;
  const { error: syncErr } =
    Object.keys(patch).length > 0 ? await gravar(patch) : { error: null };
  if (syncErr) {
    // 23505 aqui só pode ser a trava de número único (0106): ESTE número já está
    // ligado em OUTRO canal ativo da org. Descartar o erro — o que esta rota
    // fazia — deixava o canal para sempre sem telefone, sem nada na tela dizendo
    // por quê. Regrava sem o telefone (o carimbo de saúde não pode ser refém do
    // conflito) e devolve o conflito nomeado.
    if (syncErr.code !== "23505") {
      return fail("internal_error", syncErr.message, 500, { requestId });
    }
    phoneConflict = true;
    phoneNumber = session.phone_number as string | null;
    const { phone_number: _descartado, ...semTelefone } = patch;
    const { error: retryErr } = await gravar(semTelefone);
    if (retryErr) return fail("internal_error", retryErr.message, 500, { requestId });
  }

  return ok(
    comImpacto({
      id: session.id,
      waha_session_name: session.waha_session_name,
      display_name: session.display_name,
      phone_number: phoneNumber,
      status: liveStatus,
      last_health_check_at: carimboDevolvido,
      waha_configured: true,
      /** Verdadeiro = o número lido no canal já pertence a outro canal ativo desta org. */
      phone_number_conflict: phoneConflict,
    }),
    { requestId },
  );
}

/**
 * DELETE /api/v1/channel-sessions/[id] — remove um canal da Central de Conexões.
 *
 * Duas saídas, escolhidas pelo banco e não por parâmetro:
 *
 *  - Canal com NADA pendurado: apaga a linha de verdade. O que some junto por
 *    CASCADE é estado de runtime (warm-up, saúde, pacing, cópias recentes), que
 *    se regenera.
 *  - Canal com HISTÓRICO ou CONFIGURAÇÃO: arquiva (`archived_at`). conversations,
 *    messages e ai_agent_versions referenciam channel_sessions com ON DELETE
 *    RESTRICT — o Postgres recusaria o DELETE, e forçá-lo significaria destruir o
 *    histórico de atendimento junto. Arquivar tira o canal da UI preservando tudo.
 *
 * ⚠️ CASCADE **não** é sinônimo de descartável, e a régua das "três FKs RESTRICT"
 * errava por causa disso: `ai_routers` (com os `ai_router_members` atrás),
 * `channel_knobs` e `before_send_traces` também apontam para cá em CASCADE, e são
 * configuração do usuário e auditoria. Um canal sem uma única conversa mas com um
 * roteador de IA montado passava por "virgem", e o DELETE levava o roteador junto
 * sem uma palavra. Por isso a pergunta é "há algo pendurado?", respondida por
 * `loadDeletionImpact` — a MESMA função que alimenta o preflight do `GET
 * ?impact=1`, para a tela não prometer um desfecho e o servidor executar outro.
 *
 * A revogação no provider acontece ANTES de mexer no DB e é TENTATIVA, não
 * portão. A rota falhava fechado (503 sem WAHA configurado, 502 quando o WAHA
 * recusava a conexão, marcando o canal FAILED) e o dono ficava preso a uma
 * conexão velha que não conseguia tirar da tela. Agora o canal sai do CRM em
 * qualquer caso, e a resposta diz a verdade sobre o servidor: `revogado` e, quando
 * ele não respondeu, `aviso` — o aparelho pode continuar conectado. O webhook de
 * uma sessão arquivada é descartado nas três entradas (WAHA por token, WAHA
 * global e `webhooks/channel/[token]`), então o servidor que sobrou não a recria.
 * Pareamento em andamento (`assertWahaConnectionIdle`) continua bloqueando (409).
 *
 *  - Canal pareado por QR no WAHA: logout + delete da sessão.
 *  - Canal Evolution: logout + delete da instância (`revogarInstanciaEvolution`).
 *  - Canal oficial: não há sessão a deslogar — o que dá acesso é a CREDENCIAL
 *    gravada e a URL de webhook. As duas são invalidadas no mesmo patch do
 *    arquivamento (token apagado, `webhook_path_token` rotacionado). Sem isso a
 *    plataforma continuava entregando mensagem num canal "excluído": o webhook
 *    resolvia a sessão pelo token antigo e criava contato, conversa e mensagem
 *    num inbox onde o operador nem consegue responder (o arquivamento grava
 *    STOPPED).
 *
 * Número que é chip do motor de disparo sai do motor junto (`retirarChipDoMotor`, a mesma função de
 * `DELETE /api/v1/disparo/chips/[id]`): o chip vira `desligado` e os envios pendentes dele são cancelados, sem mexer
 * na saúde. O preflight avisa antes (`deletion_impact.disparo`).
 *
 * Admin only. organization_id vem da sessão — nunca do path/body.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;

  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const supabase = await createClient();
  const colunas = "id, provider, waha_session_name, evolution_instance_name, display_name, phone_number";
  const buscar = (cols: string) =>
    supabase.from("channel_sessions").select(cols).eq("organization_id", activeOrg.orgId).eq("id", id).maybeSingle();
  const { data } = await queryTolerantToMissingArchived(
    () => buscar(`${colunas}, ${ARCHIVED_AT}`),
    () => buscar(colunas),
  );
  const session = data as Record<string, unknown> | null;
  if (!session) return fail("not_found", t("Canal não encontrado."), 404, { requestId });

  // Já arquivado: a exclusão já aconteceu (é um clique repetido ou uma corrida).
  // NÃO revoga de novo: o nome da instância/sessão só é único entre as ATIVAS, e
  // a credencial é resolvida por organização + nome — revogar aqui derrubaria no
  // servidor a conexão NOVA que reusou o nome. Nada muda, então nada audita.
  if (session.archived_at) {
    const impact = await loadDeletionImpact(activeOrg.orgId, id);
    return ok({ id, archived: true, impact, revogado: false, aviso: null }, { requestId });
  }

  const pareadoPorQr =
    session.provider === CHANNEL_PROVIDER_WAHA || session.provider === CHANNEL_PROVIDER_EVOLUTION;
  if (pareadoPorQr) {
    try {
      await assertWahaConnectionIdle(createAdminClient(), activeOrg.orgId, id);
    } catch (err) {
      if (err instanceof ChannelConnectionError) return fail(err.code, t("Uma conexão está em andamento. Aguarde e tente novamente."), err.status, { requestId });
      throw err;
    }
  }

  const impact = await loadDeletionImpact(activeOrg.orgId, id);
  const arquivar = impact.outcome === "archive";

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    archived_at: now,
    status: "STOPPED",
    last_status_change_at: now,
  };

  let revogacao: Revogacao;
  if (session.provider === CHANNEL_PROVIDER_WAHA) {
    revogacao = await dentroDoOrcamento(revogarSessaoWaha(session.waha_session_name as string | null));
  } else if (session.provider === CHANNEL_PROVIDER_EVOLUTION) {
    revogacao = await dentroDoOrcamento(
      revogarEvolution(activeOrg.orgId, session.evolution_instance_name as string | null),
    );
  } else {
    revogacao = { revogado: true };
    // Revogação do canal oficial: a credencial some e a URL do webhook muda, então
    // o que a plataforma tem configurado do outro lado deixa de valer. Só faz
    // sentido no ramo que PRESERVA a linha — no hard delete ela some inteira.
    patch.meta_token_encrypted = null;
    patch.webhook_path_token = randomUUID().replace(/-/g, "");
  }

  // O número sai do motor de disparo junto com a conexão: o chip vira `desligado` e os pendentes dele são cancelados,
  // pela MESMA função de `DELETE /api/v1/disparo/chips/[id]` (sem mexer na saúde). Depois da revogação (nada é escrito
  // antes dela) e antes de a conexão sumir: com o chip fora do motor, nenhuma volta manda pela conexão que está saindo.
  const retirada = await retirarChipsDaConexao(activeOrg.orgId, id, user.id, requestId, user.idioma);
  if (!retirada.ok) return fail("internal_error", retirada.mensagem, 500, { requestId });

  if (arquivar) {
    const { error: archErr } = await supabase
      .from("channel_sessions")
      .update(patch)
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id);
    if (archErr) return fail("internal_error", archErr.message, 500, { requestId });
  } else {
    const { error: delErr } = await supabase
      .from("channel_sessions")
      .delete()
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id);
    if (delErr) return fail("internal_error", delErr.message, 500, { requestId });
  }

  void audit({
    action: arquivar ? "channel.archived" : "channel.deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: {
      waha_session_name: session.waha_session_name,
      phone_number: session.phone_number,
      evolution_instance_name: session.evolution_instance_name,
      provider: session.provider,
      revogado: revogacao.revogado,
      ...(revogacao.motivo ? { revogacao_motivo: revogacao.motivo.slice(0, 500) } : {}),
      ...impact.history,
      ...impact.configuration,
    },
  });

  const aviso = revogacao.revogado ? null : t(AVISO_SERVIDOR_NAO_RESPONDEU);
  return ok({ id, archived: arquivar, impact, revogado: revogacao.revogado, aviso }, { requestId });
}

/** Tira do motor todo chip desta conexão que ainda está nele (`retirarChipDoMotor`, um por um). */
async function retirarChipsDaConexao(
  orgId: string,
  channelSessionId: string,
  actorUserId: string,
  requestId: string,
  idioma: Idioma,
): Promise<{ ok: true } | { ok: false; mensagem: string }> {
  const admin = createAdminClient();
  const chips = await chipsDaConexao(admin, orgId, channelSessionId);
  if (!chips.ok) return { ok: false, mensagem: traduzir("Não foi possível tirar o chip do motor.", idioma) };
  for (const chip of chips.chips) {
    if (chip.estado === "desligado") continue;
    const r = await retirarChipDoMotor(
      { leitura: admin, escrita: admin },
      { orgId, chipId: chip.id, autor: { actorUserId }, requestId, idioma, origem: "conexao_excluida" },
    );
    if (!r.ok) return { ok: false, mensagem: r.mensagem };
  }
  return { ok: true };
}

const AVISO_SERVIDOR_NAO_RESPONDEU =
  "O servidor de WhatsApp não respondeu. A conexão saiu do CRM, mas pode continuar ativa no aparelho: desconecte em Aparelhos conectados.";

type Revogacao = { revogado: boolean; motivo?: string };

/**
 * Teto da revogação INTEIRA (logout + delete), por provider. O servidor que aceita
 * a conexão e não responde é o caso caro: no WAHA cada passo tem teto de 15 s (e
 * lê a sessão de novo depois), na Evolution 5 s por endpoint. Somados, passavam do
 * limite da tela, que desistia antes de o banco ser tocado. A tela espera 20 s
 * (`ConnectionsClient`, exclusão): este orçamento tem de caber com folga nele.
 *
 * Estourado, a chamada ao servidor segue em segundo plano até o teto dela e o
 * resultado é descartado: o canal sai do CRM com `revogado: false` e o aviso.
 */
const ORCAMENTO_REVOGACAO_MS = 6_000;

async function dentroDoOrcamento(tentativa: Promise<Revogacao>): Promise<Revogacao> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<Revogacao>((resolve) => {
    timer = setTimeout(
      () => resolve({ revogado: false, motivo: `revogacao_sem_resposta_em_${ORCAMENTO_REVOGACAO_MS}ms` }),
      ORCAMENTO_REVOGACAO_MS,
    );
  });
  try {
    return await Promise.race([
      tentativa.catch((err: unknown) => ({ revogado: false, motivo: err instanceof Error ? err.message : String(err) })),
      estouro,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Logout + delete da sessão no WAHA, sem lançar. O delete é tentado mesmo quando
 * o logout falha (não deixar a sessão de pé no servidor); `revogado` só quando os
 * dois responderam.
 */
async function revogarSessaoWaha(nomeSessao: string | null): Promise<Revogacao> {
  const waha = getWahaClient();
  if (!waha) return { revogado: false, motivo: "waha_not_configured" };
  if (!nomeSessao) return { revogado: false, motivo: "waha_session_name_ausente" };
  const falhas: string[] = [];
  for (const passo of [() => waha.logoutSession(nomeSessao), () => waha.deleteSession(nomeSessao)]) {
    try {
      await passo();
    } catch (err) {
      falhas.push(wahaFriendlyError(err));
    }
  }
  return falhas.length === 0 ? { revogado: true } : { revogado: false, motivo: falhas.join(" | ") };
}

/** Credencial da instância + `revogarInstanciaEvolution`, sem lançar. */
async function revogarEvolution(
  orgId: string,
  instancia: string | null,
): Promise<Revogacao> {
  if (!instancia) return { revogado: false, motivo: "evolution_instance_name_ausente" };
  try {
    const creds = await resolveEvolutionCreds(createAdminClient(), { organizationId: orgId, instance: instancia });
    if (!creds) return { revogado: false, motivo: "evolution_not_configured" };
    return await revogarInstanciaEvolution(creds, instancia);
  } catch (err) {
    return { revogado: false, motivo: err instanceof Error ? err.message : String(err) };
  }
}
