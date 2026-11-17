/**
 * Saúde do chip, calculada (PLANO-DISPAROS 5.3): funções puras, sem banco e sem relógio.
 *
 * Quem lê o banco e grava é `lib/disparo/repositorio-supabase.ts`; quem decide quando
 * recalcular é o motor (`lib/disparo/motor.ts`). Aqui só vive a conta:
 *
 *   linhas cruas (aberturas, respostas, eventos de conexão)  →  `resumirSinais`
 *   sinais do dia  →  `calcularSaude`  →  cor + motivos  →  `acaoNoChip`  →  o que muda no chip
 *
 * Os indicadores, todos configuráveis em `Ritmo.saude`:
 *   - bloqueio provável: aberturas do dia ainda com 1 tique depois de 6 h;
 *   - "não quero" + "pare" sobre as aberturas do dia;
 *   - irritação, spam, denúncia, Procon: contagem no dia;
 *   - taxa de resposta, só depois de 30 aberturas (janela de 7 dias, porque num dia só a rampa não chega a 30);
 *   - conexão: close, 428 ou logout = vermelho; reconexão sem queda = amarelo.
 *
 * Amarelo segura a rampa (`abrirDia` só sobe com saúde verde). Vermelho para o chip por 48 h,
 * volta ao dia 1 e fica vermelho até a mão do operador: o cálculo nunca "cura" um vermelho.
 *
 * Dado que não chegou NÃO é dado ruim. Sem ack nenhum (a Evolution não mandou `messages.update`, ou
 * o envio foi simulado) o bloqueio provável fica "sem dado", nunca vermelho: a cobertura mínima
 * (`coberturaMinima`) e a amostra mínima (`amostraMinima`) guardam isso.
 */
import type { Ritmo } from "./config";
import type { Chip, SaudeChip } from "./fila";
import { encerraCadencia, irritado, lerResposta } from "./regras";
import { H, MIN } from "./ritmo";

export type ConfigDeSaude = Ritmo["saude"];

/** Uma abertura que saiu do chip (a janela inteira de dias da taxa de resposta). */
export type AberturaSaida = {
  leadId: string;
  estado: "enviado" | "simulado";
  enviadoEm: Date;
  /** Último ack da Evolution (1 um tique, 2 entregue, 3 lido, 4 ouvido). null = nenhum ack chegou. */
  ack: number | null;
  entregueEm: Date | null;
};

/** Mensagem de gente que o lead mandou (as automáticas já ficaram de fora). */
export type RespostaDoLead = { leadId: string; texto: string; em: Date };

/** Estado de conexão que o webhook da Evolution viu na sessão do chip. */
export type EventoDeConexao = { estado: string; codigo: number | null; em: Date };

export type SinaisDoDia = {
  /** Aberturas que saíram hoje (inclui as simuladas: o ensaio imita o real). */
  aberturas: number;
  /** Aberturas reais de hoje com mais de `horasSemEntrega` horas de vida. */
  maduras: number;
  /** Das maduras, quantas têm algum ack (a cobertura do dado). */
  comAck: number;
  /** Das maduras com ack, as que continuam em 1 tique e sem entrega. */
  bloqueioProvavel: number;
  /** Leads que hoje disseram "não quero"/"pare" (sem contar a irritação, que tem indicador próprio). */
  naoQuero: number;
  /** Mensagens de hoje com irritação, spam, denúncia ou Procon. */
  irritacao: number;
  /** Aberturas e respostas da janela longa (taxa de resposta). */
  aberturasJanela: number;
  respostasJanela: number;
  /** Respostas de hoje (para o painel). */
  respostas: number;
  /** Reconexões sem queda e quedas (close, 428, logout) hoje. */
  reconexoes: number;
  quedas: number;
};

export type Indicador = "bloqueio" | "nao_quero" | "irritacao" | "resposta" | "conexao";

export type MotivoDaSaude = { indicador: Indicador; cor: "amarelo" | "vermelho"; texto: string };

export type ResultadoDaSaude = {
  saude: SaudeChip;
  motivos: MotivoDaSaude[];
  /** Indicadores que não puderam ser avaliados e por quê (não pesam na cor). */
  semDado: string[];
  taxas: { bloqueio: number | null; naoQuero: number | null; resposta: number | null };
};

const ORDEM: Record<SaudeChip, number> = { verde: 0, amarelo: 1, vermelho: 2 };

/** A pior das duas cores. */
export const pior = (a: SaudeChip, b: SaudeChip): SaudeChip => (ORDEM[a] >= ORDEM[b] ? a : b);

const pct = (n: number) => `${(n * 100).toFixed(1).replace(".", ",")}%`;
const limite = (n: number) => `${Number((n * 100).toFixed(2)).toString().replace(".", ",")}%`;

/** `codigo` que a Evolution devolve quando o WhatsApp derruba a sessão: 428 (precondition required) e 401 (logout). */
const CODIGOS_DE_QUEDA = new Set([428, 401]);
const ESTADOS_DE_QUEDA = new Set(["close", "closed", "logout", "logged_out", "loggedout", "removed"]);

export function ehQueda(e: EventoDeConexao): boolean {
  return ESTADOS_DE_QUEDA.has(e.estado.toLowerCase()) || (e.codigo !== null && CODIGOS_DE_QUEDA.has(e.codigo));
}

/**
 * Quedas e reconexões do dia, em ordem do tempo. Queda = close, 428 ou logout. Reconexão = o chip voltou a
 * `open` depois de `connecting` SEM ter caído e após o limite configurado. Vários `connecting` na mesma
 * tentativa são medidos desde o primeiro; a volta a `open` conta no máximo uma vez.
 */
export function contarConexao(eventos: EventoDeConexao[], reconexaoMinSegundos = 30): { quedas: number; reconexoes: number } {
  let quedas = 0;
  let reconexoes = 0;
  let primeiroConnecting: number | null = null;
  let viuQueda = false;
  for (const e of [...eventos].sort((a, b) => a.em.getTime() - b.em.getTime())) {
    const estado = e.estado.toLowerCase();
    if (ehQueda(e)) {
      quedas++;
      viuQueda = true;
      primeiroConnecting = null;
    } else if (estado === "connecting") {
      primeiroConnecting ??= e.em.getTime();
    } else if (estado === "open") {
      if (primeiroConnecting !== null && !viuQueda && e.em.getTime() - primeiroConnecting > reconexaoMinSegundos * 1000) reconexoes++;
      primeiroConnecting = null;
      viuQueda = false;
    }
  }
  return { quedas, reconexoes };
}

/**
 * Linhas cruas → sinais do dia. `aberturas` é a janela longa de dias (a do chip); o resto do dia é
 * `inicioDoDia` em diante. `respostas` são só as mensagens de gente dos leads dessas aberturas.
 */
export function resumirSinais(
  entrada: {
    aberturas: AberturaSaida[];
    respostas: RespostaDoLead[];
    conexao: EventoDeConexao[];
    inicioDoDia: Date;
    agora: Date;
  },
  cfg: ConfigDeSaude,
  golpeEhParada = false,
): SinaisDoDia {
  const { inicioDoDia, agora } = entrada;
  const hoje = entrada.aberturas.filter((a) => a.enviadoEm.getTime() >= inicioDoDia.getTime());
  const idade = cfg.horasSemEntrega * H;
  const maduras = hoje.filter((a) => a.estado === "enviado" && agora.getTime() - a.enviadoEm.getTime() >= idade);
  const comAck = maduras.filter((a) => a.ack !== null);
  const bloqueio = comAck.filter((a) => (a.ack ?? 0) <= 1 && !a.entregueEm);

  // Uma resposta só vale para a abertura que veio antes dela (a mensagem anterior à abertura não é resposta).
  const abertaEm = new Map<string, number>();
  for (const a of entrada.aberturas) {
    const t = a.enviadoEm.getTime();
    const antes = abertaEm.get(a.leadId);
    if (antes === undefined || t < antes) abertaEm.set(a.leadId, t);
  }
  const validas = entrada.respostas.filter((r) => r.em.getTime() >= (abertaEm.get(r.leadId) ?? Infinity));
  const doDia = validas.filter((r) => r.em.getTime() >= inicioDoDia.getTime());

  const leadsDaJanela = new Set(entrada.aberturas.map((a) => a.leadId));
  const quemRespondeu = new Set(validas.map((r) => r.leadId));
  const respostasJanela = [...leadsDaJanela].filter((l) => quemRespondeu.has(l)).length;

  const aberturaHoje = new Map<string, number>();
  for (const a of hoje) aberturaHoje.set(a.leadId, Math.min(aberturaHoje.get(a.leadId) ?? Infinity, a.enviadoEm.getTime()));
  const recusaram = new Set<string>();
  let irritacao = 0;
  for (const r of doDia) {
    if (irritado(r.texto)) {
      irritacao++;
      continue;
    }
    const parada = lerResposta(r.texto, { golpeEhParada });
    if (encerraCadencia(parada) && parada !== "numero_errado" && r.em.getTime() >= (aberturaHoje.get(r.leadId) ?? Infinity)) recusaram.add(r.leadId);
  }

  const { quedas, reconexoes } = contarConexao(entrada.conexao.filter((e) => e.em.getTime() >= inicioDoDia.getTime()), cfg.reconexaoMinSegundos);
  return {
    aberturas: hoje.length,
    maduras: maduras.length,
    comAck: comAck.length,
    bloqueioProvavel: bloqueio.length,
    naoQuero: recusaram.size,
    irritacao,
    aberturasJanela: leadsDaJanela.size,
    respostasJanela,
    respostas: new Set(doDia.map((r) => r.leadId)).size,
    reconexoes,
    quedas,
  };
}

/** Sinais zerados (chip sem movimento no dia). */
export const SINAIS_ZERADOS: SinaisDoDia = {
  aberturas: 0, maduras: 0, comAck: 0, bloqueioProvavel: 0, naoQuero: 0, irritacao: 0,
  aberturasJanela: 0, respostasJanela: 0, respostas: 0, reconexoes: 0, quedas: 0,
};

/** Cor de uma taxa contra "até `amarelo` é verde, até `vermelho` é amarelo, acima é vermelho". */
function corDaTaxa(taxa: number, t: { amarelo: number; vermelho: number }): SaudeChip {
  if (taxa > t.vermelho) return "vermelho";
  if (taxa > t.amarelo) return "amarelo";
  return "verde";
}

/** Sinais do dia → cor e motivos. Não conhece o chip: não decide parar nada. */
export function calcularSaude(s: SinaisDoDia, cfg: ConfigDeSaude): ResultadoDaSaude {
  const motivos: MotivoDaSaude[] = [];
  const semDado: string[] = [];
  const taxas: ResultadoDaSaude["taxas"] = { bloqueio: null, naoQuero: null, resposta: null };
  const marcar = (indicador: Indicador, cor: SaudeChip, texto: string) => {
    if (cor !== "verde") motivos.push({ indicador, cor, texto });
  };

  // 1) Bloqueio provável: só com amostra e com cobertura de ack — sem dado não é 1 tique.
  if (s.maduras < cfg.amostraMinima) {
    if (s.aberturas > 0) semDado.push(`bloqueio provável: só ${s.maduras} aberturas com mais de ${cfg.horasSemEntrega} h (mínimo ${cfg.amostraMinima})`);
  } else if (s.comAck / s.maduras < cfg.coberturaMinima) {
    semDado.push(`bloqueio provável: a Evolution informou entrega de ${s.comAck} de ${s.maduras} aberturas (mínimo ${pct(cfg.coberturaMinima)})`);
  } else {
    const taxa = s.bloqueioProvavel / s.comAck;
    taxas.bloqueio = taxa;
    const cor = corDaTaxa(taxa, cfg.bloqueio);
    marcar("bloqueio", cor, `Bloqueio provável ${pct(taxa)} (${s.bloqueioProvavel} de ${s.comAck} aberturas com 1 tique depois de ${cfg.horasSemEntrega} h), limite ${limite(cor === "vermelho" ? cfg.bloqueio.vermelho : cfg.bloqueio.amarelo)}`);
  }

  // 2) "Não quero" + "pare" sobre as aberturas do dia.
  if (s.aberturas < cfg.amostraMinima) {
    if (s.naoQuero > 0) semDado.push(`não quero: ${s.naoQuero} no dia, mas só ${s.aberturas} aberturas (mínimo ${cfg.amostraMinima} para a %)`);
  } else {
    const taxa = s.naoQuero / s.aberturas;
    taxas.naoQuero = taxa;
    const cor = corDaTaxa(taxa, cfg.naoQuero);
    marcar("nao_quero", cor, `Não quero e pare ${pct(taxa)} (${s.naoQuero} de ${s.aberturas} aberturas do dia), limite ${limite(cor === "vermelho" ? cfg.naoQuero.vermelho : cfg.naoQuero.amarelo)}`);
  }

  // 3) Irritação, spam, denúncia, Procon: contagem, sem amostra mínima (uma denúncia basta).
  if (s.irritacao >= cfg.irritacao.vermelho) {
    marcar("irritacao", "vermelho", `${s.irritacao} respostas com irritação, spam, denúncia ou Procon no dia (vermelho a partir de ${cfg.irritacao.vermelho})`);
  } else if (s.irritacao >= cfg.irritacao.amarelo) {
    marcar("irritacao", "amarelo", `${s.irritacao} resposta com irritação, spam, denúncia ou Procon no dia (amarelo a partir de ${cfg.irritacao.amarelo})`);
  }

  // 4) Taxa de resposta, só depois da amostra de aberturas (janela de vários dias).
  if (s.aberturasJanela >= cfg.resposta.minAberturas) {
    const taxa = s.respostasJanela / s.aberturasJanela;
    taxas.resposta = taxa;
    if (taxa < cfg.resposta.vermelho) {
      marcar("resposta", "vermelho", `Taxa de resposta ${pct(taxa)} (${s.respostasJanela} de ${s.aberturasJanela} em ${cfg.resposta.janelaDias} dias), abaixo de ${limite(cfg.resposta.vermelho)}`);
    } else if (taxa < cfg.resposta.ok) {
      marcar("resposta", "amarelo", `Taxa de resposta ${pct(taxa)} (${s.respostasJanela} de ${s.aberturasJanela} em ${cfg.resposta.janelaDias} dias), abaixo de ${limite(cfg.resposta.ok)}: trocar o texto antes de seguir`);
    }
  } else if (s.aberturasJanela > 0) {
    semDado.push(`taxa de resposta: ${s.aberturasJanela} de ${cfg.resposta.minAberturas} aberturas necessárias`);
  }

  // 5) Conexão: queda é vermelho direto; reconexão é amarelo.
  if (s.quedas > 0) {
    marcar("conexao", "vermelho", `Conexão caiu ${s.quedas}x no dia (close, 428 ou logout)`);
  } else if (s.reconexoes >= cfg.reconexoesAmarelo) {
    marcar("conexao", "amarelo", `${s.reconexoes} reconexão no dia (amarelo a partir de ${cfg.reconexoesAmarelo})`);
  }

  const saude = motivos.reduce<SaudeChip>((cor, m) => pior(cor, m.cor), "verde");
  return { saude, motivos, semDado, taxas };
}

/** O que muda no chip quando a saúde calculada é `r` (a pior do dia já aplicada por quem chama). */
export function acaoNoChip(
  chip: Pick<Chip, "saude">,
  r: ResultadoDaSaude,
  cfg: ConfigDeSaude,
  agora: Date,
): { saude: SaudeChip; pausadoAte?: Date; diaRampa?: number; saudeMotivo: string | null } | null {
  // Vermelho é do operador: nem o cálculo nem o relógio o desfazem.
  if (chip.saude === "vermelho") return null;
  const motivo = r.motivos.length ? r.motivos.map((m) => m.texto).join("; ") : null;
  if (r.saude === "vermelho") {
    return { saude: "vermelho", pausadoAte: new Date(agora.getTime() + cfg.vermelhoHoras * 60 * MIN), diaRampa: 1, saudeMotivo: motivo };
  }
  return { saude: r.saude, saudeMotivo: motivo };
}

/** Já passou tempo bastante para recalcular a saúde deste chip? */
export const deveRecalcular = (calculadaEm: Date | null | undefined, agora: Date, cfg: ConfigDeSaude) =>
  cfg.ligado && (!calculadaEm || agora.getTime() - calculadaEm.getTime() >= cfg.recalcularACadaMin * MIN);

/** O que o repositório devolve para a conta (linhas cruas, já limitadas ao chip e à janela). */
export type DadosDaSaude = {
  aberturas: AberturaSaida[];
  respostas: RespostaDoLead[];
  conexao: EventoDeConexao[];
};

/** A saúde já gravada para o chip num dia (para a pior do dia vencer e para o vermelho não se repetir). */
export type SaudeGravada = { saude: SaudeChip; motivos: MotivoDaSaude[]; calculadoEm: Date };

/** A linha de `disparo_saude_dia` que o motor grava. */
export type LinhaDaSaudeDoDia = {
  chipId: string;
  /** Dia local, AAAA-MM-DD. */
  dia: string;
  saude: SaudeChip;
  diaRampa: number;
  estadoChip: string;
  sinais: SinaisDoDia;
  motivos: MotivoDaSaude[];
  calculadoEm: Date;
};
