/**
 * Alarme de SILÊNCIO DE ENTRADA — "conectado" não prova que mensagem chega.
 *
 * ─── O buraco ────────────────────────────────────────────────────────────────
 *
 * O vigia (`channel-health`) pergunta ao transporte se a instância está de pé, e
 * `open` vira `WORKING`, saudável. Mas a conexão pode estar de pé com o webhook de
 * entrada quebrado (assinatura perdida, URL errada, instância sem eventos): o
 * número responde, nada chega ao CRM, e ninguém é avisado até alguém estranhar.
 *
 * ─── O que esta regra faz, e o que NÃO faz ──────────────────────────────────
 *
 * Silêncio é SUSPEITA, não prova: um dia calmo é igual, por fora, a uma entrada
 * parada. Por isso o aviso é `warn`, fala em "suspeita" e pede um teste manual.
 * Nunca derruba nem reconecta o chip (mesma razão do `channel-health`: religar
 * sozinho pode transformar suspensão temporária em definitiva). Grupos (`@g.us`)
 * não entram: a ingestão os descarta, e a base daqui é só conversa privada.
 *
 * Critérios (decididos pelo operador em 05/11/2026):
 *   - limite N = 4 horas sem mensagem privada recebida;
 *   - só avalia seg–sex, 07:00 às 16:00, America/Sao_Paulo;
 *   - só avisa se a conexão tem histórico (≥ 3 mensagens privadas recebidas nos
 *     últimos 7 dias) OU se OUTRA conexão da mesma organização recebeu mensagem
 *     privada na última hora enquanto esta ficou muda;
 *   - uma vez por episódio; resolve sozinho quando volta a chegar mensagem.
 *
 * Três decisões de implementação que afinam (sem contrariar) esses critérios:
 *   1. As 4 horas contam TEMPO ÚTIL (dentro da janela seg–sex 07–16). Contar
 *      relógio corrido faria todo aviso estourar às 07:00 de segunda — sexta à
 *      tarde até segunda de manhã é silêncio normal, não suspeita. Dia útil
 *      inteiro sem mensagem = 9 h úteis; ele cruza o limite no mesmo dia.
 *   2. A contagem nunca começa antes da última reconexão (`desdeEm`): conexão
 *      que acabou de voltar não deve ser cobrada pelo silêncio de quando estava
 *      fora, que já teve o seu próprio aviso.
 *   3. O critério do chip irmão exige que ESTA conexão já tenha recebido algo
 *      alguma vez: chip novo/frio, que nunca recebeu nada, não "ficou mudo".
 *
 * A decisão é uma função PURA (`decidirSilencioDeEntrada`): entra horário,
 * contagem e episódio; sai avisar/resolver/nada com o motivo. O banco só entra em
 * `sincronizarSilencioDeEntrada`, que reusa o mecanismo de aviso de `health.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PREFIXO_SILENCIO, REF_KIND_SESSAO, avisoAbertoDaSessao, gravarEpisodio } from "./health";

export const LIMITE_SILENCIO_MIN = 4 * 60;
export const MIN_MENSAGENS_HISTORICO = 3;
export const JANELA_HISTORICO_DIAS = 7;
/** Chip que não recebeu NENHUMA mensagem privada nesta janela é "frio": o critério do chip irmão não se aplica. */
export const JANELA_CHIP_FRIO_DIAS = 30;
export const JANELA_IRMAO_MIN = 60;
export const FUSO_PADRAO = "America/Sao_Paulo";

/** 07:00 e 16:00, em minutos desde a meia-noite local. Dias úteis: seg(1) a sex(5). */
const ABERTURA_MIN = 7 * 60;
const FECHAMENTO_MIN = 16 * 60;
const MIN_MS = 60_000;
const DIA_MS = 24 * 60 * MIN_MS;

/** Prefixo do título: é por ele que o aviso de silêncio é achado para resolver. */
export const TITULO_SILENCIO = "Sem mensagens recebidas em";

// ─── Calendário no fuso ─────────────────────────────────────────────────────

const formatadores = new Map<string, Intl.DateTimeFormat>();
const DIAS_DA_SEMANA: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface PartesLocais {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
  diaSemana: number;
}

function partesLocais(ms: number, fuso: string): PartesLocais {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: fuso,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatadores.set(fuso, f);
  }
  const p: Record<string, string> = {};
  for (const parte of f.formatToParts(new Date(ms))) p[parte.type] = parte.value;
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour) % 24,
    minuto: Number(p.minute),
    segundo: Number(p.second),
    diaSemana: DIAS_DA_SEMANA[p.weekday ?? ""] ?? 0,
  };
}

/** Instante (ms UTC) da meia-noite local do dia que contém `ms`. */
function inicioDoDiaLocal(ms: number, fuso: string): number {
  const p = partesLocais(ms, fuso);
  const localComoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  const deslocamento = localComoUtc - Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.ano, p.mes - 1, p.dia) - deslocamento;
}

/** `agora` está na janela de avaliação? Bordas 07:00 e 16:00 contam como dentro. */
export function dentroDoHorarioComercial(
  agora: Date,
  fuso: string = FUSO_PADRAO,
): { dentro: true } | { dentro: false; motivo: "fim_de_semana" | "fora_do_horario" } {
  const p = partesLocais(agora.getTime(), fuso);
  if (p.diaSemana === 0 || p.diaSemana === 6) return { dentro: false, motivo: "fim_de_semana" };
  const minuto = p.hora * 60 + p.minuto;
  if (minuto < ABERTURA_MIN || minuto > FECHAMENTO_MIN) return { dentro: false, motivo: "fora_do_horario" };
  return { dentro: true };
}

/** Minutos de TEMPO ÚTIL (seg–sex, 07:00–16:00 locais) entre dois instantes. */
export function minutosUteisEntre(de: Date, ate: Date, fuso: string = FUSO_PADRAO): number {
  const fimMs = ate.getTime();
  // Tampa de 21 dias: a decisão só precisa saber se passou de 4 h úteis, e o laço
  // abaixo é por DIA — um silêncio de meses não pode virar um laço de meses.
  const inicioMs = Math.max(de.getTime(), fimMs - 21 * DIA_MS);
  if (fimMs <= inicioMs) return 0;

  let total = 0;
  let dia = inicioDoDiaLocal(inicioMs, fuso);
  while (dia < fimMs) {
    const { diaSemana } = partesLocais(dia + 12 * 60 * MIN_MS, fuso);
    if (diaSemana >= 1 && diaSemana <= 5) {
      const de1 = Math.max(inicioMs, dia + ABERTURA_MIN * MIN_MS);
      const ate1 = Math.min(fimMs, dia + FECHAMENTO_MIN * MIN_MS);
      if (ate1 > de1) total += (ate1 - de1) / MIN_MS;
    }
    dia = inicioDoDiaLocal(dia + 36 * 60 * MIN_MS, fuso);
  }
  return total;
}

// ─── A decisão (pura) ───────────────────────────────────────────────────────

export interface EntradaSilencio {
  agora: Date;
  /** Padrão `America/Sao_Paulo`. */
  fuso?: string;
  /** Última mensagem PRIVADA recebida por esta conexão; null = nunca recebeu. */
  ultimaInboundEm: Date | null;
  /** Quando a conexão voltou a `WORKING`; o silêncio não conta antes disso. */
  desdeEm?: Date | null;
  /** Mensagens privadas recebidas nos últimos 7 dias (basta saber se chega a 3). */
  inboundPrivadas7d: number;
  /** Outra conexão da mesma organização recebeu mensagem privada na última hora. */
  irmaoRecebeuNaUltimaHora: boolean;
  /** Referência (ISO da última mensagem) do episódio já avisado; null = nenhum. */
  episodioAbertoRef: string | null;
}

export type DecisaoSilencio =
  | { acao: "avisar"; motivo: "historico" | "irmao_ativo"; silencioMin: number; referencia: string }
  | { acao: "resolver"; motivo: "voltou_a_receber" }
  | {
      acao: "nada";
      motivo:
        | "ja_avisado"
        | "fim_de_semana"
        | "fora_do_horario"
        | "sem_referencia"
        | "dentro_do_limite"
        | "sem_historico";
    };

export function decidirSilencioDeEntrada(e: EntradaSilencio): DecisaoSilencio {
  const fuso = e.fuso ?? FUSO_PADRAO;
  const referencia = e.ultimaInboundEm ? e.ultimaInboundEm.toISOString() : null;

  // Resolver vem ANTES do horário: chegou mensagem às 19h de uma sexta, o aviso
  // aberto não pode ficar na Central até segunda de manhã.
  if (e.episodioAbertoRef !== null) {
    if (e.episodioAbertoRef !== referencia) return { acao: "resolver", motivo: "voltou_a_receber" };
    return { acao: "nada", motivo: "ja_avisado" };
  }

  const horario = dentroDoHorarioComercial(e.agora, fuso);
  if (!horario.dentro) return { acao: "nada", motivo: horario.motivo };

  if (!e.ultimaInboundEm || !referencia) return { acao: "nada", motivo: "sem_referencia" };

  const inicio = e.desdeEm && e.desdeEm > e.ultimaInboundEm ? e.desdeEm : e.ultimaInboundEm;
  const silencioMin = minutosUteisEntre(inicio, e.agora, fuso);
  if (silencioMin < LIMITE_SILENCIO_MIN) return { acao: "nada", motivo: "dentro_do_limite" };

  if (e.inboundPrivadas7d >= MIN_MENSAGENS_HISTORICO) {
    return { acao: "avisar", motivo: "historico", silencioMin, referencia };
  }
  if (e.irmaoRecebeuNaUltimaHora) {
    return { acao: "avisar", motivo: "irmao_ativo", silencioMin, referencia };
  }
  return { acao: "nada", motivo: "sem_historico" };
}

// ─── A integração com o banco ───────────────────────────────────────────────

export interface SessaoParaSilencio {
  id: string;
  organization_id: string;
  /** Última mudança de status da conexão (reconexão zera a contagem). */
  desdeEm?: Date | null;
}

export type DesfechoSilencio = "avisado" | "ja_avisado" | "resolvido" | "sem_mudanca" | "ocupado";

/**
 * Avalia o silêncio de UMA conexão `WORKING` e age: avisa, resolve ou nada.
 *
 * O episódio mora em `channel_session_health.escalated_status` com o prefixo
 * `SILENCIO:` (a coluna já existe para o "exatamente 1×"; nenhuma coluna nova).
 * Se a coluna guarda outro episódio (conexão caída, empurrão do provedor), este
 * alarme não mexe: aquele aviso é mais grave e tem dono.
 *
 * Mesma regra do item 4: o episódio só é gravado DEPOIS de o aviso gravar. Se o
 * insert falha, lança, o cron registra e a próxima rodada tenta de novo.
 */
export async function sincronizarSilencioDeEntrada(
  admin: SupabaseClient,
  sessao: SessaoParaSilencio,
  opcoes: { apelido: string; outrasSessoesIds: string[]; agora?: Date; fuso?: string },
): Promise<DesfechoSilencio> {
  const agora = opcoes.agora ?? new Date();
  const fuso = opcoes.fuso ?? FUSO_PADRAO;
  const org = sessao.organization_id;

  const { data: linha } = await admin
    .from("channel_session_health")
    .select("escalated_status")
    .eq("organization_id", org)
    .eq("channel_session_id", sessao.id)
    .maybeSingle();
  const jaEscalado = (linha?.escalated_status as string | null) ?? null;

  if (jaEscalado !== null && !jaEscalado.startsWith(PREFIXO_SILENCIO)) return "ocupado";
  const episodioAbertoRef = jaEscalado ? jaEscalado.slice(PREFIXO_SILENCIO.length) : null;

  // Porta barata: sem episódio aberto e fora da janela, a decisão já está tomada
  // e nenhuma consulta ao banco é necessária.
  if (episodioAbertoRef === null && !dentroDoHorarioComercial(agora, fuso).dentro) return "sem_mudanca";

  // Última mensagem privada recebida, por `conversations.last_inbound_at` (mantido
  // pela função de marcação a cada mensagem persistida): tabela pequena, em vez de
  // varrer `messages` por sessão. Grupo fica de fora (`is_group = false`).
  const desde7d = new Date(agora.getTime() - JANELA_HISTORICO_DIAS * DIA_MS).toISOString();
  const { data: conversas, error: erroConversas } = await admin
    .from("conversations")
    .select("id, last_inbound_at")
    .eq("organization_id", org)
    .eq("channel_session_id", sessao.id)
    .eq("is_group", false)
    .not("last_inbound_at", "is", null)
    .order("last_inbound_at", { ascending: false })
    .limit(50);
  if (erroConversas) throw new Error(`silencio_consulta_falhou: ${String(erroConversas.message).slice(0, 160)}`);

  const lista = (conversas ?? []) as Array<{ id: string; last_inbound_at: string }>;
  const ultimaInboundEm = lista[0] ? new Date(lista[0].last_inbound_at) : null;
  const recentes = lista.filter((c) => c.last_inbound_at >= desde7d);

  // Cada conversa com `last_inbound_at` na janela tem ao menos 1 inbound nela.
  // Três conversas já provam o histórico; menos que isso, conta nas mensagens.
  let inboundPrivadas7d = recentes.length;
  if (inboundPrivadas7d < MIN_MENSAGENS_HISTORICO && recentes.length > 0) {
    const { data: msgs, error: erroMsgs } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", org)
      .in("conversation_id", recentes.map((c) => c.id))
      .eq("direction", "inbound")
      .neq("type", "system")
      .gte("sent_at", desde7d)
      .limit(MIN_MENSAGENS_HISTORICO);
    if (erroMsgs) throw new Error(`silencio_consulta_falhou: ${String(erroMsgs.message).slice(0, 160)}`);
    inboundPrivadas7d = (msgs ?? []).length;
  }

  // Chip irmão: só consulta quando o histórico não basta e há outra conexão.
  let irmaoRecebeuNaUltimaHora = false;
  // Só vale para chip que JÁ recebeu algo recentemente: chip realmente frio (como um número
  // novo, só com uma entrada antiga) nunca avisa por causa do irmão. `last_inbound_at` dentro
  // da janela implica pelo menos 1 mensagem privada recebida nela.
  const desde30d = new Date(agora.getTime() - JANELA_CHIP_FRIO_DIAS * DIA_MS);
  const chipNaoEhFrio = ultimaInboundEm !== null && ultimaInboundEm >= desde30d;
  if (episodioAbertoRef === null && chipNaoEhFrio && inboundPrivadas7d < MIN_MENSAGENS_HISTORICO && opcoes.outrasSessoesIds.length > 0) {
    const desdeHora = new Date(agora.getTime() - JANELA_IRMAO_MIN * MIN_MS).toISOString();
    const { data: irmaos, error: erroIrmaos } = await admin
      .from("conversations")
      .select("id")
      .eq("organization_id", org)
      .in("channel_session_id", opcoes.outrasSessoesIds)
      .eq("is_group", false)
      .gte("last_inbound_at", desdeHora)
      .limit(1);
    if (erroIrmaos) throw new Error(`silencio_consulta_falhou: ${String(erroIrmaos.message).slice(0, 160)}`);
    irmaoRecebeuNaUltimaHora = (irmaos ?? []).length > 0;
  }

  const decisao = decidirSilencioDeEntrada({
    agora,
    fuso,
    ultimaInboundEm,
    desdeEm: sessao.desdeEm ?? null,
    inboundPrivadas7d,
    irmaoRecebeuNaUltimaHora,
    episodioAbertoRef,
  });

  const sessaoSaude = { id: sessao.id, organization_id: org, status: "WORKING" };

  if (decisao.acao === "resolver") {
    await admin
      .from("agent_inbox_items")
      .update({ status: "resolved", resolved_at: agora.toISOString() })
      .eq("organization_id", org)
      .eq("ref_kind", REF_KIND_SESSAO)
      .eq("ref_id", sessao.id)
      .eq("kind", "channel_number_alert")
      .like("title", `${TITULO_SILENCIO}%`)
      .eq("status", "open");
    await gravarEpisodio(admin, sessaoSaude, null);
    return "resolvido";
  }

  if (decisao.acao === "nada") return decisao.motivo === "ja_avisado" ? "ja_avisado" : "sem_mudanca";

  const horas = Math.floor(decisao.silencioMin / 60);
  // Aviso de silêncio já aberto (a rodada anterior gravou o aviso mas não a marca do episódio):
  // não duplica, só grava a marca que faltou.
  const jaAberto = await avisoAbertoDaSessao(admin, sessaoSaude, { kind: "channel_number_alert", titulo: TITULO_SILENCIO, prefixoDoTitulo: true });
  const { error: erroDoAviso } = jaAberto
    ? { error: null }
    : await admin.from("agent_inbox_items").insert({
    organization_id: org,
    kind: "channel_number_alert",
    severity: "warn",
    title: `${TITULO_SILENCIO} "${opcoes.apelido}" há mais de ${horas} h úteis (suspeita)`,
    body:
      decisao.motivo === "irmao_ativo"
        ? "Esta conexão aparece como conectada, mas não recebe mensagem privada há mais de " +
          `${horas} h úteis, enquanto outro número da conta recebeu mensagem na última hora. ` +
          "Pode ser só silêncio, ou o recebimento deste número parou. Confira mandando uma mensagem de teste para ele. " +
          "O CRM não reconecta nada sozinho."
        : "Esta conexão aparece como conectada e vinha recebendo mensagens, mas não recebe mensagem privada há mais de " +
          `${horas} h úteis. Pode ser só um período calmo, ou o recebimento parou. Confira mandando uma mensagem de teste ` +
          "para este número. O CRM não reconecta nada sozinho. O aviso fecha sozinho quando uma mensagem chegar.",
    ref_kind: REF_KIND_SESSAO,
    ref_id: sessao.id,
  });
  // Aviso que não gravou NÃO vira episódio: o dedup acharia que o operador foi
  // avisado e calaria as próximas rodadas (mesma regra de `health.ts`).
  if (erroDoAviso) throw new Error(`aviso_nao_gravado: ${String(erroDoAviso.message).slice(0, 160)}`);
  await gravarEpisodio(admin, sessaoSaude, `${PREFIXO_SILENCIO}${decisao.referencia}`);
  return "avisado";
}
