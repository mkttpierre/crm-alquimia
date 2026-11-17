/**
 * Atendimento, perfil PROSPECÇÃO (venda para empresa). Portado em linha geral
 * do CRM da organização B (`src/lib/atendimento.ts`, `leitura.ts`, `convite.ts`),
 * SEM a agenda: oferecer, escolher e confirmar horário de call ficam com o
 * operador até a Fase 6 (Google Agenda). Funções puras.
 *
 * O caminho, do jeito que a casa ensina:
 *   recusa educada  → pergunta o motivo, uma vez; "não" de novo encerra
 *   objeção         → responde com pergunta, uma vez cada; quem decide junto
 *                     ganha resposta própria e aviso
 *   interesse claro → convite do diagnóstico (texto + link com o código do
 *                     cartão), quando nada impede; senão, operador com o lead
 *                     quente
 *   preço, horário, "quem é", o resto → operador
 */
import type { Proibido } from "../config";
import { normalizar } from "../leitura";
import { irritado as ehIrritado, lerResposta, podeResponderSozinho } from "../regras";
import type { ConfigProspeccao } from "./config";
import type { Acao, Decisao, EstadoConversa, LeadDoAtendimento } from "./estado";
import { montarResposta } from "./pecas";
import { corpoDoAviso } from "./venda";

export type Pedido = "valor" | "ligacao" | "como_funciona" | "saber_mais" | "topou";
export type IntencaoProspeccao = "parada" | "numero_errado" | "recusa" | "objecao" | "interesse" | "horario" | "quem_e" | "outro";

export type LeituraProspeccao = {
  intencao: IntencaoProspeccao;
  pedido?: Pedido;
  objecao?: string;
  irritado: boolean;
  confianca: number;
  resumo: string;
};

const PEDIDO: [Pedido, RegExp][] = [
  ["valor", /quanto (custa|fica|e|seria|cobra|sai|ficaria|voce cobra|vc cobra|e o valor)|qual (e )?(o |seria o )?(valor|preco|investimento|custo)|\bvalores\b|\bpreco\b|\borcamento\b|me (passa|manda|envia|fala) (o |os )?(valor|preco|orcamento)|quanto (eu )?(vou )?(pagar|investir)/],
  ["ligacao", /(pode|podemos|poderia|consegue|quer) (me )?ligar|\bme liga\b|liga (pra|para) mim|(prefiro|melhor) (por )?(ligacao|telefone)|pode ligar|vamos (nos )?falar por telefone/],
  ["como_funciona", /como (funciona|seria|e o (trabalho|servico|projeto)|voce faz|vc faz)|me explica|explica (melhor|como)|do que se trata|que tipo de (servico|trabalho|projeto)|o que (voce|vc) (faz|oferece|vende)|qual (e )?a proposta/],
  ["saber_mais", /(quero|queria|gostaria de) (saber|entender|conhecer|ver) (mais|melhor|como)|(?<!nao )(tenho|temos) interesse|(?<!nao )(?<!nao me )interess(a|ei|ou)\b|fiquei interessad|(pode|poderia) (me )?(mandar|enviar|passar) (mais )?(informac|detalhe)|me conta mais/],
  ["topou", /\b(podemos|vamos|bora) (marcar|conversar|agendar|ver)|pode (me )?mostrar|(pode|podemos) marcar|aceito|\bpode sim\b|\bclaro\b|\bsim,? (pode|quero|claro|tenho|vamos)/],
  // Resposta à prévia do site: "quero ver", "pode mandar", "manda aí", "gostei", "ficou lindo".
  ["topou", /(?<!nao )\bquero (ver|sim)\b|(?<!nao )\bpode (mandar|enviar)\b|\bmanda (ai|sim|la|ele|o site|pra mim)\b|\bme (manda|envia)\b|(?<!nao )\bgostei\b|\bficou (lind|bonit|top|show|otim|massa|legal|muito bom|perfeit)/],
];
const NAO_CURTO = /^(nao|n|nop|nope|nao mesmo|nao obrigad[oa]|nao,? valeu|deixa|deixa pra la|esquece|dispenso|nenhum|nada|so isso mesmo|nao tenho mesmo|nao quero mesmo)[\s!.,]*$/;
const QUEM_E = /^(quem (e|fala|e voce|ta falando|esta falando)|com quem eu falo|qual (empresa|o seu nome)|de onde (voce|vc) (e|fala))/;
const HORARIO = /\b(segunda|terca|quarta|quinta|sexta|sabado|amanha|hoje)\b.{0,30}\b(\d{1,2}(h|:\d{2}| ?horas)|manha|tarde)\b|\b\d{1,2}(h|:\d{2})\b/;
/** Pedidos que contam como interesse claro (preço fica com o operador: só se trata na call). */
const PEDIDOS_CLAROS = new Set<Pedido>(["topou", "saber_mais", "como_funciona", "ligacao"]);

export function lerMensagemProspeccao(
  texto: string,
  c: ConfigProspeccao,
  ctx: { estado: EstadoConversa["dados"]["estadoProspeccao"]; golpeEhParada: boolean },
): LeituraProspeccao {
  const t = normalizar(texto).replace(/\s+/g, " ").trim();
  const irritado = ehIrritado(texto);
  const parada = lerResposta(texto, { golpeEhParada: ctx.golpeEhParada });
  if (parada === "parada") return { intencao: "parada", irritado, confianca: 0.95, resumo: "pediu pra parar" };
  if (parada === "numero_errado") return { intencao: "numero_errado", irritado, confianca: 0.9, resumo: "número errado" };
  if ((ctx.estado === "pediu_motivo" || ctx.estado === "objecao_respondida") && NAO_CURTO.test(t)) {
    return { intencao: "recusa", irritado, confianca: 0.85, resumo: "disse não de novo" };
  }
  const objecao = c.objecoes.find((o) => {
    try {
      return new RegExp(o.gatilho).test(t);
    } catch {
      return false;
    }
  });
  const pedido = PEDIDO.find(([, re]) => re.test(t))?.[0];
  if (parada === "nao_quer_mais") {
    // "Não tenho interesse, já tenho agência": o motivo veio junto; vale a objeção.
    if (objecao) return { intencao: "objecao", objecao: objecao.id, irritado, confianca: 0.85, resumo: `recusou: ${objecao.descricao}` };
    return { intencao: "recusa", irritado, confianca: 0.9, resumo: "recusa educada" };
  }
  if (pedido && pedido !== "topou") return { intencao: "interesse", pedido, irritado, confianca: 0.85, resumo: `pedido: ${pedido}` };
  if (objecao) return { intencao: "objecao", objecao: objecao.id, irritado, confianca: 0.8, resumo: `objeção: ${objecao.descricao}` };
  if (HORARIO.test(t)) return { intencao: "horario", irritado, confianca: 0.7, resumo: "falou de horário" };
  if (pedido === "topou" || (ctx.estado === "livre" && /^(sim|pode|pode ser|quero|claro|com certeza|tenho sim|vamos)\b/.test(t))) {
    return { intencao: "interesse", pedido: "topou", irritado, confianca: 0.75, resumo: "topou a conversa" };
  }
  if (QUEM_E.test(t)) return { intencao: "quem_e", irritado, confianca: 0.8, resumo: "perguntou quem é" };
  return { intencao: "outro", irritado, confianca: 0.3, resumo: "outra coisa" };
}

/** Por que NÃO mandar o diagnóstico sozinho (o operador decide), ou null quando pode. */
export function motivoSemConvite(
  c: ConfigProspeccao,
  lead: LeadDoAtendimento,
  l: LeituraProspeccao,
  estado: EstadoConversa,
): string | null {
  if (!c.diagnostico) return "a casa não tem diagnóstico configurado";
  if (!l.pedido || !PEDIDOS_CLAROS.has(l.pedido)) return "o pedido não é interesse claro (preço e dúvida vão pro operador)";
  if (l.confianca < 0.7) return "a leitura da mensagem não ficou clara";
  if (l.irritado) return "o lead escreveu irritado";
  if (estado.dados.estadoProspeccao !== "livre") return "a conversa já estava em andamento";
  if (estado.dados.recusou) return "o lead já recusou ou levantou objeção antes";
  if (estado.dados.diagnosticoEnviadoEm) return "o diagnóstico já foi mandado pra esse lead";
  const codigo = lead.campos[c.diagnostico.campoCodigo];
  if (typeof codigo !== "string" || !codigo.trim()) return "o lead não tem código do cartão";
  const etapa = lead.campos["etapa"];
  if (c.diagnostico.etapasAntesDaConversa.length && !(typeof etapa === "string" && c.diagnostico.etapasAntesDaConversa.includes(etapa))) {
    return "o lead já passou da cadência";
  }
  return null;
}

export const urlDoDiagnostico = (base: string, codigo: string) => `${base.replace(/\/$/, "")}/?c=${encodeURIComponent(codigo)}#diagnostico`;

export type EntradaProspeccao = {
  config: ConfigProspeccao;
  leitura: LeituraProspeccao;
  texto: string;
  estado: EstadoConversa;
  lead: LeadDoAtendimento;
  limiteAutomaticas: number;
  proibidos: Proibido[];
  agora: Date;
  fusoMinutos: number;
};

export function decidirProspeccao(e: EntradaProspeccao): Decisao {
  const { config: c, leitura: l, texto, lead } = e;
  const estado: EstadoConversa = { ...e.estado, dados: { ...e.estado.dados } };
  const d = estado.dados;
  const acoes: Acao[] = [];
  let respondeu = false;
  /** O que esta decisão atingiu; a organização decide quais viram ponto de parada (`./parada.ts`). */
  const eventos: string[] = [];
  const fim = (resumo: string): Decisao => {
    if (respondeu) estado.autoSeguidas += 1;
    return { acoes, estado, resumo, eventos };
  };
  const avisar = (nivel: "operador" | "info", titulo: string) =>
    acoes.push({ tipo: "avisar", nivel, titulo: `Atendimento: ${titulo}`.slice(0, 200), corpo: corpoDoAviso(lead, texto) });
  const operador = (titulo: string, quente = false): Decisao => {
    estado.precisaOperador = true;
    estado.motivoOperador = titulo;
    if (quente) {
      estado.quente = true;
      eventos.push("lead_quente");
    }
    d.estadoProspeccao = "aguardando_operador";
    avisar("operador", titulo);
    return fim(`pro operador (${titulo})`);
  };
  const ctx = { lead, agora: e.agora, fusoMinutos: e.fusoMinutos, proibidos: e.proibidos };
  const responder = (id: string, extras?: Record<string, string>): boolean => {
    if (!respondeu && !podeResponderSozinho(Array<string>(estado.autoSeguidas).fill("auto"), e.limiteAutomaticas)) return false;
    const m = montarResposta(c.respostas, id, { ...ctx, extras });
    if (!m.ok) return false;
    acoes.push({ tipo: "responder", resposta: id, partes: m.partes });
    respondeu = true;
    return true;
  };

  if (estado.etapa === "nao_contatar") return { acoes, estado, resumo: "lead na lista de não contatar: só registrado" };
  if (l.intencao === "parada" || l.intencao === "numero_errado" || l.irritado) {
    const motivo = l.intencao === "numero_errado" ? "Número errado" : `Pediu pra parar: "${texto.slice(0, 80)}"`;
    acoes.push({ tipo: "encerrar", etapa: "nao_contatar", motivo, irritada: l.irritado });
    Object.assign(estado, { etapa: "nao_contatar", quente: false, precisaOperador: false, motivoOperador: null });
    return { acoes, estado, resumo: "encerrado (parada dura)" };
  }
  if (estado.etapa === "perdido") return operador("lead encerrado escreveu de novo: ver se vale reabrir");

  switch (l.intencao) {
    case "recusa": {
      if (d.estadoProspeccao === "pediu_motivo" || d.estadoProspeccao === "objecao_respondida") {
        acoes.push({ tipo: "encerrar", etapa: "perdido", motivo: "Disse não de novo", irritada: false });
        Object.assign(estado, { etapa: "perdido", quente: false, precisaOperador: false, motivoOperador: null });
        return { acoes, estado, resumo: "disse não de novo: encerrado" };
      }
      if (!responder("motivo")) return operador("recusou (sem resposta automática): perguntar o motivo do não");
      d.estadoProspeccao = "pediu_motivo";
      d.recusou = true;
      estado.quente = false;
      return fim("recusa educada: pergunta do motivo na fila");
    }
    case "objecao": {
      const obj = l.objecao!;
      if (obj === c.objecaoDecisor) {
        const saiu = responder(`objecao_${obj}`);
        avisar("info", `quem decide junto (${saiu ? "resposta da casa na fila" : "nada saiu"}): trazer quem decide pra conversa`);
        return fim("decide com outra pessoa: resposta + aviso");
      }
      const ja = d.objecoesRespondidas;
      if (ja.includes(obj)) return operador(`objeção de novo (${obj}): responder com pergunta`);
      if (!responder(`objecao_${obj}`)) return operador(`objeção (${obj}): responder com pergunta`);
      d.objecoesRespondidas = [...ja, obj];
      d.estadoProspeccao = "objecao_respondida";
      d.recusou = d.recusou || lerResposta(texto) === "nao_quer_mais";
      estado.quente = false;
      estado.etapa = "qualificando";
      return fim(`objeção (${obj}): resposta da casa na fila`);
    }
    case "interesse": {
      const sem = motivoSemConvite(c, lead, l, estado);
      if (!sem && c.diagnostico) {
        const codigo = String(lead.campos[c.diagnostico.campoCodigo]);
        const convite = responder("diagnostico_convite");
        const link = convite && responder("diagnostico_link", { link: urlDoDiagnostico(c.diagnostico.url, codigo) });
        if (convite && link) {
          d.diagnosticoEnviadoEm = e.agora.toISOString();
          estado.quente = true;
          estado.etapa = "qualificando";
          eventos.push("diagnostico_enviado");
          avisar("info", "interesse claro: mandei o convite do diagnóstico");
          return fim("interesse claro: diagnóstico na fila (texto e link)");
        }
        // Uma das duas não passou: nenhuma sai.
        acoes.splice(0, acoes.length);
        respondeu = false;
      }
      // Sem diagnóstico (abordagem com prévia): o próximo passo é o demo completo do site.
      if (!c.diagnostico) return operador(`lead quente (${l.pedido ?? "interesse"}): quer ver o site completo; montar o demo (/produzir) e mandar hoje`, true);
      return operador(`lead quente (${l.pedido ?? "interesse"}): oferecer 2 horários`, true);
    }
    case "horario":
      eventos.push("horario");
      return operador("falou de horário: confirmar a call com o lead (agenda é com você)", true);
    case "quem_e":
      return operador("perguntou quem é: responder com calma e voltar ao assunto");
    default:
      return operador(d.estadoProspeccao === "pediu_motivo" ? "deu o motivo do não: responder com pergunta" : "respondeu: responder e puxar pra conversa");
  }
}
