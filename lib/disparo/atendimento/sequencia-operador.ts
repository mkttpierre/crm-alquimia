/**
 * Sequência do operador: o operador escolhe, na barra de atalhos da caixa de conversa, um FUNIL (várias mensagens
 * prontas) ou uma mensagem avulsa, e as mensagens ficam AGENDADAS para o lead daquela conversa, em ordem, com o
 * atraso e o "digitando…/gravando…" que cada passo tem.
 *
 * De onde vem o funil: das tabelas `operator_funnels`/`operator_funnel_steps` (migration 0248). O funil de
 * valores, que era fixo no código, foi semeado lá com a mesma cadência (3 s depois de texto/imagem, 31 s depois de
 * áudio). Mensagem avulsa = um funil de um passo.
 *
 * Por que a fila do motor e não um temporizador: `disparo_envios` já é a fila durável (sobrevive a reinício), já
 * confere bloqueio, opt-out, "o lead escreveu" e a trava, e já tem o painel. As linhas nascem com
 * `origem = 'operador'` e o motor (`../motor.ts`) as leva ao canal pelo chip da conversa, na ordem.
 * Este arquivo SÓ agenda (e cancela): não fala com canal nenhum (o teste da trava confere que não há import de
 * `lib/channels` neste diretório).
 *
 * Travas: envio manual só exige CHIP SAUDÁVEL. Motor de prospecção desligado,
 * janela de resposta e rampa NÃO barram o que o operador manda à mão. Continuam valendo: chip desligado, pausado, em
 * pausa ou vermelho (recusa tudo e diz por quê); contato bloqueado/anonimizado/sem telefone; a trava do envio real
 * (simulado); a allowlist `DISPARO_SO_PARA`; o verificador de texto; e a repetição em 24 h sem confirmação.
 * Conversa sem lead aberto: o lead é criado (`garantirLead`) antes de agendar.
 * Se o lead responde no meio, o motor cancela o resto (`motor.ts`, `respostasDesde`; `atendimento.ts`).
 */
import { interpolateTemplate } from "../../inbox/template-vars";
import type { ConfigDisparo, Proibido } from "../config";
import { type Chip, chipNaVolta } from "../fila";
import { naoContatarMarcado } from "../regras";
import type { Sortear } from "../ritmo";
import { verificarTexto } from "../textos";
import { destinoPermitido, envioRealLiberado, MOTIVO_ALLOWLIST, motivoDoSimulado } from "../trava";
import type { ConversaGuardada, RepositorioAtendimento } from "./atendimento";
import type { ConfigAtendimento } from "./config";
import { conversaNova } from "./estado";
import { planejarFollowupKit } from "./followup-kit";
import { avaliarHumano } from "./humano";
import { ehCliente } from "./venda";

export type TipoDeMidia = "audio" | "image" | "video" | "document";
export type Presenca = "nenhuma" | "digitando" | "gravando";

/** Teto da presença ("digitando/gravando") de um passo. A Evolution segura a chamada enquanto ela dura. */
export const PRESENCA_MAX_MS = 25_000;
/** Distância mínima entre dois passos do mesmo funil: mantém a ordem mesmo quando um passo é adiado. */
export const PASSO_MIN_MS = 1_000;
/** O primeiro passo sai de 2 a 5 s depois do clique. */
export const PRIMEIRO_MIN_MS = 2_000;
export const PRIMEIRO_MAX_MS = 5_000;
/** Áudio com texto vira duas partes; o texto chega este tempo depois do áudio (a cadência que já valia). */
export const PAUSA_DEPOIS_DE_AUDIO_MS = 31_000;

/** Um modelo de mensagem da organização (`message_templates`), com o anexo já resolvido. */
export type ModeloDaParte = {
  /** Atalho do modelo, SEM a barra (ou o id, quando o modelo não tem atalho): só para nomear o modelo nos erros. */
  atalho: string;
  titulo: string;
  /** Texto cru, com `{{nome}}`/`{{primeiro_nome}}`. */
  corpo: string;
  midia: { id: string; kind: TipoDeMidia; nome: string; tamanhoBytes: number } | null;
};

export type PassoParaAgendar = { modelo: ModeloDaParte; atrasoMs: number; presenca: Presenca; presencaMs: number };

export type FunilParaAgendar = { id: string; titulo: string; atalho: string; passos: PassoParaAgendar[] };

export type ParteDaSequencia = {
  atalho: string;
  texto: string;
  midia: { id: string; kind: TipoDeMidia; nome: string; segundos: number | null } | null;
};

export type EnvioDaSequencia = {
  leadId: string;
  chipId: string;
  tipo: string;
  texto: string;
  midiaId: string | null;
  midiaNome: string | null;
  enviarApos: Date;
  /** "digitando/gravando" que o canal mostra logo antes do envio; a chegada é `enviarApos + presencaMs`. */
  presenca: Presenca;
  presencaMs: number;
  estado: "pendente" | "simulado";
  motivo: string | null;
};

export type CodigoDoErroDaSequencia = "sequencia" | "sem_lead" | "motor_desligado" | "chip" | "modelo" | "allowlist" | "ja_agendada" | "ja_enviada";

/** Erro que o operador vê. `status` é o HTTP da rota. */
export class ErroDaSequencia extends Error {
  constructor(
    readonly codigo: CodigoDoErroDaSequencia,
    mensagem: string,
    readonly status: number,
    readonly detalhes?: Record<string, unknown>,
  ) {
    super(mensagem);
    this.name = "ErroDaSequencia";
  }
}

export interface RepositorioSequencia {
  /** `disparo_config` da organização. null = sem motor configurado. */
  config(org: string): Promise<ConfigDisparo | null>;
  /** Lead aberto do contato da conversa. null = a conversa não tem lead aberto. */
  leadDaConversa(org: string, conversationId: string): Promise<string | null>;
  lead(org: string, leadId: string): Promise<{ id: string; nome: string | null; telefone: string | null; status: string; bloqueado: boolean; anonimizado: boolean } | null>;
  /** Cria (ou acha) o lead da conversa no funil de entrada. null = não deu (contato bloqueado, sem funil…). */
  garantirLead(org: string, conversationId: string): Promise<string | null>;
  /** O chip ligado à sessão de canal da conversa (qualquer estado). null = a conversa não sai por chip do motor. */
  chipDaConversa(org: string, conversationId: string): Promise<Chip | null>;
  /** Funil visível ao usuário (compartilhado ou dele), pelo id ou pelo atalho. null = não existe. */
  funil(org: string, usuarioId: string, ref: { funnelId?: string; atalho?: string }): Promise<FunilParaAgendar | null>;
  /** Modelo visível ao usuário pelo id. null = não existe. */
  modeloPorId(org: string, usuarioId: string, templateId: string): Promise<ModeloDaParte | null>;
  /** Quantas partes de sequência do operador ainda estão por sair (pendentes ou enviando) para o lead. */
  emAberto(org: string, leadId: string): Promise<number>;
  /** Grava todas as partes de uma vez (tudo ou nada). */
  enfileirar(org: string, envios: EnvioDaSequencia[]): Promise<void>;
  /** Cancela as partes de sequência do operador ainda pendentes do lead. Devolve quantas. */
  cancelar(org: string, leadId: string, motivo: string): Promise<number>;
  /**
   * Quando a sequência `prefixo` saiu de verdade (`enviado`) para o lead pela última vez desde `desde`. null = não saiu.
   * Ausente = não confere.
   */
  ultimoEnvioDaSequencia?(org: string, leadId: string, prefixo: string, desde: Date): Promise<Date | null>;
  /** `Idempotency-Key`: a resposta do pedido já atendido com esta chave para esta conversa nas últimas 24 h. */
  repeticaoDoPedido?(org: string, conversationId: string, chave: string): Promise<Record<string, unknown> | null>;
  /** Partes do funil do operador nascidas desde `desde` para o lead (a faixa de andamento da conversa). */
  andamento?(org: string, leadId: string, desde: Date): Promise<AndamentoDoFunil>;
  /**
   * Lembretes do kit depois do funil do operador (`followupKit.aposFunilDoOperador`): ver
   * `planejarKitAposFunilDoOperador`. Devolve o trecho do resumo ("" = nada a dizer). Ausente = não planeja.
   */
  planejarKitAposFunil?(org: string, p: PedidoDeKitAposFunil): Promise<string>;
  /**
   * Cancela os toques do kit (`kit_t*`) e a oferta do Método (`metodo_oferta_*`) pendentes da lead, quando a opção
   * `aposFunilDoOperador` está ligada. Devolve quantos. Ausente = não cancela.
   */
  cancelarKitDoLead?(org: string, leadId: string, motivo: string): Promise<number>;
}

export type PedidoDeKitAposFunil = {
  leadId: string;
  /** O chip da conversa (por onde o funil saiu). */
  chipId: string;
  /** Chegada planejada da última parte do funil: de onde contam os dias dos toques. */
  base: Date;
  /** Prefixo do `tipo` do funil na fila (`funil_valores`). */
  prefixo: string;
  agora: Date;
  sortear: Sortear;
};

export type AndamentoDoFunil = { enviadas: number; total: number; pendentes: number; proximaEm: Date | null; prefixo: string | null };

/** A mesma sequência que saiu para o lead neste intervalo só sai de novo com a confirmação do operador. */
export const JANELA_DE_REENVIO_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------ tempo ----

/** Bytes por segundo de um áudio de voz do WhatsApp (ogg/opus): calibrado nos dois áudios do funil real (64 s e 28 s). */
const BYTES_POR_SEGUNDO_DE_AUDIO = 9_300;

export function estimarSegundosDoAudio(bytes: number): number {
  return Math.round(Math.min(180, Math.max(4, bytes / BYTES_POR_SEGUNDO_DE_AUDIO)));
}

/**
 * Horário de cada passo. O atraso de um passo é contado da CHEGADA do anterior; a presença ocupa o FIM desse atraso
 * (não soma), então a mensagem chega no tempo programado:
 *   início₀ = agora + sorteio entre 2 e 5 s; chegada₀ = início₀ + presença₀
 *   chegadaᵢ = chegadaᵢ₋₁ + atrasoᵢ; presençaᵢ = min(presença pedida, 25 s, atrasoᵢ); enviarApósᵢ = chegadaᵢ − presençaᵢ
 * Os horários são gravados EXATOS em `enviar_apos`; quem os cumpre é o motor (`seguirSequencia`).
 */
export function planejarHorariosDoFunil(
  passos: { atrasoMs: number; presencaMs: number }[],
  agora: Date,
  sortear: Sortear,
): { enviarApos: Date; presencaMs: number }[] {
  const saida: { enviarApos: Date; presencaMs: number }[] = [];
  let chegada = 0;
  passos.forEach((p, i) => {
    if (i === 0) {
      const inicio = agora.getTime() + Math.round(PRIMEIRO_MIN_MS + sortear() * (PRIMEIRO_MAX_MS - PRIMEIRO_MIN_MS));
      const presenca = Math.max(0, Math.min(p.presencaMs, PRESENCA_MAX_MS));
      chegada = inicio + presenca;
      saida.push({ enviarApos: new Date(inicio), presencaMs: presenca });
      return;
    }
    const atraso = Math.max(0, p.atrasoMs);
    chegada += atraso;
    const presenca = Math.max(0, Math.min(p.presencaMs, PRESENCA_MAX_MS, atraso));
    // Horários estritamente crescentes (mínimo 1 s): dois passos com o mesmo `enviar_apos` saem fora de ordem quando o
    // primeiro falha e é adiado, porque o motor ordena e adia só por horário.
    const anterior = saida[i - 1]!.enviarApos.getTime();
    let enviar = chegada - presenca;
    if (enviar < anterior + PASSO_MIN_MS) {
      enviar = anterior + PASSO_MIN_MS;
      chegada = enviar + presenca;
    }
    saida.push({ enviarApos: new Date(enviar), presencaMs: presenca });
  });
  return saida;
}

// ------------------------------------------------------------------ partes ----

export type Montagem = { ok: true; partes: ParteDaSequencia[] } | { ok: false; motivo: string };

/**
 * Junta os modelos em partes prontas para sair: preenche `{{nome}}`/`{{primeiro_nome}}` (variável sem valor é erro:
 * ninguém revisa o que sai agendado, e `{{nome}}` chegaria ao lead), confere cada texto com o MESMO verificador e as
 * mesmas regras proibidas da casa que o motor usa, e separa áudio de texto (WhatsApp não tem legenda de áudio).
 */
export function montarPartesDaSequencia(modelos: ModeloDaParte[], nomeDoContato: string | null, proibidos: Proibido[]): Montagem {
  const partes: ParteDaSequencia[] = [];
  for (const m of modelos) {
    const texto = interpolateTemplate(m.corpo, { name: nomeDoContato }).trim();
    const sobra = /\{\{[^}]*\}\}/.exec(texto);
    if (sobra) return { ok: false, motivo: `o modelo /${m.atalho} usa ${sobra[0]} e esta conversa não tem esse dado` };
    if (!texto && !m.midia) return { ok: false, motivo: `o modelo /${m.atalho} está vazio (sem texto e sem anexo)` };
    if (texto) {
      const problemas = verificarTexto(texto, { proibidos });
      if (problemas.length) return { ok: false, motivo: `o texto do modelo /${m.atalho} foi barrado: ${problemas.join(", ")}` };
    }
    const midia = m.midia
      ? { id: m.midia.id, kind: m.midia.kind, nome: m.midia.nome, segundos: m.midia.kind === "audio" ? estimarSegundosDoAudio(m.midia.tamanhoBytes) : null }
      : null;
    if (midia?.kind === "audio" && texto) {
      partes.push({ atalho: m.atalho, texto: "", midia }, { atalho: m.atalho, texto, midia: null });
    } else {
      partes.push({ atalho: m.atalho, texto, midia });
    }
  }
  return partes.length ? { ok: true, partes } : { ok: false, motivo: "a sequência não tem nenhuma parte" };
}

/** Presença padrão de uma mensagem avulsa: "gravando" em áudio, "digitando" em texto, nada no resto. */
export function presencaPadrao(m: ModeloDaParte): { presenca: Presenca; presencaMs: number } {
  if (m.midia?.kind === "audio") return { presenca: "gravando", presencaMs: 6_000 };
  if (!m.midia) return { presenca: "digitando", presencaMs: 1_500 };
  return { presenca: "nenhuma", presencaMs: 0 };
}

// ------------------------------------------------------------------ agendar ----

export type DepsDeAgendar = {
  repo: RepositorioSequencia;
  agora: Date;
  /** `DISPARO_REAL_LIBERADO` e `DISPARO_SO_PARA` do servidor. */
  ambiente: Record<string, string | undefined>;
  sortear: Sortear;
};

export type ResultadoDaSequencia = {
  titulo: string;
  partes: number;
  /** `simulado` = ensaio: nada vai ao WhatsApp. */
  modo: "real" | "simulado";
  motivoSimulado: string | null;
  chip: string;
  primeiraEm: Date;
  /** Chegada planejada da última parte. */
  ultimaEm: Date;
  /** Do pedido até a chegada da última parte (planejado; o motor só alarga, se um limite do chip segurar alguma parte). */
  duracaoSeg: number;
  /** Lembretes do kit planejados depois do funil (`aposFunilDoOperador`). Ausente = não se aplica. */
  kit?: string;
};

export type PedidoDeSequencia = {
  conversationId: string;
  usuarioId: string;
  /** Exatamente um dos três. */
  funnelId?: string;
  atalho?: string;
  templateId?: string;
  confirmar?: boolean;
};

const nomeDoChip = (c: Chip) => c.nome ?? c.id.slice(0, 8);

const quando = (d: Date) =>
  d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Por que o chip não pode mandar agora, em português para o operador. */
function motivoDoChip(chip: Chip, agora: Date): string | null {
  const v = chipNaVolta(chip, agora);
  if (v.ok) return null;
  if (chip.estado === "pausado" || chip.estado === "desligado") return `o chip ${nomeDoChip(chip)} está ${chip.estado}`;
  if (chip.saude === "vermelho") return `o chip ${nomeDoChip(chip)} está com a saúde vermelha${chip.saudeMotivo ? ` (${chip.saudeMotivo})` : ""}`;
  return `o chip ${nomeDoChip(chip)} está em pausa${chip.pausadoAte ? ` até ${quando(chip.pausadoAte)}` : ""}`;
}

/** Prefixo do `tipo` na fila (regex `^[a-z0-9_:]{2,40}$`): o do funil é o atalho com `_` (o de valores segue `funil_valores`). */
const prefixoDoFunil = (atalho: string) => atalho.replaceAll("-", "_").slice(0, 34);
const prefixoDoModelo = (templateId: string) => `msg_${templateId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12)}`;

async function resolverFunil(repo: RepositorioSequencia, org: string, p: PedidoDeSequencia): Promise<{ funil: FunilParaAgendar; prefixo: string }> {
  const informados = [p.funnelId, p.atalho, p.templateId].filter(Boolean).length;
  if (informados !== 1) throw new ErroDaSequencia("sequencia", "Escolha um funil ou uma mensagem.", 422);
  if (p.templateId) {
    const modelo = await repo.modeloPorId(org, p.usuarioId, p.templateId);
    if (!modelo) throw new ErroDaSequencia("modelo", "Essa mensagem não existe mais. Nada foi agendado.", 422);
    return {
      funil: { id: p.templateId, titulo: modelo.titulo, atalho: modelo.atalho, passos: [{ modelo, atrasoMs: 0, ...presencaPadrao(modelo) }] },
      prefixo: prefixoDoModelo(p.templateId),
    };
  }
  const funil = await repo.funil(org, p.usuarioId, p.funnelId ? { funnelId: p.funnelId } : { atalho: p.atalho!.trim().replace(/^\//, "").toLowerCase() });
  if (!funil) throw new ErroDaSequencia("sequencia", `Não existe o funil ${p.atalho ? `/${p.atalho.replace(/^\//, "")}` : "escolhido"}.`, 422);
  if (!funil.passos.length) throw new ErroDaSequencia("modelo", `O funil "${funil.titulo}" não tem nenhuma mensagem. Nada foi agendado.`, 422);
  return { funil, prefixo: prefixoDoFunil(funil.atalho) };
}

export async function agendarSequencia(deps: DepsDeAgendar, org: string, p: PedidoDeSequencia): Promise<ResultadoDaSequencia> {
  const { repo, agora, ambiente } = deps;

  const { funil, prefixo } = await resolverFunil(repo, org, p);

  const chip = await repo.chipDaConversa(org, p.conversationId);
  if (!chip) {
    throw new ErroDaSequencia("chip", "Esta conversa não sai por um chip do motor de envio, então não dá para agendar. Nada foi agendado.", 409, {
      sem_chip_do_motor: true,
    });
  }

  // O motor só roda organização com `ligado` (configsLigadas): desligado, nada da fila sairia. Recusar AGORA é melhor
  // que agendar mensagem que ficaria presa. (A janela de resposta e a rampa, essas sim, não barram o envio manual.)
  const config = await repo.config(org);
  if (!config?.ligado) {
    throw new ErroDaSequencia("motor_desligado", "O motor de envio está desligado nesta organização: a mensagem não sairia. Nada foi agendado.", 409);
  }

  let leadId = await repo.leadDaConversa(org, p.conversationId);
  if (!leadId) leadId = await repo.garantirLead(org, p.conversationId);
  const lead = leadId ? await repo.lead(org, leadId) : null;
  if (!lead) throw new ErroDaSequencia("sem_lead", "Não consegui abrir um lead para esta conversa no CRM. Nada foi agendado.", 422);
  if (lead.bloqueado) throw new ErroDaSequencia("sem_lead", "O contato está bloqueado (pediu para não receber mensagens). Nada foi agendado.", 422);
  if (lead.anonimizado) throw new ErroDaSequencia("sem_lead", "O contato foi anonimizado (LGPD) e não pode receber mensagens. Nada foi agendado.", 422);
  if (!lead.telefone) throw new ErroDaSequencia("sem_lead", "O contato não tem telefone. Nada foi agendado.", 422);

  const semChip = motivoDoChip(chip, agora);
  if (semChip) {
    throw new ErroDaSequencia("chip", `Não agendei nada: ${semChip}. O chip é respeitado: tente de novo quando ele voltar.`, 409, {
      chip: nomeDoChip(chip),
      pausado_ate: chip.pausadoAte?.toISOString() ?? null,
    });
  }

  if ((await repo.emAberto(org, lead.id)) > 0) {
    throw new ErroDaSequencia("ja_agendada", "Já há um funil em andamento para este lead. Espere terminar ou cancele o atual.", 409);
  }

  // Caso real: a sequência já ENTREGUE passava (`emAberto` só olha pendente/enviando) e o lead recebeu
  // o funil duas vezes. Reenviar dentro de 24 h só com a confirmação explícita do operador. Mensagem avulsa não entra.
  if (!p.templateId && !p.confirmar && repo.ultimoEnvioDaSequencia) {
    const ultima = await repo.ultimoEnvioDaSequencia(org, lead.id, prefixo, new Date(agora.getTime() - JANELA_DE_REENVIO_MS));
    if (ultima) {
      throw new ErroDaSequencia(
        "ja_enviada",
        `O funil "${funil.titulo}" já saiu para este lead em ${quando(ultima)}. Para mandar de novo, confirme o reenvio. Nada foi agendado.`,
        409,
        { ultima_em: ultima.toISOString() },
      );
    }
  }

  // Cada passo vira uma ou duas partes (áudio com texto = duas); a parte extra herda a cadência que já valia.
  const partes: (ParteDaSequencia & { atrasoMs: number; presenca: Presenca; presencaMs: number })[] = [];
  for (const passo of funil.passos) {
    const montagem = montarPartesDaSequencia([passo.modelo], lead.nome, config.proibidos);
    if (!montagem.ok) throw new ErroDaSequencia("modelo", `${montagem.motivo}. Nada foi agendado.`, 422);
    montagem.partes.forEach((parte, i) =>
      partes.push(
        i === 0
          ? { ...parte, atrasoMs: passo.atrasoMs, presenca: passo.presenca, presencaMs: passo.presencaMs }
          : { ...parte, atrasoMs: PAUSA_DEPOIS_DE_AUDIO_MS, presenca: "digitando", presencaMs: 2_000 },
      ),
    );
  }

  const real = envioRealLiberado(config, ambiente);
  // O motor confere a allowlist de novo na hora de enviar; aqui o operador é avisado ANTES, não depois de a fila morrer.
  if (real && !destinoPermitido(lead.telefone, ambiente)) {
    throw new ErroDaSequencia("allowlist", `Este número não está na lista de destinos permitidos do servidor (${MOTIVO_ALLOWLIST}). Nada foi agendado.`, 409);
  }

  const horarios = planejarHorariosDoFunil(
    partes.map((x) => ({ atrasoMs: x.atrasoMs, presencaMs: x.presenca === "nenhuma" ? 0 : x.presencaMs })),
    agora,
    deps.sortear,
  );
  const motivoSimulado = real ? null : (motivoDoSimulado(config, ambiente) ?? "trava fechada");
  await repo.enfileirar(
    org,
    partes.map((parte, i) => ({
      leadId: lead.id,
      chipId: chip.id,
      tipo: `${prefixo}:${i + 1}`,
      texto: parte.texto,
      midiaId: parte.midia?.id ?? null,
      midiaNome: parte.midia?.nome ?? null,
      enviarApos: horarios[i]!.enviarApos,
      presenca: horarios[i]!.presencaMs > 0 ? parte.presenca : "nenhuma",
      presencaMs: horarios[i]!.presencaMs,
      estado: real ? ("pendente" as const) : ("simulado" as const),
      motivo: real ? null : `ensaio (simulado): ${motivoSimulado}`,
    })),
  );

  const ultima = horarios.at(-1)!;
  const ultimaEm = new Date(ultima.enviarApos.getTime() + ultima.presencaMs);

  // Lembretes do kit (retomada): só com o envio real e a opção ligada (a função confere o resto).
  // Mensagem avulsa não é funil. A falha nunca derruba o agendamento já gravado.
  let kit: string | undefined;
  if (real && !p.templateId && repo.planejarKitAposFunil) {
    try {
      kit = (await repo.planejarKitAposFunil(org, { leadId: lead.id, chipId: chip.id, base: ultimaEm, prefixo, agora, sortear: deps.sortear })) || undefined;
    } catch (e) {
      kit = `lembretes do kit não planejados (${e instanceof Error ? e.message.slice(0, 80) : "erro"})`;
    }
  }
  return {
    titulo: funil.titulo,
    partes: partes.length,
    modo: real ? "real" : "simulado",
    motivoSimulado,
    chip: nomeDoChip(chip),
    primeiraEm: horarios[0]!.enviarApos,
    ultimaEm,
    duracaoSeg: Math.round((ultimaEm.getTime() - agora.getTime()) / 1000),
    ...(kit ? { kit } : {}),
  };
}

// ------------------------------------------------------- kit depois do funil ----

/** A opção está ligada (e, com `prefixo`, vale para este funil)? Config do atendimento já lida. */
export function kitAposFunilLigado(at: ConfigAtendimento | null | undefined, prefixo?: string): boolean {
  if (!at || at.perfil !== "venda" || !at.ligado || !at.followupKit?.ligado) return false;
  const ap = at.followupKit.aposFunilDoOperador;
  return ap.ligado && (prefixo === undefined || ap.funis.includes(prefixo));
}

/**
 * O operador mandou o funil de valores à mão: a lead viu a tabela, então ganha os mesmos lembretes do kit que o
 * atendimento planeja (`planejarFollowupKit`). Só com `followupKit.aposFunilDoOperador.ligado`, o funil na lista
 * `funis`, a lead contatável, não cliente (`ehCliente`, com a exceção do teste A/B), sem humano no comando e com a
 * conversa em `respondeu`/`qualificando` (quem está fechando é do operador).
 * Faz, nesta ordem: (a) cancela os toques e a oferta do Método pendentes (repetir o funil não duplica); (b) grava na
 * conversa que a tabela saiu (`tabelaEnviada`, degrau 0) e, com `liberaOperador`, dá a pendência como atendida;
 * (c) planeja os toques a partir de `base`. Nunca lança: a falha vira trecho do resumo e um aviso na Central.
 */
export async function planejarKitAposFunilDoOperador(
  deps: { repo: RepositorioAtendimento; cancelarKit: (org: string, leadId: string, motivo: string) => Promise<number> },
  org: string,
  p: PedidoDeKitAposFunil,
): Promise<string> {
  const { repo } = deps;
  const nao = (motivo: string) => `lembretes do kit não planejados (${motivo})`;
  try {
    const cfg = await repo.config(org);
    const at = cfg?.atendimento;
    if (!cfg || !at || at.perfil !== "venda" || !at.followupKit || !kitAposFunilLigado(at, p.prefixo)) return "";
    const ap = at.followupKit.aposFunilDoOperador;
    const lead = await repo.lead(org, p.leadId);
    if (!lead || lead.bloqueado || lead.anonimizado || lead.status !== "open") return nao("lead não contatável");
    if (naoContatarMarcado(lead.campos)) return nao("lead em não contatar");
    if (ehCliente(at, lead)) return nao("lead é cliente");
    const guardada = await repo.conversa(org, p.leadId);
    const conversa: ConversaGuardada = guardada ?? { ...conversaNova(), ultimaAutoEm: null };
    if (conversa.quente || (conversa.etapa !== "respondeu" && conversa.etapa !== "qualificando")) return nao(`conversa em ${conversa.etapa}`);
    if (conversa.dados.metodo.etapa !== "nenhuma") return nao("lead no funil do Método");
    if (conversa.precisaOperador && !ap.liberaOperador) return nao("conversa com o operador");
    const { veto } = avaliarHumano(await repo.situacaoHumana(org, p.leadId, null), p.agora);
    if (veto) return nao(`humano no comando: ${veto.motivo}`);

    await deps.cancelarKit(org, p.leadId, "funil de valores mandado pelo operador: lembretes do kit replanejados");
    const d = conversa.dados;
    // Quem já viu a tabela e desceu na escada fica no degrau dela.
    if (!d.tabelaEnviada) d.degrau = 0;
    d.tabelaEnviada = true;
    d.explicacaoEnviada ??= true;
    if (conversa.etapa === "respondeu") conversa.etapa = "qualificando";
    if (ap.liberaOperador) Object.assign(conversa, { precisaOperador: false, motivoOperador: null });
    await repo.salvarConversa(org, p.leadId, conversa);

    const f = await planejarFollowupKit(repo, org, {
      at,
      lead,
      chipId: p.chipId,
      dados: conversa.dados,
      base: p.base,
      ritmo: cfg.disparo.ritmo,
      proibidos: cfg.disparo.proibidos,
      sortear: p.sortear,
    });
    return f.resumo;
  } catch (e) {
    const motivo = e instanceof Error ? e.message.slice(0, 120) : "erro";
    try {
      await repo.avisar(org, {
        leadId: p.leadId,
        nivel: "operador",
        titulo: "Lembretes do kit não planejados depois do funil",
        corpo: `O funil foi agendado, mas os lembretes do kit não: ${motivo}. Confira a conversa e acompanhe à mão.`,
      });
    } catch {
      // O aviso é o melhor esforço: o agendamento já está gravado.
    }
    return nao(motivo);
  }
}

// ------------------------------------------------------------------ cancelar ----

export async function cancelarSequencia(
  deps: { repo: RepositorioSequencia },
  org: string,
  p: { conversationId: string },
): Promise<{ canceladas: number; toquesDoKit: number }> {
  const leadId = await deps.repo.leadDaConversa(org, p.conversationId);
  if (!leadId) throw new ErroDaSequencia("sem_lead", "Esta conversa não tem um lead aberto no CRM.", 422);
  const canceladas = await deps.repo.cancelar(org, leadId, "sequência cancelada pelo operador");
  // Os lembretes do kit planejados depois do funil (`aposFunilDoOperador`) caem junto.
  const toquesDoKit = (await deps.repo.cancelarKitDoLead?.(org, leadId, "sequência cancelada pelo operador")) ?? 0;
  return { canceladas, toquesDoKit };
}
