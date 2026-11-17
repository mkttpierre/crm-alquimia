/**
 * A conexão caiu — e alguém precisa SABER.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A sessão do canal saiu de `WORKING` às 13:19. O estado foi gravado na coluna,
 * o operador não recebeu nada, e a descoberta aconteceu horas depois, quando ele
 * foi olhar por conta própria — depois de estranhar que ninguém escrevia. Não
 * havia bug em lugar nenhum: o webhook chegou, a coluna atualizou. O que faltava
 * era a única parte que importa para quem atende — o aviso.
 *
 * ─── Por que este arquivo existe, se o mecanismo já estava desenhado ────────
 *
 * Estava: `channel_session_health.escalated_status` nasceu com o comentário
 * "Status já escalado (agent_inbox_items kind='qr_rescan') no EPISÓDIO corrente
 * — dedup do 'exatamente 1×'. Volta a null quando a sessão volta a WORKING", e
 * `SESSION_ESCALATION_STATUSES` foi declarada em `edge/crm/session-watchdog.ts`.
 * A coluna, a constante e o kind existiam; o código que escala nunca foi
 * escrito. `git grep` achava os três e nenhum consumidor — promessa de esqueleto,
 * sem músculo. Este arquivo é o músculo, e usa a peça desenhada em vez de
 * inventar uma paralela.
 *
 * ─── Dois gatilhos, porque falham de formas diferentes ─────────────────────
 *
 * O webhook de status avisa em segundos — e emudece justamente quando o
 * transporte morre, que é o pior caso. O vigia PERGUNTA, e por isso enxerga o
 * silêncio. Um sem o outro deixa um buraco: só webhook não vê o transporte
 * morto; só vigia demora até a próxima rodada. Os dois chamam esta mesma
 * função, então a regra de quando avisar existe uma vez só.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

/** Único estado em que mensagem entra e sai. Contrato do CRM (uppercase). */
export const STATUS_SAUDAVEL = "WORKING";

/**
 * Estados que merecem aviso.
 *
 * `SCAN_QR_CODE` e `FAILED` vêm de `SESSION_ESCALATION_STATUSES`, declarada
 * quando o mecanismo foi desenhado. `STOPPED` foi ACRESCENTADO aqui: para quem
 * atende, uma sessão parada é indistinguível de uma quebrada — em ambos os casos
 * ninguém recebe mensagem, que é a única coisa que o operador sente. Parar de
 * propósito e não ser avisado é um incômodo pequeno; não ser avisado de uma
 * parada que ninguém pediu é o defeito que motivou este arquivo.
 *
 * `STARTING` NÃO entra: é o estado normal de todo boot, e avisar nele faria o
 * sistema gritar a cada reinício — o caminho mais curto para o operador aprender
 * a ignorar o aviso.
 */
export const STATUS_QUE_AVISAM = ["SCAN_QR_CODE", "FAILED", "STOPPED"] as const;

/** Marca os avisos desta origem, para resolver o do canal CERTO depois. */
export const REF_KIND_SESSAO = "channel_session";

/**
 * O transporte respondeu, e a resposta foi "sua credencial não vale".
 *
 * Vive aqui, e não no adapter, porque quem lê este código é a regra de aviso
 * logo abaixo: é um contrato entre os dois, e um literal repetido nas duas
 * pontas divergiria no primeiro renomeio — com o gate verde, porque nenhum
 * `includes` reclama de string que ninguém mais escreve.
 */
export const DETALHE_CREDENCIAL_RECUSADA = "credencial_recusada_pelo_transporte";

/**
 * Marca do episódio aberto por um EMPURRÃO do provedor.
 *
 * A varredura não fecha episódio com esta marca: ela mede credencial e conta,
 * não o estado do número, e um número suspenso continua aparecendo na lista de
 * contas. Sem a marca, o crítico de suspensão sumia da Central em ≤5 minutos.
 */
export const PREFIXO_EMPURRAO = "PUSH:";

/**
 * Marca do episódio aberto pelo ALARME DE SILÊNCIO DE ENTRADA
 * (`silencio-de-entrada.ts`): a conexão responde `WORKING`, mas nada chega.
 *
 * Esta função de saúde não fecha episódio com esta marca: `WORKING` é justamente
 * o estado em que o silêncio acontece, e fechar aqui apagaria o aviso na rodada
 * seguinte. Quem fecha é o próprio alarme, quando volta a chegar mensagem.
 */
export const PREFIXO_SILENCIO = "SILENCIO:";

export interface AvisoDeConexao {
  kind: "qr_rescan" | "channel_number_alert";
  severity: "warn" | "critical";
  title: string;
  body: string | null;
  /** O que grava em `escalated_status` — o episódio já escalado. */
  episodio: string;
}

export interface SaudeObservada {
  reachable: boolean;
  status: string | null;
  detail: string | null;
}

/**
 * O que foi observado merece aviso? `null` quando está tudo bem.
 *
 * `apelido` é como o operador chama esta conexão na tela. Entra no título porque
 * com dois números ligados "WhatsApp desconectado" não diz QUAL — e a primeira
 * pergunta de quem lê o aviso é exatamente essa.
 */
export function avisoDaConexao(saude: SaudeObservada, apelido: string): AvisoDeConexao | null {
  if (!saude.reachable) {
    // "Não deu para perguntar" tem DOIS motivos que pedem ações opostas, e
    // tratá-los igual foi o defeito medido: numa VPS real a chave do WAHA foi
    // trocada por uma segunda cópia do repo, TUDO parou, e por três dias a
    // Central mostrou apenas um `warn` dizendo "não foi possível verificar" —
    // a frase que se usa para descrever um soluço de rede. O dono só descobriu
    // ao tentar conectar um número e ver o 401 na cara.
    //
    // Quando o transporte RESPONDE recusando a credencial, não há incerteza
    // sobre a causa nem sobre o que fazer — e escanear o QR, que é o reflexo de
    // quem lê "conexão caída", não resolve nada.
    if (saude.detail === DETALHE_CREDENCIAL_RECUSADA) {
      return {
        kind: "channel_number_alert",
        severity: "critical",
        title: `Conexão "${apelido}": o servidor de WhatsApp recusou a chave de acesso`,
        body:
          "Escanear o QR não resolve: a chave que o CRM usa para falar com o servidor de WhatsApp não confere com a que o servidor espera. Enquanto isso durar, nenhuma mensagem entra nem sai por NENHUMA conexão. Quem cuida do servidor precisa conferir a WAHA_API_KEY do .env e recriar o contêiner do WhatsApp.",
        episodio: "CREDENCIAL_RECUSADA",
      };
    }

    // Não deu para perguntar mesmo. NÃO é o mesmo que estar caído, e o aviso
    // não pode afirmar o que não sabe: a ação aqui é olhar o serviço, não
    // escanear um QR. `warn` e não `critical` porque uma oscilação de rede cabe
    // neste ramo, e gritar por ela ensinaria o operador a ignorar a cor.
    return {
      kind: "channel_number_alert",
      severity: "warn",
      title: `Não foi possível verificar a conexão "${apelido}"`,
      body: saude.detail,
      episodio: "UNREACHABLE",
    };
  }

  const status = (saude.status ?? "").toUpperCase();
  if (!status || status === STATUS_SAUDAVEL) return null;
  if (!(STATUS_QUE_AVISAM as readonly string[]).includes(status)) return null;

  if (status === "SCAN_QR_CODE") {
    return {
      kind: "qr_rescan",
      severity: "critical",
      title: `WhatsApp "${apelido}" desconectado — precisa escanear o QR de novo`,
      body: "Enquanto isso não acontecer, nenhuma mensagem entra nem sai por esta conexão.",
      episodio: status,
    };
  }

  return {
    kind: "channel_number_alert",
    severity: "critical",
    title: `WhatsApp "${apelido}" fora do ar (${status})`,
    body: "Nenhuma mensagem entra nem sai por esta conexão até ela voltar.",
    episodio: status,
  };
}

/** O que a faixa do topo mostra: conexão caída, com nome. */
export interface ConexaoCaida {
  id: string;
  apelido: string;
  status: string;
}

/**
 * As conexões desta organização que estão fora do ar AGORA.
 *
 * Mora aqui, e não na tela, por duas razões que o repo já pagou caro: telas que
 * montam a consulta de `channel_sessions` à mão foram o que deixou três
 * seletores oferecendo canal arquivado (vigiado por `canais-selecionaveis`); e o
 * filtro de estados precisa ser LITERALMENTE o mesmo que decide o aviso — uma
 * segunda lista divergiria com o tempo, e a faixa deixaria de aparecer para um
 * estado que a Central considera grave.
 *
 * Arquivada fica de fora: foi desligada de propósito, e anunciar que uma conexão
 * aposentada está parada é o ruído que ensina a ignorar a faixa.
 *
 * E só entra a conexão EM USO: chip do motor que não está `desligado` (rampa,
 * ativo e pausado contam), ou conexão com mensagem de entrada ou saída nos
 * últimos `DIAS_DE_USO_RECENTE` dias. Número velho que ninguém usa, parado há
 * meses, deixava a faixa acesa todo dia, e faixa sempre acesa é faixa que
 * ninguém lê. O aviso da Central (`sincronizarSaudeDaConexao`) NÃO passa por
 * este filtro: lá a queda de qualquer conexão segue registrada.
 */
export async function listarConexoesCaidas(
  admin: SupabaseClient,
  organizationId: string,
  agora: Date = new Date(),
): Promise<ConexaoCaida[]> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, display_name, phone_number, status")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .in("status", [...STATUS_QUE_AVISAM]);

  const caidas = (data ?? []).map((s) => ({
    id: s.id as string,
    apelido: (s.display_name as string | null) ?? (s.phone_number as string | null) ?? "sem nome",
    status: (s.status as string | null) ?? "",
  }));
  if (caidas.length === 0) return [];

  const emUso = await conexoesEmUso(admin, organizationId, caidas.map((c) => c.id), agora);
  return caidas.filter((c) => emUso.has(c.id));
}

/** Janela do "usada de fato" pela conversa: mensagem de entrada ou saída. */
export const DIAS_DE_USO_RECENTE = 7;

/**
 * Das conexões candidatas, quais estão em uso: no motor (chip não desligado) ou
 * com mensagem recente.
 *
 * A mensagem é perguntada UMA conexão por vez, com `limit(1)`, e só para quem o
 * motor não resolveu: uma consulta única com `in(channel_session_id)` e limite
 * podia encher o limite com as mensagens de uma conexão movimentada e esconder a
 * outra — exatamente o chip caído que precisava de faixa. Linha `type=system` é
 * nota de tela, não mensagem que entrou ou saiu, e não conta. As candidatas são as
 * poucas conexões caídas da organização, então são poucas perguntas, e o
 * `select` traz só o id da conexão. O filtro por `direction` e `sent_at` casa
 * com o índice `idx_messages_org_direction_sent` (migration 0133).
 *
 * Consulta que falha conta como EM USO: na dúvida, a faixa aparece. Esconder a
 * queda de um chip usado por causa de um erro de leitura é o lado caro do erro.
 */
async function conexoesEmUso(
  admin: SupabaseClient,
  organizationId: string,
  candidatas: string[],
  agora: Date,
): Promise<Set<string>> {
  const { data: chips, error: erroDosChips } = await admin
    .from("disparo_chips")
    .select("channel_session_id")
    .eq("organization_id", organizationId)
    .in("channel_session_id", candidatas)
    .neq("estado", "desligado");
  if (erroDosChips) return new Set(candidatas);

  const emUso = new Set<string>();
  for (const c of chips ?? []) {
    const id = (c as { channel_session_id: string | null }).channel_session_id;
    if (id) emUso.add(id);
  }

  const desde = new Date(agora.getTime() - DIAS_DE_USO_RECENTE * 24 * 60 * 60 * 1000).toISOString();
  const restantes = candidatas.filter((id) => !emUso.has(id));
  const comMensagem = await Promise.all(
    restantes.map(async (id) => {
      const { data: msgs, error } = await admin
        .from("messages")
        .select("channel_session_id")
        .eq("organization_id", organizationId)
        .in("direction", ["inbound", "outbound"])
        .eq("channel_session_id", id)
        .neq("type", "system")
        .gte("sent_at", desde)
        .limit(1);
      return error || (msgs ?? []).length > 0 ? id : null;
    }),
  );
  for (const id of comMensagem) if (id) emUso.add(id);
  return emUso;
}

interface SessaoParaVigiar {
  id: string;
  organization_id: string;
  status: string | null;
}

/**
 * Escala uma vez por episódio e RESOLVE quando volta.
 *
 * O "uma vez" mora em `escalated_status`: sem ele, um vigia de 5 em 5 minutos
 * abriria doze avisos por hora do mesmo problema, e a Central viraria uma lista
 * do mesmo aviso — que é a forma mais rápida de tornar a Central inútil.
 *
 * Resolver na volta é a outra metade, e a menos óbvia: aviso que não fecha
 * sozinho ensina que a Central mostra coisa velha, e aí o operador para de
 * confiar no que está aberto. Só fecha os avisos DESTA sessão (`ref_id`) —
 * fechar por organização apagaria o alerta de um outro canal que segue caído.
 */
export async function sincronizarSaudeDaConexao(
  admin: SupabaseClient,
  sessao: SessaoParaVigiar,
  saude: SaudeObservada,
  apelido: string,
  /**
   * QUEM observou — e é o que decide se esta observação pode FECHAR o aviso.
   *
   * ─── O defeito que isto existe para impedir ───────────────────────────────
   *
   * As duas fontes medem coisas DIFERENTES:
   *
   *   - o empurrão do provedor fala do NÚMERO ("suspenso", "desconectado");
   *   - a varredura fala da CREDENCIAL e da conta ("a chave responde, a conta
   *     está na lista").
   *
   * Um número suspenso continua aparecendo na lista de contas. Então a
   * varredura via `WORKING`, `avisoDaConexao` devolvia `null`, e o ramo de
   * baixo marcava como resolvido o crítico que o empurrão tinha aberto minutos
   * antes — com o número ainda suspenso. O aviso sumia da Central em ≤5 min e
   * o provedor não reenvia o evento, então ninguém ficava sabendo.
   *
   * Trocar "aviso que nunca fecha" por "aviso que fecha sozinho sem o problema
   * ter acabado" é o pior dos dois, porque o segundo parece que funciona.
   *
   * Regra: só fecha quem sabe do que está falando. O empurrão fecha qualquer
   * episódio (ele é a autoridade sobre o número); a varredura fecha só o que
   * ela mesma poderia ter aberto.
   */
  origem: "varredura" | "empurrao" = "varredura",
): Promise<"avisado" | "ja_avisado" | "resolvido" | "sem_mudanca"> {
  const aviso = avisoDaConexao(saude, apelido);

  const { data: linha } = await admin
    .from("channel_session_health")
    .select("escalated_status")
    .eq("organization_id", sessao.organization_id)
    .eq("channel_session_id", sessao.id)
    .maybeSingle();
  const jaEscalado = (linha?.escalated_status as string | null) ?? null;

  if (!aviso) {
    if (!jaEscalado) return "sem_mudanca";
    // Episódio de silêncio de entrada: a conexão está `WORKING` de propósito, e
    // quem o fecha é o alarme de silêncio (ao chegar mensagem), não esta função.
    if (jaEscalado.startsWith(PREFIXO_SILENCIO)) return "sem_mudanca";
    // O episódio veio do provedor e quem está observando é a varredura: ela não
    // tem como saber se o número deixou de estar suspenso. Não fecha.
    if (origem === "varredura" && jaEscalado.startsWith(PREFIXO_EMPURRAO)) {
      return "sem_mudanca";
    }
    await admin
      .from("agent_inbox_items")
      .update({ status: "resolved" })
      .eq("organization_id", sessao.organization_id)
      .eq("ref_kind", REF_KIND_SESSAO)
      .eq("ref_id", sessao.id)
      .eq("status", "open");
    await gravarEpisodio(admin, sessao, null);
    await emitirEventoDoChip(admin, sessao, "chip.voltou", null);
    return "resolvido";
  }

  // O episódio carrega QUEM o observou. Sem isso, a varredura não teria como
  // saber que aquele crítico veio do provedor — e voltaria a fechá-lo.
  const episodio =
    origem === "empurrao" ? `${PREFIXO_EMPURRAO}${aviso.episodio}` : aviso.episodio;

  // Mesmo episódio: já foi avisado, e repetir é ruído. Um episódio DIFERENTE
  // (caiu por QR, agora está FAILED) avisa de novo — mudou o que fazer.
  if (jaEscalado === episodio) return "ja_avisado";

  // Se a rodada anterior gravou o aviso e não conseguiu gravar o episódio, o aviso está
  // aberto: não insere outro, só grava a marca que faltou.
  const jaAberto = await avisoAbertoDaSessao(admin, sessao, { kind: aviso.kind, titulo: aviso.title });
  const { error: erroDoAviso } = jaAberto
    ? { error: null }
    : await admin.from("agent_inbox_items").insert({
        organization_id: sessao.organization_id,
        kind: aviso.kind,
        severity: aviso.severity,
        title: aviso.title,
        body: aviso.body,
        ref_kind: REF_KIND_SESSAO,
        ref_id: sessao.id,
      });
  // Aviso que não gravou NÃO vira episódio escalado: o dedup acharia que o
  // operador foi avisado e calaria as próximas rodadas. Lançar deixa o cron
  // registrar a falha e tentar de novo, e faz o provedor reentregar o webhook.
  if (erroDoAviso) {
    throw new Error(`aviso_nao_gravado: ${String(erroDoAviso.message).slice(0, 160)}`);
  }
  await gravarEpisodio(admin, sessao, episodio);
  // Só a QUEDA vira evento: trocar de episódio com a conexão ainda caída (QR → FAILED) não é cair de novo.
  if (!jaEscalado) await emitirEventoDoChip(admin, sessao, "chip.caiu", saude.status ?? null);
  return "avisado";
}

/**
 * `chip.caiu` / `chip.voltou` — os webhooks de saída que os agentes externos assinam. Saem no mesmo
 * ponto que abre e fecha o aviso da Central, então herdam o "uma vez por episódio" do `escalated_status`. Falha ao
 * emitir não desfaz o aviso (que é o que o operador vê); vira log.
 */
async function emitirEventoDoChip(
  admin: SupabaseClient,
  sessao: SessaoParaVigiar,
  evento: "chip.caiu" | "chip.voltou",
  status: string | null,
): Promise<void> {
  try {
    const { error } = await admin.rpc("emit_event" as never, {
      p_event_type: evento,
      p_entity_kind: "channel_session",
      p_entity_id: sessao.id,
      p_payload: { channel_session_id: sessao.id, status },
      p_metadata: { actor_kind: "system", source: "channel-health" },
      p_organization_id: sessao.organization_id,
    } as never);
    if (error) throw new Error((error as { message: string }).message);
  } catch (err) {
    logger.warn(`[channel-health] emit_event ${evento} falhou`, {
      channel_session_id: sessao.id,
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
  }
}

/**
 * A linha de saúde pode não existir ainda — `upsert` pelo par único, e não
 * `update`, porque um `update` que não acha linha não escreve nada e o dedup
 * silenciosamente pararia de funcionar: avisaria de novo a cada rodada.
 */
export async function gravarEpisodio(
  admin: SupabaseClient,
  sessao: SessaoParaVigiar,
  episodio: string | null,
): Promise<void> {
  const { error } = await admin.from("channel_session_health").upsert(
    {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      status: sessao.status ?? "UNKNOWN",
      escalated_status: episodio,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,channel_session_id" },
  );
  // Marca que não gravou NÃO pode passar calada: o aviso já saiu, e a rodada seguinte
  // não saberia que o operador foi avisado. Lançar faz o cron registrar e tentar de novo
  // (e quem insere o aviso confere se ele já está aberto, para não duplicar).
  if (error) throw new Error(`episodio_nao_gravado: ${String(error.message).slice(0, 160)}`);
}

/**
 * Já existe um aviso ABERTO igual a este para a sessão? Lido antes de inserir, para a
 * rodada que sucede uma marca de episódio que não gravou não duplicar o aviso.
 * `titulo` casa exato; com `prefixoDoTitulo` casa o começo (o título do silêncio traz
 * as horas, que mudam de uma rodada para outra).
 */
export async function avisoAbertoDaSessao(
  admin: SupabaseClient,
  sessao: { id: string; organization_id: string },
  filtro: { kind: string; titulo: string; prefixoDoTitulo?: boolean },
): Promise<boolean> {
  let q = admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", sessao.organization_id)
    .eq("ref_kind", REF_KIND_SESSAO)
    .eq("ref_id", sessao.id)
    .eq("kind", filtro.kind)
    .eq("status", "open");
  q = filtro.prefixoDoTitulo ? q.like("title", `${filtro.titulo}%`) : q.eq("title", filtro.titulo);
  const { data } = await q.limit(1).maybeSingle();
  return Boolean((data as { id?: string } | null)?.id);
}
