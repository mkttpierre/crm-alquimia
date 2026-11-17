/**
 * Resposta automática do negócio: o WhatsApp Business de muito comércio responde a primeira mensagem
 * com uma saudação pronta (cupom, link do app, horário de funcionamento, menu "digite 1"). Isso não é o lead
 * respondendo: não vira lead quente, não avisa o operador e não cancela a cadência. Função pura.
 *
 * Um sinal forte basta (frase que pessoa não escreve). Sinais fracos só valem juntos (dois ou mais), para não
 * confundir "obrigado pelo contato, mas não temos interesse" ou "manda o link" com robô.
 */
import { normalizar } from "./leitura";

const FORTES: RegExp[] = [
  /\bagradece (o |seu |sua |pelo |pela )?(seu |sua )?(contato|mensagem|visita)\b/,
  /\bagradecemos (o |seu |sua |pelo |pela |a )?(seu |sua )?(contato|mensagem)\b/,
  /\b(resposta|mensagem|atendimento) automatic[oa]\b/,
  /\bno momento,? (nao )?(estamos|estou) (disponive|atendendo|ausente|online|fora)/,
  /\bnao (estamos|estou) (disponive\w*|atendendo|online) no momento\b/,
  /\bfora do (nosso )?horario (de atendimento|de funcionamento|comercial)\b/,
  /\b(em breve|assim que possivel|o mais rapido possivel),? (retornaremos|responderemos|entraremos em contato)\b/,
  /\b(retornaremos|responderemos) (o |a |seu |sua |sua mensagem|em breve|assim que)/,
  /\bdigite\b.{0,25}\b\d\b/,
  /\bassistente virtual\b/,
];

const FRACOS: RegExp[] = [
  /\bhorario de (funcionamento|atendimento)\b/,
  /https?:\/\/|\bwww\./,
  /\bcupo[mn]\b/,
  /\bnosso (aplicativo|app|cardapio|catalogo|site|instagram|delivery)\b/,
  /\bendereco ?:/,
  /\bvolte sempre\b/,
  /\bseja (muito )?bem[- ]vind[oa]\b/,
  /\bbenvenut[oa]\b|\bwelcome\b/,
  /\bsera um prazer\b/,
  /\bnossa equipe (retornara|verificara|entrara em contato|respondera|atendera)\b/,
  /\bpode nos escrever\b/,
  /\bobrigad[oa] por (entrar em contato|nos contatar|sua mensagem|escolher)\b/,
  /\b(seg(unda)?|ter(ca)?|qua(rta)?|qui(nta)?|sex(ta)?|sab(ado)?|dom(ingo)?) a (seg(unda)?|ter(ca)?|qua(rta)?|qui(nta)?|sex(ta)?|sab(ado)?|dom(ingo)?)\b/,
];

/** A mensagem é saudação pronta de robô (WhatsApp Business, menu de atendimento)? */
export function ehRespostaAutomatica(texto: string): boolean {
  const t = normalizar(texto ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (FORTES.some((re) => re.test(t))) return true;
  return FRACOS.filter((re) => re.test(t)).length >= 2;
}
