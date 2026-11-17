/**
 * Regras de parada do motor de disparo — regra fixa, instantânea, sem IA.
 *
 * Portadas de dois motores antigos (`ritmo.ts#lerResposta` de cada um)
 * e unidas: a parada dura de um vale para o outro, com
 * uma exceção que é escolha da casa (`Ritmo.golpeEhParada`): "golpe" sozinho é
 * parada dura na venda para empresa e objeção de medo na venda para pessoa.
 *
 * Esta camada só decide o que o MOTOR faz (parar a cadência, não responder
 * sozinho). Quem grava `contacts.is_blocked` continua sendo a ingestão, pela
 * regra única de `lib/opt-out/deteccao.ts`; aqui não se escreve em contato.
 */

export type Parada = "parada" | "numero_errado" | "nao_quer_mais" | "conversa";

// Parada dura: encerra na hora, nenhuma mensagem, nenhum "por quê?" (perguntar o
// motivo aqui é pedir denúncia).
const PARADA = [
  /para de (me )?(mandar|chamar|encher)/,
  /pare de (me )?(mandar|chamar|encher)/,
  /n[aã]o me (chame|chama|mande|manda|procure|procura|envie|envia) mais/,
  /n[aã]o (quero|quer) (mais )?(receber|que me (mande|mandem|chame|chamem|envie))/,
  /me (tira|tire|remova|remove|exclua|exclui|retire|deixa|deixe) (da|dessa|desta|em) (lista|paz)/,
  /(tirar|tira|tire|remover|remove|remova|retirar|retire|excluir|exclui|exclua|apagar|apaga|apague) (o |os )?(meu|nosso)s? (n[uú]mero|contato|telefone|cadastro|whatsapp)/,
  /(quem|onde) (te|vc|voc[eê]) (deu|passou|conseguiu|arrumou|pegou) (o )?(meu|nosso|esse) (n[uú]mero|contato|telefone)/,
  /como (voc[eê]|vc) (conseguiu|pegou|achou) (o )?(meu|nosso|esse) (n[uú]mero|contato)/,
  /de onde (voc[eê]|vc) (tirou|pegou) (o )?(meu|nosso|esse) (n[uú]mero|contato)/,
  /\bspam\b/, /denunci/, /\bgolpista/, /vou (te )?bloquear/, /\bprocon\b/, /n[aã]o autorizei/, /\bsair da lista\b/,
  /^\s*(pare|para|chega)[\s.!]*$/,
  // Robô de empresa que recusa proposta comercial conta como parar.
  /n[aã]o (aceitamos|recebemos|trabalhamos com|atendemos) (propostas|ofertas|vendedor|representante)/,
  /propostas? comercia(l|is) (somente |s[oó] |apenas )?(por|via|pelo) e-?mail/,
  /\bporra\b/, /\bcaralho\b/, /\bmerda\b/, /vai se foder/, /\bfdp\b/, /\bvsf\b/, /\bpqp\b/, /\bcacete\b/,
];
const GOLPE = /\bgolpe\b/;

// Recusa educada: "não quero"/"não preciso" só contam sozinhos ou com um fecho,
// nunca com complemento ("não quero perder paciente" é conversa).
const NAO_QUER_MAIS = [
  /n[aã]o (tenho|temos|tem|teria|ter[ií]amos) (nenhum |mais )?interesse/,
  /sem interesse/,
  /n[aã]o (estou|estamos|esta|fico|ficamos) interessad/,
  /n[aã]o [eé] do (meu|nosso) interesse/,
  /n[aã]o,? obrigad/, /obrigad[oa],? mas n[aã]o/, /agrade[cç]o,? mas n[aã]o/, /\bdispenso\b/, /\bdispensamos\b/, /n[aã]o quero mais/,
  /n[aã]o (quero|queremos|preciso|precisamos)(\s*(,|\.|!|$|obrigad|nada|n[aã]o|agora|no momento|por enquanto|mais\b|isso|disso|desse|dessa|de nada))/,
];

const NUMERO_ERRADO = [
  /n[uú]mero errado/, /\bengano\b/,
  /n[aã]o (conhe[cç]o|sei quem [eé]) (voc[eê]|essa pessoa)/,
  /esse n[uú]mero n[aã]o [eé] (da|de)/,
  /aqui n[aã]o [eé] (a |uma )?(cl[ií]nica|consult[oó]rio|empresa)/,
  /n[aã]o (trabalho|sou) mais (a[ií]|da empresa|l[aá])/,
];

/** Lê a mensagem do lead pela régua de parada. */
export function lerResposta(texto: string, opcoes: { golpeEhParada?: boolean } = {}): Parada {
  const t = texto.toLowerCase();
  if (PARADA.some((r) => r.test(t)) || (opcoes.golpeEhParada && GOLPE.test(t))) return "parada";
  if (NUMERO_ERRADO.some((r) => r.test(t))) return "numero_errado";
  if (NAO_QUER_MAIS.some((r) => r.test(t))) return "nao_quer_mais";
  return "conversa";
}

/** Para a cadência inteira do lead? (recusa educada também para: ninguém insiste.) */
export const encerraCadencia = (p: Parada) => p !== "conversa";

// Resposta irritada ou ameaça: pesa na saúde do chip. "Golpe" sozinho fica de
// fora (é objeção de medo de compra pela internet, não irritação).
const IRRITADO =
  /\bspam\b|denunci|\bgolpista|\bporra\b|\bcaralho\b|\bmerda\b|vai se foder|\bfdp\b|\bvsf\b|\bpqp\b|\bprocon\b|vou (te )?bloquear|\bcrime\b|\bpol[ií]cia\b/;
export const irritado = (texto: string) => IRRITADO.test(texto.toLowerCase());

// Resposta automática de WhatsApp Business (ausência, boas-vindas): chega logo
// depois do nosso envio e tem cara de modelo pronto. O motor nunca responde robô.
const AUTOMATICA =
  /mensagem autom[aá]tica|resposta autom[aá]tica|no momento (n[aã]o )?(estamos|estou)|seja bem[- ]?vind|bem[- ]?vindo\(a\)|fora do (nosso )?hor[aá]rio|hor[aá]rio de atendimento|retornaremos (o )?(seu )?contato|agradecemos (o|seu|pelo) contato|em breve (nossa equipe|retornaremos|responderemos|entraremos|daremos)|digite (o n[uú]mero|\d)|escolha uma (das )?op[cç]|canal de atendimento|assistente virtual|logo (iremos|vamos) (te )?responder/i;
// Aviso de empresa (conta, fatura, código): robô a qualquer hora.
const AVISO_EMPRESA =
  /\b(sua|seu) (conta|fatura|boleto|protocolo)\b.*\b(vence|vencimento|venceu)\b|vencimento:\s*\d|valor:\s*r\$|c[oó]digo de (verifica[cç][aã]o|seguran[cç]a)|n[aã]o responda (a )?esta mensagem|\b0800\b/i;

export function respostaAutomatica(texto: string, segundosDesdeNossoEnvio: number | null, janelaSeg = 120): boolean {
  if (AVISO_EMPRESA.test(texto)) return true;
  return segundosDesdeNossoEnvio !== null && segundosDesdeNossoEnvio <= janelaSeg && AUTOMATICA.test(texto);
}

/** Telefone fixo brasileiro (55 + DDD + 8 dígitos começando em 2 a 5): não recebe abertura. */
export const telefoneFixo = (telefone: string) => /^55\d{2}[2-5]\d{7}$/.test(telefone.replace(/\D/g, ""));

/**
 * Quantas respostas automáticas já saíram seguidas, sem o operador no meio.
 * `origens` vem do mais recente para o mais antigo.
 */
export function automaticasSeguidas(origens: string[]): number {
  let n = 0;
  for (const o of origens) {
    if (o !== "auto") break;
    n++;
  }
  return n;
}

/** Pode sair mais uma resposta automática? (máx. `limite` seguidas, padrão 2.) */
export const podeResponderSozinho = (origens: string[], limite: number) => automaticasSeguidas(origens) < limite;

/** O que tira o lead da fila antes de qualquer envio. null = pode seguir. */
/**
 * `crm_leads.custom_fields.nao_contatar` marcado? Aceita o booleano e o texto "true" (import de CSV): antes só o
 * booleano contava e a marca em texto passava (auditoria 3, M2).
 */
export function naoContatarMarcado(campos: Record<string, unknown> | null | undefined): boolean {
  const v = campos?.["nao_contatar"];
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

export function motivoParaNaoContatar(lead: {
  bloqueado: boolean;
  anonimizado?: boolean;
  status: string;
  telefone: string | null;
}): string | null {
  if (lead.bloqueado) return "lead na lista de não contatar";
  if (lead.anonimizado) return "lead anonimizado (LGPD)";
  if (lead.status !== "open") return "lead encerrado";
  if (!lead.telefone) return "lead sem telefone";
  return null;
}
