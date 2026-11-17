/**
 * Atendimento: o que acontece quando o lead responde. Portado de um motor anterior
 * (`receberDoLead` + `processarLeituras`) e da organização B, como módulo por
 * organização. "Trava primeiro, pensa depois": a fila do lead para na hora; a
 * leitura (regras e, se houver chave, o Jev) e a decisão vêm em seguida; na
 * dúvida nada sai e o operador decide, por um item na Central
 * (`agent_inbox_items`) — NUNCA por WhatsApp.
 *
 * O atendimento NÃO conhece canal. O que ele decide mandar vira linha em
 * `disparo_envios` com `origem = 'auto'`:
 *   - trava fechada (`lib/disparo/trava.ts`, qualquer combinação que não seja
 *     modo real + DISPARO_REAL_LIBERADO=sim): estado `simulado`, e acabou;
 *   - trava aberta: estado `pendente`, e quem leva ao canal é o motor, que
 *     confere a mesma trava de novo antes de tocar no adapter.
 * Não há import de `lib/channels` neste diretório (o teste da trava confere).
 *
 * O banco passa todo por `RepositorioAtendimento`; o teste roda o atendimento
 * inteiro contra um repositório em memória.
 */
import type { ConfigDisparo, Ritmo } from "../config";
import { combinar, lerMensagem, normalizar, type Leitura } from "../leitura";
import { ehRespostaAutomatica } from "../resposta-automatica";
import { dentroDaJanela, horaDeResponder, MIN, type Sortear } from "../ritmo";
import { envioRealLiberado, motivoDoSimulado } from "../trava";
import { planejar, planejarComJev, type Plano } from "./agente";
import type { ConfigAtendimento, ConfigDeParada, JanelaResposta, Midia } from "./config";
import { conversaNova, type Acao, type EstadoConversa, type EtapaAtendimento, type LeadDoAtendimento, type LeituraFinal, type NivelDoAviso } from "./estado";
import type { MovimentoDoFunil } from "./funil";
import type { Julgar } from "./jev";
import { lerComJev } from "./leitura-jev";
import { avaliarHumano, type SituacaoHumana } from "./humano";
import { planejarFollowupKit } from "./followup-kit";
import { avisoDoPonto, pontosAcionados } from "./parada";
import { pausaApos } from "./pecas";
import { decidirProspeccao, lerMensagemProspeccao, type LeituraProspeccao } from "./prospeccao";
import { aceitaOMetodo, corpoDoAviso, decidirVenda, ehCliente, quantidadeSolta } from "./venda";
import { planejarRetornoReserva } from "./retorno-reserva";
import { naoContatarMarcado } from "../regras";

export type MensagemDoLead = {
  /** Chave de idempotência (o external_id da mensagem; no ensaio, "ensaio:<uuid>"). */
  chave: string;
  messageId: string | null;
  /** Texto (várias mensagens seguidas podem vir juntas). null = só mídia. */
  texto: string | null;
  midia: boolean;
  /** Conversa (`conversations.id`) em que a mensagem chegou; null no ensaio ou quando não se sabe. */
  conversationId?: string | null;
};

export type LeadComSituacao = LeadDoAtendimento & { bloqueado: boolean; anonimizado: boolean; status: string };

export type ConversaGuardada = EstadoConversa & { ultimaAutoEm: Date | null };

export type EnvioDoAtendimento = {
  leadId: string;
  chipId: string | null;
  tipo: string;
  texto: string;
  midia: Midia | null;
  enviarApos: Date;
  estado: "simulado" | "pendente";
  motivo: string | null;
  /** Decidida junto com um ponto de parada que pausa a conversa: a pausa do próprio ponto não a cancela. */
  daParada?: boolean;
  /**
   * `auto` (padrão): resposta à lead. `motor`: mensagem planejada que o motor trata como a dele (toque do
   * follow-up do kit, D7 e D14 do Método): entra no ritmo, tem tipo único por lead e o atendimento a cancela
   * quando a lead escreve.
   */
  origem?: "auto" | "motor";
};

/** O que aconteceu com o aviso ao celular do operador. */
export type DesfechoDoAviso = "simulado" | "pendente" | "ja_havia" | "sem_chip";

export interface RepositorioAtendimento {
  /** Config do disparo + do atendimento da organização. null = organização sem motor. */
  config(org: string): Promise<{ disparo: ConfigDisparo; atendimento: ConfigAtendimento | null } | null>;
  lead(org: string, leadId: string): Promise<LeadComSituacao | null>;
  conversa(org: string, leadId: string): Promise<ConversaGuardada | null>;
  salvarConversa(org: string, leadId: string, c: ConversaGuardada): Promise<void>;
  /** Reserva a leitura da mensagem (idempotente pela chave). null = já foi lida. */
  reservarLeitura(org: string, r: { chave: string; messageId: string | null; leadId: string; chipId: string | null; texto: string }): Promise<string | null>;
  concluirLeitura(org: string, leituraId: string, r: { leitura: Record<string, unknown>; decisao: string; irritada: boolean }): Promise<void>;
  /**
   * Quem está no comando: `contacts.force_human` e as conversas abertas do contato
   * (silêncio, dono humano). `conversationId` entra mesmo encerrada. Ver `./humano.ts`.
   */
  situacaoHumana(org: string, leadId: string, conversationId: string | null): Promise<SituacaoHumana>;
  /**
   * Chip por onde responder: o da conversa `conversationId` (a da mensagem), senão o do último envio com chip, senão o
   * da conversa mais recente do contato num chip do motor. null = a lead não conversa por chip nenhum do motor.
   */
  chipDoLead(org: string, leadId: string, conversationId?: string | null): Promise<string | null>;
  /** O último texto que saiu (ou simulou sair) para o lead. */
  nossaUltima(org: string, leadId: string): Promise<string | null>;
  /** Alguém do time escreveu para o lead depois de `desde` (fora do que o disparo mandou)? */
  operadorFalouDesde(org: string, leadId: string, desde: Date): Promise<boolean>;
  /** `poupaParada`: não cancela as respostas `daParada` (o pacote já decidido). */
  cancelarPendentesDoLead(org: string, leadId: string, motivo: string, poupaParada?: boolean, poupaRetorno?: boolean): Promise<number>;
  cancelarRetornoReserva(org: string, leadId: string, motivo: string): Promise<number>;
  registrarEventoRetorno(org: string, leadId: string, envioId: string): Promise<void>;
  /** Quando sai a última resposta automática já agendada para o lead (depois de `agora`), se houver. */
  fimDaFila(org: string, leadId: string, agora: Date): Promise<Date | null>;
  enfileirar(org: string, e: EnvioDoAtendimento): Promise<void>;
  /** Quantos toques do follow-up do kit já saíram (ou foram simulados) para a lead. Ausente = 0. */
  toquesDoKitEnviados?(org: string, leadId: string): Promise<number>;
  /** A oferta do Método já saiu (ou foi simulada) para a lead, por qualquer caminho. Ausente = não. */
  ofertaDoMetodoJaSaiu?(org: string, leadId: string): Promise<boolean>;
  /** Lead aberto do contato de uma conversa do inbox (comandos do operador, como o funil). null = a conversa não tem lead aberto. Ausente = null. */
  leadDaConversa?(org: string, conversationId: string): Promise<string | null>;
  /**
   * Trava por lead (A3): uma leitura de cada vez. `dono` identifica quem tomou; true = tomou. A trava expira sozinha
   * (`TRAVA_DO_LEAD_MS`) se quem tomou morrer. Ausentes = sem trava (como antes).
   */
  tomarTravaDoLead?(org: string, leadId: string, dono: string): Promise<boolean>;
  /**
   * A conversa foi a `nao_contatar` (a lead pediu para parar, número errado, irritação): marca o lead
   * (`crm_leads.custom_fields.nao_contatar = true`), que é o que o motor, o `/funil-valores` e os toques futuros leem.
   */
  marcarNaoContatar?(org: string, leadId: string): Promise<void>;
  /**
   * A abertura fria sai sem conversa no inbox (só nasce quando o lead responde), então a D1 não aparecia no histórico.
   * Copia para a conversa o que o motor já mandou ao lead por este chip e ainda não está lá. Nunca lança. Ausente = nada.
   */
  espelharHistoricoDoDisparo?(org: string, leadId: string, conversationId: string): Promise<number>;
  soltarTravaDoLead?(org: string, leadId: string, dono: string): Promise<void>;
  avisar(org: string, a: { leadId: string; nivel: NivelDoAviso; titulo: string; corpo: string }): Promise<void>;
  fecharAvisosDoLead(org: string, leadId: string): Promise<void>;
  /** Leituras irritadas do chip desde `desde` (esta inclusive). */
  irritacoesDoChip(org: string, chipId: string, desde: Date): Promise<number>;
  pesarNoChip(org: string, chipId: string, patch: { saude: "amarelo" | "vermelho"; pausadoAte?: Date }): Promise<void>;
  /**
   * Move o card do lead para a etapa do funil equivalente (`slug`, do mapa da
   * organização). Devolve o desfecho (`./funil.ts`); nunca lança por conflito.
   */
  moverNoFunil(org: string, leadId: string, m: { etapa: EtapaAtendimento; slug: string | null; modo: "simulado" | "real" }): Promise<MovimentoDoFunil>;
  /**
   * PONTO DE PARADA: pausa o atendimento automático das conversas do contato pelo
   * mesmo mecanismo do botão "pausar" da tela (`bot_silenced_until='infinity'`).
   * Devolve quantas conversas foram pausadas (0 = o lead não tem conversa).
   */
  pararConversa(org: string, leadId: string, conversationId: string | null, motivo: string): Promise<number>;
  /** PONTO DE PARADA: move o card para a etapa (e funil) do ponto. Nunca lança por conflito. */
  moverParaEtapa(org: string, leadId: string, m: { pipeline: string | null; etapa: string; pontoId: string; modo: "simulado" | "real" }): Promise<MovimentoDoFunil>;
  /** PONTO DE PARADA: etiqueta no lead e na conversa (sem duplicar). */
  aplicarTag(org: string, leadId: string, conversationId: string | null, tag: string): Promise<void>;
  /**
   * PONTO DE PARADA: aviso ao WhatsApp pessoal do operador, pelo chip em que a lead
   * conversa. Grava a linha na saída de avisos (`disparo_avisos_operador`: nasce
   * `simulado` com a trava fechada, `pendente` com ela aberta, e quem leva ao canal é
   * o motor, depois do pacote) e o registro na timeline do lead. Nunca fala com o lead
   * nem com o canal. `enviarApos` é depois do último envio já agendado do lead.
   * `{chip}` no `texto` é trocado pelo nome do chip em que a lead conversa.
   */
  avisarCelular(
    org: string,
    a: { leadId: string; conversationId: string | null; chipId: string | null; ponto: string; destino: string; texto: string; enviarApos: Date; modo: "simulado" | "real" },
  ): Promise<{ desfecho: DesfechoDoAviso }>;
}

export type DepsDoAtendimento = {
  repo: RepositorioAtendimento;
  agora: Date;
  ambiente: Record<string, string | undefined>;
  julgar: Julgar;
  /** Fonte de sorte (minutos do começo da janela de resposta). Padrão `Math.random`; o teste fixa. */
  sortear?: Sortear;
  /** Espera da trava por lead (A3). Padrão `setTimeout`; o teste encurta. */
  dormir?: (ms: number) => Promise<void>;
};

export type ResultadoDoAtendimento = {
  resultado: "repetida" | "sem_lead" | "sem_atendimento" | "registrada" | "decidida";
  resumo: string;
  envios: number;
  avisos: number;
  modo: "simulado" | "real";
};

/** Espera antes da primeira parte sair (ninguém responde no mesmo segundo). */
const ATRASO_INICIAL_SEG = 40;
/** O aviso ao celular do operador sai este tanto depois da última parte do pacote. */
const AVISO_APOS_PACOTE_SEG = 15;
const H = 60 * MIN;
/** Quanto uma mensagem espera a leitura anterior da MESMA lead terminar (o Jev leva de centenas de ms a segundos). */
export const ESPERA_DA_TRAVA_MS = 20_000;
const PASSO_DA_TRAVA_MS = 250;
/** Validade da trava do lead: se quem a tomou morrer, ela expira sozinha. */
export const TRAVA_DO_LEAD_MS = 60_000;

export async function atenderMensagem(deps: DepsDoAtendimento, org: string, leadId: string, m: MensagemDoLead): Promise<ResultadoDoAtendimento> {
  const { repo } = deps;
  const cfg = await repo.config(org);
  const real = cfg ? envioRealLiberado(cfg.disparo, deps.ambiente) : false;
  const base = { envios: 0, avisos: 0, modo: real ? ("real" as const) : ("simulado" as const) };
  if (!cfg?.atendimento?.ligado) return { ...base, resultado: "sem_atendimento", resumo: "atendimento desligado na organização" };
  const at = cfg.atendimento;
  const ritmo = cfg.disparo.ritmo;

  const lead = await repo.lead(org, leadId);
  if (!lead) return { ...base, resultado: "sem_lead", resumo: "lead não existe" };
  const texto = m.texto?.trim() || (m.midia ? "(áudio)" : "");
  const chipId = await repo.chipDoLead(org, leadId, m.conversationId ?? null);
  const leituraId = await repo.reservarLeitura(org, { chave: m.chave, messageId: m.messageId, leadId, chipId, texto });
  if (!leituraId) return { ...base, resultado: "repetida", resumo: "mensagem já lida" };

  // A3: uma leitura por lead de cada vez. Duas mensagens seguidas chegam em webhooks paralelos; sem a trava, as duas
  // liam a conversa antes de a outra gravar e agendavam dois funis. A segunda espera a primeira terminar e decide sobre
  // o estado que ela deixou. Trava presa demais (outra leitura travada): nada no automático, o operador é avisado.
  const dono = `leitura:${leituraId}`;
  if (!(await travarLead(deps, org, leadId, dono))) {
    const resumo = "outra mensagem desta lead ainda está em leitura: nada decidido no automático, operador avisado";
    await repo.avisar(org, {
      leadId,
      nivel: "operador",
      titulo: "Mensagens seguidas da lead: confira e responda na mão",
      corpo: `A lead mandou outra mensagem enquanto a anterior ainda era lida, e a leitura anterior não terminou a tempo. Esta não foi decidida no automático: "${texto.slice(0, 300)}"`,
    });
    await repo.concluirLeitura(org, leituraId, { leitura: { intencao: "nao_avaliada", trava: "ocupada" }, decisao: resumo, irritada: false });
    return { ...base, avisos: 1, resultado: "registrada", resumo };
  }
  try {
    return await atenderComTrava(deps, org, leadId, m, { cfg: { ...cfg, atendimento: at }, at, ritmo, lead, texto, chipId, leituraId, real, base });
  } finally {
    await repo.soltarTravaDoLead?.(org, leadId, dono);
  }
}

/** Espera pela trava do lead (A3) até `ESPERA_DA_TRAVA_MS`. Repositório sem trava: segue como antes. */
async function travarLead(deps: DepsDoAtendimento, org: string, leadId: string, dono: string): Promise<boolean> {
  const { repo } = deps;
  if (!repo.tomarTravaDoLead) return true;
  const dormir = deps.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i * PASSO_DA_TRAVA_MS <= ESPERA_DA_TRAVA_MS; i++) {
    if (await repo.tomarTravaDoLead(org, leadId, dono)) return true;
    await dormir(PASSO_DA_TRAVA_MS);
  }
  return false;
}

async function atenderComTrava(
  deps: DepsDoAtendimento,
  org: string,
  leadId: string,
  m: MensagemDoLead,
  p: {
    cfg: { disparo: ConfigDisparo; atendimento: ConfigAtendimento };
    at: ConfigAtendimento;
    ritmo: Ritmo;
    lead: LeadComSituacao;
    texto: string;
    chipId: string | null;
    leituraId: string;
    real: boolean;
    base: { envios: number; avisos: number; modo: "real" | "simulado" };
  },
): Promise<ResultadoDoAtendimento> {
  const { repo, agora } = deps;
  const { cfg, at, ritmo, lead, texto, chipId, leituraId, real, base } = p;

  if (m.conversationId) await repo.espelharHistoricoDoDisparo?.(org, leadId, m.conversationId);

  const guardada = await repo.conversa(org, leadId);
  const conversa: ConversaGuardada = guardada ?? { ...conversaNova(), ultimaAutoEm: null };
  // "Seguidas" é sem o operador no meio: se alguém do time escreveu depois da última automática, zera.
  if (conversa.autoSeguidas && conversa.ultimaAutoEm && (await repo.operadorFalouDesde(org, leadId, conversa.ultimaAutoEm))) {
    conversa.autoSeguidas = 0;
  }

  // Lead bloqueado (opt-out da ingestão, LGPD) ou encerrado no atendimento: só registra.
  if (lead.bloqueado || lead.anonimizado || naoContatarMarcado(lead.campos) || conversa.etapa === "nao_contatar") {
    if (conversa.dados.retornoEm) {
      await repo.cancelarRetornoReserva(org, leadId, "retorno cancelado: lead não contatável");
      conversa.dados.retornoEm = null;
      if (guardada) await repo.salvarConversa(org, leadId, conversa);
    }
    await repo.concluirLeitura(org, leituraId, { leitura: { intencao: "nao_avaliada" }, decisao: "lead não contatável: só registrado", irritada: false });
    return { ...base, resultado: "registrada", resumo: "lead não contatável: só registrado" };
  }

  // Uma pessoa no comando (force_human, conversa pausada, dono humano): só registra.
  // Vale para os dois perfis e vence qualquer leitura — nada sai, e o que estava na
  // fila automática do lead não sai mais. O interruptor por conversa é o par
  // pause-ai / reactivate-bot da tela (ver `./humano.ts`).
  // A pausa que o próprio ponto de parada pôs (só silêncio) não derruba o pacote que ele
  // decidiu mandar: `poupaParada`. Quem assumiu de fato (force_human, dono) cancela tudo.
  const { veto: humano, vetoDuro } = avaliarHumano(await repo.situacaoHumana(org, leadId, m.conversationId ?? null), agora);
  if (humano) {
    if (conversa.dados.retornoEm) {
      conversa.dados.retornoEm = null;
      await repo.salvarConversa(org, leadId, conversa);
    }
    const ficou = await repo.cancelarPendentesDoLead(org, leadId, `humano no comando (${humano.motivo})`, !vetoDuro);
    const resumo = `humano no comando: ${humano.detalhe}; só registrado${ficou ? ` · ${ficou} da fila cancelada` : ""}`;
    await repo.concluirLeitura(org, leituraId, { leitura: { intencao: "nao_avaliada", humano: humano.motivo }, decisao: resumo, irritada: false });
    return { ...base, resultado: "registrada", resumo };
  }

  // Saudação pronta do WhatsApp Business (cupom, horário, "digite 1"): não é o lead respondendo. Só registra; a cadência
  // segue e ninguém é avisado (Forneria Exemplo virou lead quente pelo "Das 18:00").
  if (m.texto?.trim() && ehRespostaAutomatica(m.texto)) {
    const resumo = "resposta automática do negócio: só registrada, a cadência segue";
    await repo.concluirLeitura(org, leituraId, { leitura: { intencao: "resposta_automatica" }, decisao: resumo, irritada: false });
    return { ...base, resultado: "registrada", resumo };
  }

  // Trava: o que estava na fila para esse lead não sai mais (cadência e respostas antigas).
  // (o pacote de um ponto de parada já decidido continua: o lead escrever no meio não o derruba)
  const canceladas = await repo.cancelarPendentesDoLead(org, leadId, "o lead escreveu", true, true);

  const comum = {
    texto,
    estado: conversa,
    lead,
    limiteAutomaticas: ritmo.limiteAutomaticasSeguidas,
    proibidos: cfg.disparo.proibidos,
    agora,
    fusoMinutos: ritmo.fusoMinutos,
  };
  let leituraGravada: Record<string, unknown>;
  let irritada: boolean;
  let decisao;
  if (at.perfil === "venda") {
    const nossa = await repo.nossaUltima(org, leadId);
    // Método: a oferta que o motor mandou pelo follow-up (o atendimento não a viu sair) vale como oferecida.
    if (at.metodo?.ligado && conversa.dados.metodo.etapa === "nenhuma" && (await repo.ofertaDoMetodoJaSaiu?.(org, leadId))) {
      conversa.dados.metodo = { ...conversa.dados.metodo, etapa: "ofertado", oferecido: true };
    }
    const toquesEnviados = at.followupKit?.ligado ? ((await repo.toquesDoKitEnviados?.(org, leadId)) ?? 0) : 0;
    // "tenho 4" depois da tabela é a quantidade: a leitura e o agente veem "quero o de 4 meses"; o aviso guarda a frase literal.
    const perguntaEstoque = /\bquant[oa]s?\b.*\b(frascos?|potes?|unidades?)\b.*\b(resta|sobr|tem|possui|ainda)/.test(normalizar(nossa ?? ""));
    const respostaEstoque = perguntaEstoque && /^(?:(?:eu|ainda|ja)\s+)*(?:(?:tenho|restam?|sobram?)\s+)?\d{1,2}(?:\s+(?:frascos?|potes?|unidades?))?(?:\s+ainda)?[.! ]*$/.test(normalizar(texto).trim());
    const lida = respostaEstoque ? texto : quantidadeSolta(texto, conversa.dados.tabelaEnviada) ?? texto;
    const leituraOriginal = await lerVenda(deps.julgar, lida, m.midia, ritmo.golpeEhParada, nossa, at.contextoJev, ehCliente(at, lead));
    const leitura = respostaEstoque ? { ...leituraOriginal, intencao: "outro" as const, kit: null } : leituraOriginal;
    // Método ofertado e a lead aceitou ou pediu explicação: a decisão responde pelo funil do Método (4c de `venda.ts`, antes do plano),
    // então o plano do agente (que poderia gastar mais uma chamada de Jev) não é consultado.
    const aceiteDoMetodo = Boolean(at.metodo?.ligado) && conversa.dados.metodo.etapa === "ofertado" && aceitaOMetodo(normalizar(lida).replace(/\s+/g, " ").trim(), leitura.intencao);
    const plano: Plano = aceiteDoMetodo ? { tipo: "nenhum" } : await planoDoAgente(deps.julgar, at, lida, leitura, conversa, nossa);
    decisao = decidirVenda({ ...comum, config: at, leitura, plano, toquesEnviados });
    leituraGravada = { intencao: leitura.intencao, kit: leitura.kit, irritada: leitura.irritada, confianca: leitura.confianca, resumo: leitura.resumo, fonte: leitura.fonte, discordou: leitura.discordou ?? false, plano: plano.tipo };
    irritada = leitura.irritada;
  } else {
    const leitura: LeituraProspeccao = m.midia && !m.texto?.trim()
      ? { intencao: "outro", irritado: false, confianca: 0, resumo: "mandou áudio ou mídia" }
      : lerMensagemProspeccao(texto, at, { estado: conversa.dados.estadoProspeccao, golpeEhParada: ritmo.golpeEhParada });
    decisao = decidirProspeccao({ ...comum, config: at, leitura });
    leituraGravada = { ...leitura, fonte: "regras" };
    irritada = leitura.irritado;
  }

  // Esta decisão vai parar a conversa? Então o que ela manda agora é o "último recado" e sobrevive à pausa.
  // Só término, compra ou transferência efetiva cancelam a reserva; conversa comum a preserva.
  // "Compro dia X": o retorno que ESTA decisão agendou ("vou comprar dia 20", lido como quer fechar) não
  // cai pelo `quer_fechar` dela mesma: a lead ouviu "te chamo no dia". O aviso do `quer_fechar` sai do mesmo jeito.
  const retornoDaCompraAgora = Boolean(decisao.retornoEm) && decisao.estado.dados.retornoPedido?.motivo === "compra";
  const cancelamPorCompra = retornoDaCompraAgora ? ["escolheu_kit", "pediu_site", "pediu_pix_metodo"] : ["quer_fechar", "escolheu_kit", "pediu_site", "pediu_pix_metodo"];
  const cancelarRetorno = decisao.acoes.some((a) => a.tipo === "encerrar") || decisao.estado.quente ||
    decisao.estado.etapa === "fechado" || (decisao.eventos ?? []).some((e) => cancelamPorCompra.includes(e));
  if (cancelarRetorno) {
    await repo.cancelarRetornoReserva(org, leadId, decisao.acoes.some((a) => a.tipo === "encerrar") ? "retorno cancelado: lead encerrado (recusa ou pediu para parar)" : "retorno cancelado: compra ou fechamento antecipado");
    decisao.estado.dados.retornoEm = null;
  }
  const vaiParar = pontosAcionados(at.parada, decisao.eventos ?? [], texto).some((x) => x.parar);
  const efeito = await aplicar(deps, org, leadId, chipId, decisao.acoes, { real, motivoSimulado: motivoDoSimulado(cfg.disparo, deps.ambiente), daParada: vaiParar, janela: at.janelaResposta, ritmo });
  const novo: ConversaGuardada = { ...decisao.estado, ultimaAutoEm: efeito.envios ? agora : conversa.ultimaAutoEm };
  await repo.salvarConversa(org, leadId, novo);
  // M2: a etapa da conversa sozinha não segurava o `/funil-valores` nem os toques planejados depois; o lead é marcado.
  if (novo.etapa === "nao_contatar") await repo.marcarNaoContatar?.(org, leadId);

  // Pontos de parada da organização (D4): o objetivo foi atingido, a conversa vai ao operador.
  const parou = await aplicarPontosDeParada(deps, org, { lead, texto, eventos: decisao.eventos ?? [], conversationId: m.conversationId ?? null, chipId, parada: at.parada, kit: novo.dados.kitEscolhido, jaAvisados: novo.dados.avisadosCompra, jaAvisou: decisao.acoes.some((a) => a.tipo === "avisar"), modo: base.modo, valor: novo.dados.metodo.valorCents });
  efeito.avisos += parou.avisos;
  if (parou.avisadosCompra.length) {
    novo.dados.avisadosCompra = [...new Set([...novo.dados.avisadosCompra, ...parou.avisadosCompra])];
    await repo.salvarConversa(org, leadId, novo);
  }

  let reserva = "";
  if (at.perfil === "venda" && decisao.retornoEm && !cancelarRetorno && !vaiParar) {
    reserva = await planejarRetornoReserva(repo, org, { cfg: cfg.disparo, at, lead, chipId, novo, agora, sortear: deps.sortear ?? Math.random });
  }

  // Follow-up do kit: quem viu a tabela e ainda não decidiu ganha os toques a partir DESTA mensagem
  // (os antigos já foram cancelados acima: "o lead escreveu").
  let seguimento = "";
  if (
    at.perfil === "venda" &&
    at.followupKit?.ligado &&
    !novo.dados.retornoEm &&
    novo.dados.tabelaEnviada &&
    !vaiParar &&
    !novo.quente &&
    !novo.precisaOperador &&
    (novo.etapa === "respondeu" || novo.etapa === "qualificando") &&
    novo.dados.metodo.etapa === "nenhuma" &&
    !decisao.acoes.some((a) => a.tipo === "encerrar") &&
    !ehCliente(at, lead)
  ) {
    const f = await planejarFollowupKit(repo, org, { at, lead, chipId, dados: novo.dados, base: agora, ritmo, proibidos: cfg.disparo.proibidos, sortear: deps.sortear ?? Math.random });
    seguimento = ` · ${f.resumo}`;
  }

  // A etapa da conversa mudou (ou a conversa nasceu): o card do funil acompanha, pelo mapa da organização.
  let funil = "";
  if (!guardada || novo.etapa !== conversa.etapa) {
    const mov = await repo.moverNoFunil(org, leadId, { etapa: novo.etapa, slug: at.funil[novo.etapa] ?? null, modo: base.modo });
    if (mov === "movido") funil = ` · card movido (${novo.etapa})`;
    else if (mov !== "sem_mapa" && mov !== "ja_esta_la") funil = ` · card não movido (${mov})`;
  }

  // Irritação pesa na saúde do chip (como nos dois CRMs): 1 no dia segura a rampa, 2 ou mais param 48h.
  if (irritada && chipId) {
    const n = await repo.irritacoesDoChip(org, chipId, new Date(agora.getTime() - 24 * H));
    await repo.pesarNoChip(org, chipId, n >= 2 ? { saude: "vermelho", pausadoAte: new Date(agora.getTime() + 48 * H) } : { saude: "amarelo" });
  }

  const semChip = real && !chipId && decisao.acoes.some((a) => a.tipo === "responder") ? " · sem chip para responder: nada foi para a fila, operador avisado" : "";
  const resumo = `${decisao.resumo}${semChip}${canceladas ? ` · ${canceladas} da fila cancelada` : ""}${funil}${parou.resumo}${reserva}${seguimento}`;
  await repo.concluirLeitura(org, leituraId, { leitura: leituraGravada, decisao: resumo, irritada });
  return { ...base, ...efeito, resultado: "decidida", resumo };
}

/**
 * Executa os pontos acionados. Cada efeito é independente (falha de um não impede
 * os outros: card que não moveu não pode deixar o operador sem aviso), e nenhum
 * toca o lead.
 *
 * ORDEM: quando este ponto é chamado, o que a decisão decidiu mandar ao lead (o pacote
 * de fechamento, os links) JÁ está na fila (`aplicar` roda antes). Só então a conversa
 * é pausada e o aviso ao celular entra na saída, marcado para depois do último envio
 * agendado — e o motor ainda o segura enquanto o lead tiver resposta por sair. A pausa
 * não cancela o pacote (`daParada`).
 */
export async function aplicarPontosDeParada(
  deps: Pick<DepsDoAtendimento, "repo" | "agora">,
  org: string,
  p: { lead: LeadDoAtendimento; texto: string; eventos: string[]; conversationId: string | null; chipId: string | null; parada: ConfigDeParada; kit: string | null; jaAvisados: string[]; jaAvisou: boolean; modo: "simulado" | "real"; valor?: number | null },
): Promise<{ avisos: number; resumo: string; avisadosCompra: string[] }> {
  const { repo } = deps;
  const pontos = pontosAcionados(p.parada, p.eventos, p.texto);
  if (!pontos.length) return { avisos: 0, resumo: "", avisadosCompra: [] };
  const avisadosCompra: string[] = [];
  const partes: string[] = [];
  let avisos = 0;
  const tentar = async (rotulo: string, fn: () => Promise<string | void>) => {
    try {
      const r = await fn();
      if (r) partes.push(r);
    } catch (e) {
      partes.push(`${rotulo} falhou (${e instanceof Error ? e.message.slice(0, 80) : "erro"})`);
    }
  };
  const motivo = `Atendimento parou: ${pontos.map((x) => x.titulo).join(", ")}`;

  if (pontos.some((x) => x.parar)) {
    await tentar("pausa", async () => {
      const n = await repo.pararConversa(org, p.lead.id, p.conversationId, motivo);
      return n ? `conversa pausada (${n})` : "sem conversa para pausar";
    });
  }
  for (const x of pontos) {
    if (x.etapa) {
      await tentar("card", async () => {
        const mov = await repo.moverParaEtapa(org, p.lead.id, { pipeline: x.pipeline ?? null, etapa: x.etapa!, pontoId: x.id, modo: p.modo });
        return mov === "movido" ? `card movido (${x.etapa})` : `card não movido (${mov})`;
      });
    }
    if (x.tag) await tentar("tag", async () => void (await repo.aplicarTag(org, p.lead.id, p.conversationId, x.tag!)));
    // Aviso de compra (quantidade ou "quero comprar"): uma vez por pedido. Quem já avisou a quantidade não avisa o "quero" depois.
    const deCompra = x.evento === "escolheu_kit" || x.evento === "quer_fechar";
    const repetido = deCompra && (p.jaAvisados.includes(x.id) || (x.evento === "quer_fechar" && p.parada.pontos.some((o) => o.evento === "escolheu_kit" && p.jaAvisados.includes(o.id))));
    if (x.notificar && p.parada.celular && repetido) partes.push("celular: este pedido de compra já foi avisado");
    else if (x.notificar && p.parada.celular) {
      await tentar("celular", async () => {
        const texto = avisoDoPonto(p.parada, x, p.lead, p.texto, p.kit, p.valor ? { valor: `R$ ${(p.valor / 100).toFixed(2).replace(".", ",")}` } : {});
        // Depois do último envio agendado do lead (o pacote), com a folga de ser humano.
        const fim = await repo.fimDaFila(org, p.lead.id, deps.agora);
        const enviarApos = new Date(Math.max(deps.agora.getTime() + 5_000, fim ? fim.getTime() + AVISO_APOS_PACOTE_SEG * 1000 : 0));
        const r = await repo.avisarCelular(org, {
          leadId: p.lead.id, conversationId: p.conversationId, chipId: p.chipId, ponto: x.id, destino: p.parada.celular!, texto, enviarApos, modo: p.modo,
        });
        if (deCompra && r.desfecho !== "ja_havia") avisadosCompra.push(x.id);
        if (r.desfecho === "pendente") return "celular: aviso na fila, sai pelo chip da conversa depois do pacote";
        if (r.desfecho === "sem_chip") return "celular: sem chip de origem, aviso só registrado";
        if (r.desfecho === "ja_havia") return "celular: já havia aviso deste ponto na fila";
        return "celular: aviso registrado (simulado)";
      });
    }
  }
  // O operador sempre fica sabendo: se a decisão não abriu aviso na Central, abre um. (Ponto que só avisa, sem parar
  // a conversa, não abre o "Atendimento parou" da Central: o aviso dele é o do celular.)
  if (!p.jaAvisou && pontos.some((x) => x.parar)) {
    await tentar("central", async () => {
      await repo.avisar(org, { leadId: p.lead.id, nivel: "operador", titulo: motivo, corpo: corpoDoAviso(p.lead, p.texto) });
      avisos++;
    });
  }
  return { avisos, resumo: ` · parada: ${pontos.map((x) => x.id).join(", ")} [${partes.join("; ")}]`, avisadosCompra };
}

async function lerVenda(
  julgar: Julgar,
  texto: string,
  midia: boolean,
  golpeEhParada: boolean,
  nossa: string | null,
  contexto: string,
  cliente: boolean,
): Promise<LeituraFinal> {
  if (texto === "(áudio)" && midia) {
    // Áudio não é transcrito aqui: nada sai, o operador ouve.
    return { intencao: "outro", kit: null, irritada: false, confianca: 0, resumo: "mandou áudio (ouvir)", fonte: "regras" };
  }
  const regras: Leitura = lerMensagem(texto, { golpeEhParada });
  if (/^https?:\/\/\S+$/i.test(texto.trim())) return regras;
  // Parada e número errado pelas regras não esperam o Jev: valem sempre.
  if (regras.intencao === "parada" || regras.intencao === "numero_errado") return regras;
  return combinar(regras, await lerComJev(julgar, { texto, nossaUltima: nossa, contexto, cliente }));
}

const QUEREM_PLANO = new Set(["outro", "objecao_funciona", "objecao_medo", "objecao_tempo", "sem_dinheiro_agora", "ja_comprou_outro"]);

async function planoDoAgente(julgar: Julgar, c: Parameters<typeof planejar>[0], texto: string, l: LeituraFinal, conv: EstadoConversa, nossa: string | null): Promise<Plano> {
  const estado = {
    objecoesUsadas: conv.dados.objecoesUsadas,
    kitMeses: conv.dados.kitEscolhido ? Number(/^(\d+) mes/.exec(conv.dados.kitEscolhido)?.[1]) || null : null,
    fechamentoEnviado: conv.dados.fechamentoEnviado,
  };
  const regras = planejar(c, texto, estado);
  if (regras.tipo !== "nenhum" || !QUEREM_PLANO.has(l.intencao)) return regras;
  return planejarComJev(c, texto, estado, nossa, julgar);
}

export async function aplicar(
  deps: DepsDoAtendimento,
  org: string,
  leadId: string,
  chipId: string | null,
  acoes: Acao[],
  trava: { real: boolean; motivoSimulado: string | null; daParada: boolean; janela: JanelaResposta; ritmo: Ritmo },
): Promise<{ envios: number; avisos: number }> {
  const { repo, agora } = deps;
  const sortear = deps.sortear ?? Math.random;
  let envios = 0;
  let avisos = 0;
  // Nunca fura a fila: uma resposta nova espera a última parte que ainda vai sair (um funil de valores em andamento).
  const fim = acoes.some((a) => a.tipo === "responder") ? await repo.fimDaFila(org, leadId, agora) : null;
  let quando = new Date(Math.max(agora.getTime() + ATRASO_INICIAL_SEG * 1000, fim ? fim.getTime() + 8000 : 0));
  let anterior: Acao | null = null;
  let semChipAvisado = false;
  for (const a of acoes) {
    if (a.tipo === "responder" && trava.real && !chipId) {
      // Sem chip por onde sair (a lead não conversa por nenhum chip do motor): a linha nasceria com chip_id NULL, nenhum
      // chip a pegaria e a lead ficaria parada sem ninguém saber. Nada entra na fila; o operador responde na mão.
      if (!semChipAvisado) {
        semChipAvisado = true;
        await repo.avisar(org, {
          leadId,
          nivel: "operador",
          titulo: "Sem chip para responder: responda na mão",
          corpo: `A lead escreveu numa conversa que não passa por nenhum chip do motor de disparo, então a resposta automática (${a.resposta}) não foi para a fila. Responda pela tela de conversas.`,
        });
        avisos++;
      }
      continue;
    }
    if (a.tipo === "responder") {
      // Entre duas respostas da mesma decisão (explicação e depois a tabela), a segunda espera a última parte da primeira.
      if (anterior?.tipo === "responder") quando = new Date(quando.getTime() + pausaApos(anterior.partes.at(-1)!, sortear) * 1000);
      const sequencia = a.partes.length > 1;
      for (const p of a.partes) {
        quando = daJanelaDeResposta(new Date(quando.getTime() + p.aposSeg * 1000), trava.janela, trava.ritmo, sortear);
        await repo.enfileirar(org, {
          leadId,
          chipId,
          tipo: sequencia ? `${a.resposta}:seq` : a.resposta,
          texto: p.texto,
          midia: p.midia,
          enviarApos: quando,
          estado: trava.real ? "pendente" : "simulado",
          motivo: trava.real ? null : `atendimento simulado: ${trava.motivoSimulado ?? "trava fechada"}`,
          daParada: trava.daParada,
        });
        envios++;
      }
      anterior = a;
    } else if (a.tipo === "avisar") {
      await repo.avisar(org, { leadId, nivel: a.nivel, titulo: a.titulo, corpo: a.corpo });
      avisos++;
    } else {
      await repo.cancelarPendentesDoLead(org, leadId, "lead encerrado");
      await repo.fecharAvisosDoLead(org, leadId);
    }
  }
  return { envios, avisos };
}

/**
 * Resposta só sai dentro da janela de resposta do atendimento (padrão 8h–22h, todo dia). Fora dela vai para
 * o começo da próxima janela, mais um sorteio de minutos (`horaDeResponder` com `respeitarJanela`). A janela
 * de prospecção do ritmo não entra: aqui vale uma janela única, sem feriado.
 */
export function daJanelaDeResposta(t: Date, janela: JanelaResposta, ritmo: Ritmo, sortear: Sortear): Date {
  const bloco = { inicio: janela.inicioMin, fim: janela.fimMin };
  const r: Ritmo = { ...ritmo, feriados: [], janela: { semana: [bloco], sabado: [bloco], domingo: [bloco] } };
  return dentroDaJanela(t, r) ? t : horaDeResponder(t, r, sortear, true);
}
