/**
 * Leitura da resposta do lead, camada de REGRAS (funções puras). Portada de um motor anterior
 * (`src/lib/leitura.ts`). Sem IA tudo funciona por aqui; `combinar` já existe
 * para a etapa 2, quando o julgamento barato (Jev) entrar ao lado — e quando os
 * dois discordam, vale o que manda parar.
 *
 * O que fazer com a leitura (responder, avisar o operador, mudar etapa) NÃO está
 * aqui: é o atendimento, que fica para a etapa 2.
 */
import { irritado as ehIrritado, lerResposta } from "./regras";

export type Intencao =
  | "parada"
  | "numero_errado"
  | "nao_quer_mais"
  | "reclamacao"
  | "pergunta_preco"
  | "interesse"
  | "quer_fechar"
  | "escolheu_kit"
  | "pergunta_entrega"
  | "saudacao"
  | "pagamento"
  | "objecao_preco"
  /** Pede desconto, cupom ou negociação do valor: é do operador, nunca do atendimento (D5). */
  | "pede_desconto"
  | "objecao_funciona"
  | "objecao_medo"
  | "objecao_tempo"
  | "sem_dinheiro_agora"
  | "ja_comprou_outro"
  | "elogio"
  | "outro";

export type Leitura = {
  intencao: Intencao;
  /** Kit ou quantidade que a pessoa disse ("12 meses", "3 frascos"), quando houver. */
  kit: string | null;
  irritada: boolean;
  confianca: number;
  resumo: string;
  fonte: "regras" | "ia";
};

export const normalizar = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const NUMEROS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};
const NUM = "\\d{1,2}|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze";
/** Depois do número, isto o desqualifica como quantidade de kit (hora, dia, preço, vez, idade...). */
const NAO_E_KIT = "(?!\\s*(?:h\\b|hrs|horas?|reais|x\\b|dias?|vezes|anos?|min\\b|minutos?|r\\$|%|filh|neto|\\d))";

/**
 * "o de 12 meses", "quero 3 frascos", "dois potes", "o de nove", "vou levar 2", "manda o maior". Devolve o kit
 * normalizado. "O maior" é o kit mais longo da tabela (12 meses).
 */
export function kitDoTexto(texto: string): string | null {
  const t = normalizar(texto);
  const m =
    new RegExp(`(${NUM})\\s*(meses|mes|frascos?|pot[ei]s?|potinhos?|caixas?|unidades?)`).exec(t) ??
    new RegExp(`\\b(?:kit|plano|tratamento|pacote|opcao|esse|o|de)\\s+(?:de\\s+)?(\\d{1,2}|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\\b${NAO_E_KIT}`).exec(t) ??
    // Verbo de escolha + número solto ("vou levar 2", "fico com 5", "me manda 9"): só se o número fecha a frase.
    new RegExp(`\\b(?:levar|levo|pegar|pego|fico com|ficar com|vou de|vai de|vai ser|vou querer|quero|queria|preciso de|separa|manda|me manda|me da|me ve|fecha|fecho com)\\s+(?:(?:o|a|os|as|de|com|so|apenas|mais|uns|umas)\\s+)*(${NUM})\\b${NAO_E_KIT}(?=\\s*(?:$|[,.!?;:]|(?:msm|mesmo|mas|pfv|pf|por favor|obrigad\\w*|ne|entao|ok|ai|e)\\b))`).exec(t);
  if (!m) {
    // "manda o maior", "quero o kit maior": o maior da tabela (precisa de um verbo de escolha; "qual é o maior?" é pergunta).
    if (/\b(?:manda|mande|me manda|quero|queria|vou|levo|levar|fico|fecha|fecho|pode ser|vai ser|pego|pegar|prefiro)\b/.test(t) && /\b(?:(?:o|um|do) )?(?:(?:kit|tratamento|plano|pacote) )?(?:maior|mais completo|mais longo)\b/.test(t) && !/\bqual\b/.test(t)) return "12 meses";
    return null;
  }
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMEROS[m[1]!];
  if (!n || n > 12) return null;
  if (m[2] && /frasco|pot|caixa|unidade/.test(m[2])) return n === 1 ? "1 frasco" : `${n} frascos`;
  return n === 1 ? "1 mês" : `${n} meses`;
}

/** Quem pergunta, compara ou adia não está escolhendo: "o de 9 custa 697 né? ainda vou pensar", "quero saber o valor do de 7". */
const DUVIDA_DE_KIT = /\bcusta\b|\bpensar\b|\bsaber\b|\bduvida\b|\bqual\b|vale a pena/;
const VERBO_DE_ESCOLHA = /^(?:o |a )?(?:de )?(?:\d|um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\b|\b(?:quero|queria|gostaria|adquirir|vou|levar|levo|leva|fico|fica|ficar|pegar|pego|pode ser|vai ser|vai de|manda|mande|me manda|separa|fecha|fechar|fecho|prefiro|escolho|opto|comprar|compro|preciso)\b/;
/** O kit que a pessoa DECLAROU querer (verbo ou forma de escolha + quantidade, sem dúvida de preço). null = não é escolha. */
export function escolhaDeKit(texto: string): string | null {
  const t = normalizar(texto).replace(/\s+/g, " ").trim();
  const kit = kitDoTexto(texto);
  if (!kit || DUVIDA_DE_KIT.test(t)) return null;
  return FECHAR.test(t) || VERBO_DE_ESCOLHA.test(t) ? kit : null;
}

/** Só um "sim" de quem aceita ouvir ("quero sim", "pode"): interesse, não compra. */
export const ehSoAceite = (texto: string) =>
  /^(?:(?:sim[, ]*)?(?:quero|pode|claro|bora|vamos|pode sim|quero sim|tenho interesse)(?: sim| saber| ouvir| mandar)?|sim|ok|aham|uhum|👍[🏻🏼🏽🏾🏿]?|😍)[.! ]*$/u.test(
    normalizar(texto).replace(/\s+/g, " ").trim(),
  );

const PRECO = /\bquanto\b(?! tempo)|\bcabe no (meu )?bolso\b|\bconta pra mim\b|qual (e )?(o |seria o )?(valor|preco|investimento|custo)|\bvalores\b|\bvalor\b|\bpreco|\borcamento\b|me (passa|manda|envia|fala|mostra) (o |os |a )?(valor|preco|tabela|kit|promocao)|tabela|promocao|\bkits\b/;
const ENTREGA = /entrega|\bprazo\b|chega (em|quando)|quanto tempo (leva|demora|chega)|demora (pra|para) chegar|\bfrete\b|\bcorreios\b|rastre|como (e|funciona) o envio|envio pra|envia pra/;
const FECHAR = /quero (comprar|fechar|o tratamento|iniciar|comecar|levar|esse|o de|o kit|garantir|sim)|vou querer|vou (levar|fechar|comprar)|pode (mandar|enviar) (o |a )?(link|pix|chave|pedido|produto|kit)|pode (separar|fechar)|como (faco|eu faco) pra (comprar|pagar|fechar)|como (compro|pago|fecho)|manda (o )?(link|pix|chave)|me passa (o )?(link|pix|chave)|passa o pix|quero garantir|fechado|vamos fechar|bora fechar|aceito|vou pagar|ja paguei|pago no pix|pix (mesmo|pode)/;
const INTERESSE = /^(sim|pode|pode sim|claro|quero|quero sim|tenho|tenho sim|conta|me conta|pode contar|manda|pode mandar|vamos|bora|com certeza|ok|aham|uhum|isso|conheco|nao conheco|nao conheco nao|me explica|explica)\b|quero (saber|entender|conhecer|ver)|tenho interesse|me conta|pode (me )?(explicar|contar|falar)|como funciona|me explica|do que se trata|ainda (tenho|quero|faz sentido)|faz sentido|sim,? ?(tenho|quero|pode)|interess(a|ei|ou)\b|\bfala (mais|sobre|melhor)\b|\bo que (e|eh) (isso|isto|esse|essa|o produto)\b|\bque (produto|suplemento|remedio) (e|eh) (esse|essa|isso)\b|\bmais (detalhes|informac|info)/;
const OBJ_PRECO = /\bcaro\b|\bcara\b|muito (caro|dinheiro)|pesado|nao (cabe|da) no (meu )?(bolso|orcamento)|passa do (meu )?(orcamento|que posso)|achei (caro|salgado)|valor alto|tem (mais )?(barato|desconto)|desconto|menor (valor|preco)|mais em conta|barato/;
/**
 * Pedido de desconto ou de negociar o valor (texto normalizado). Regra dura D5:
 * vale SEMPRE, também quando o Jev lê outra coisa (ver `venda.ts`). "Tem mais
 * barato?" sozinho NÃO entra: é objeção de preço e a escada da tabela responde
 * (todo degrau é preço da tabela). O que entra é pedir para MUDAR o preço.
 */
const DESCONTO = /descont|cupom|cupon|abatiment|negoci(ar|a|acao|amos)\b|pechinch|fa(z|ca|zer) (um |o )?(precinho|preco)|fa(z|ca|zer) (por )?(menos|mais barato|mais em conta)|(faz|faca|fazer|fizer) (por|em) (r\$ ?)?\d+|fech(a|o|amos) (por|em|ela|ele) (r\$ ?)?\d+|(da|tem como|consegue|pode|poderia) (pra |para )?(fazer |deixar |baixar |abaixar |reduzir |melhorar )(mais barato|por menos|o preco|o valor|um precinho)|(baixa|abaixa|reduz|melhora)(r)? (o |um )?(preco|valor|precinho)|(ultimo|menor|melhor) (preco|valor)|preco (final|de custo|especial|de atacado)|(tem|ha|existe) (algum )?(jeito|como) (de )?(melhorar|baixar|reduzir)|aceita \d+|proposta de (r\$ ?)?\d+|pago (r\$ ?)?\d+ (no pix|a vista|se)|condicao especial/;

export const pedeDesconto = (texto: string): boolean => DESCONTO.test(normalizar(texto).replace(/\s+/g, " ").trim());

const SEM_DINHEIRO =/sem (dinheiro|grana|condicao|condicoes)|nao tenho (dinheiro|grana|condicao|condicoes|como pagar|como comprar)|(mes|semana) que vem|proximo mes|quando (cair|receber|o cartao virar|virar|meu cartao)|cartao (vira|virar)|salario|(estou|to|ta) (apertad|dura|sem)|aperta(do|da)|depois do dia \d|dia \d+ (eu|vc|voce)|mais pra frente|quando (eu )?(puder|tiver)/;
const FUNCIONA = /(sera que )?(?<!como )(?<!como isso )(?<!como o produto )funciona|ja (tentei|usei|tomei|fiz|comprei) (de tudo|tanto|muita|varios|varias|outros|outras)|nunca (funcionou|deu certo)|nao acredito|duvido|nao confio em (produto|suplemento)|resultado (de verdade|real)|tem (resultado|garantia)|ja gastei|dinheiro jogado/;
const MEDO = /\bgolpe\b|\bfraude\b|(medo|receio|desconfian|inseguranca|inseguro|insegura) (de )?(comprar|compra|pela internet|online|golpe|pagar)|compra(r)? (pela )?internet|nao (confio|conheco a empresa)|(e|sera que e) (confiavel|seguro|de verdade)|\bcnpj\b|empresa (existe|e real)|pagar (na )?entrega|pagamento na entrega|vou receber (mesmo)?|ja caiu em golpe|me enganaram/;
const TEMPO = /vou pensar|deixa (eu )?pensar|preciso pensar|depois (eu )?(vejo|olho|te falo|volto|respondo|converso)|deixa pra depois|mais tarde|agora nao|nao (e|eh) o (momento|melhor momento)|outro dia|(estou|to) (no trabalho|ocupad|corrid)|tenho que (ver|falar|conversar|consultar) (com|se)|(meu|minha) (marido|esposo|filh[ao]|irma|mae) |amanha eu (vejo|falo|compro)/;
const OUTRO_PRODUTO = /ja (comprei|uso|tomo|tenho|estou usando|usei) (outro|outra|um|uma|o|a)\b|ja (compro|uso|tomo) (de )?(outr|um|uma)|comprei (em|de) outr|outra marca|outro (produto|suplemento)/;
const ELOGIO = /(estou|to|ta|tá|estava) (gostando|amando|adorando|otim|bem|melhor|notando|vendo)|gostei|amei|adorei|funcionou|funcionando|melhorou|deu certo|resultado (bom|otimo|incrivel|lindo)|(muito )?(bom|otimo|maravilhos|excelente)\b|\bsim,? (estou|to|ja)\b|ja (notei|vi|senti)|notei diferenca|ja vi diferenca/;
/** Cliente fala bem do tratamento (está tomando, gostando, viu resultado): só aí cabe o "Que bom ouvir isso" da reposição. */
// Próprio para o tratamento (não usa o ELOGIO, que pega "bom" de "bom dia" e "to bem").
const FALA_DO_TRATAMENTO = /\b(estou|to|ta|estava|continuo|sigo|ainda) (tomando|usando|gostando|amando|adorando|notando|vendo resultado|vendo diferenca)\b|\btomando (certinho|direitinho|todo dia)\b|\b(gostei|amei|adorei|funcionou|funcionando|melhorou|deu certo)\b|\bresultado (bom|otimo|incrivel|lindo)\b|\b(ja )?(notei|vi|senti) (a )?(diferenca|resultado)\b/;
const NEGA_O_TRATAMENTO = /\b(nao|n) (estou|to|ta|estava|gostei|amei|funcionou|melhorou|deu|notei|vi|senti|tomo|tomei|uso|usei)\b|\bparei de tomar\b/;
export const falaBemDoTratamento = (texto: string): boolean => {
  const t = normalizar(texto).replace(/\s+/g, " ").trim();
  return FALA_DO_TRATAMENTO.test(t) && !NEGA_O_TRATAMENTO.test(t);
};
const RECLAMACAO = /nao (funcionou|vi (resultado|diferenca)|adiantou|resolveu|recebi|chegou|gostei|senti nada)|sem resultado|nao tive resultado|reclam|enganad|me arrependi|nunca chegou|(passei|senti|tive) mal|alergia|reacao|coceira|piorou|devolver|devolucao|reembolso|estorno|cancelar|nao (fez|deu) efeito|perdi dinheiro|golpista/;

/**
 * Parada e número errado que o vocabulário de `regras.ts` não pega, achados na
 * medição com o Jev. Funções puras, SEM Jev:
 * "na dúvida, pare" vale antes de qualquer IA.
 */
const QUEM_PASSOU = /quem (te |lhe |vc |voce )?(passou|deu|forneceu|conseguiu|te deu) (o |meu |o meu )?(numero|telefone|contato|whats)|onde (voce|vc) (pegou|conseguiu|arrumou) (o )?(meu )?(numero|telefone|contato)|como (voce|vc) (conseguiu|arrumou|pegou) (o )?meu (numero|telefone|contato)/;
const PESSOA_ERRADA = /(mandou|enviou|ligou|chamou|escreveu|falou) (pra|para) (a )?pessoa errada|essa pessoa nao (mora|trabalha|atende|e daqui|esta) aqui|nao (e|eh) (o numero|a pessoa|dela|dele) |esse numero nao (e|eh)|pessoa errada|\b(ela|ele) trocou de numero\b|\b(enganou|confundiu) de paciente\b/;
export const pedeSaidaDaLista = (texto: string): boolean => QUEM_PASSOU.test(normalizar(texto).replace(/\s+/g, " ").trim());
export const dizPessoaErrada = (texto: string): boolean => PESSOA_ERRADA.test(normalizar(texto).replace(/\s+/g, " ").trim() + " ");
/** "Não vou querer", "não quero" curto: recusa seca. O "vou querer" dentro dela não é fechamento. */
const NAO_VOU_QUERER = /\bnao (vou|iria|quero|queria|pretendo) (querer|comprar|levar|fechar|nada|investir|gastar)\b/;

/** "Não quero agora, só mês que vem", "não agora, depois eu vejo": a pessoa adia com data ou motivo, não recusa. */
const ADIAMENTO = /(?:mes|semana|ano) que vem|proximo (?:mes|ano|dia)|\bdepois\b|mais tarde|mais pra frente|quando (?:eu )?(?:puder|tiver|receber|cair|sobrar)|dia \d|\bamanha\b|outro dia|\bpensar\b|salario|\bcartao\b|fatura|sem (?:dinheiro|grana|condic)|apertad/;
const RECUSA_EXPLICITA = /\binteress|obrigad|brigad|nao quero mais/;
export const ehAdiamento = (t: string) => ADIAMENTO.test(t) && !RECUSA_EXPLICITA.test(t);

/**
 * Recusa curta e educada que o vocabulário de `regras.ts` não pega ("Não. Obrigada", "não brigado", "não interesso",
 * "agora ñ", "já tenho", "infelizmente", "não quero esse produto", "não vou investir"). Texto já normalizado
 * (sem acento; "ñ" vira "n"). Só mensagens curtas e sem adiamento: "agora não, depois eu vejo" é objeção de tempo.
 */
export function ehRecusaCurta(t: string): boolean {
  if (t.split(" ").length > 10 || ehAdiamento(t)) return false;
  return (
    /\b(?:nao|n)[.,!\s]+(?:muito\s+)?(?:obrigad|brigad|obg)/.test(t) ||
    /\bnao (?:me )?interess(?:o|a|ei|ou)\b/.test(t) ||
    /^(?:eu )?(?:ja tenho|tenho ainda|ainda tenho)(?: aqui| em casa| o produto| esse| isso)?[.,! ]*(?:obrigad\w*|brigad\w*)?[.! ]*$/.test(t) ||
    /\bnao (?:vou|iria|pretendo|quero) (?:investir|gastar)\b/.test(t) ||
    /^infelizmente[.,! ]*$/.test(t) ||
    /^(?:(?:oi|ola|bom dia|boa tarde|boa noite)[,.! ]*)?(?:nao|n) quero (?:o |a |esse |essa |isso |mais |nenhum |nenhuma )?(?:produto|suplemento|tratamento|nada|isso|esse|essa)[.,! ]*(?:obrigad\w*)?[.! ]*$/.test(t) ||
    /^(?:hoje |agora |no momento |por agora )(?:nao|n)[.,! ]*(?:obrigad\w*|brigad\w*)?[.! ]*$/.test(t)
  );
}
const RECUSA_QUERER = /(?:^|[^\p{L}\p{N}])(?:nao|n)\s+quero(?:\s+mais)?(?=$|\s*[,\.!?])|\bquero(?:\s+mais)?\s+(?:nao|n)(?=$|[\s,.!?])/u;

/** Lê a mensagem (ou as mensagens juntas) do lead. */
export function lerMensagem(texto: string, opcoes: { golpeEhParada?: boolean } = {}): Leitura {
  const t = normalizar(texto).replace(/\s+/g, " ").trim();
  const irritada = ehIrritado(texto);
  const base = { irritada, fonte: "regras" as const, kit: null as string | null };
  const parada = lerResposta(texto, opcoes);
  if (parada === "conversa" && pedeSaidaDaLista(texto)) return { ...base, intencao: "parada", confianca: 0.9, resumo: "perguntou quem passou o número" };
  if (parada === "conversa" && dizPessoaErrada(texto)) return { ...base, intencao: "numero_errado", confianca: 0.85, resumo: "pessoa errada" };
  if (parada === "parada") return { ...base, intencao: "parada", confianca: 0.95, resumo: "pediu pra parar" };
  if (parada === "numero_errado") return { ...base, intencao: "numero_errado", confianca: 0.9, resumo: "número errado" };

  const kit = kitDoTexto(texto);
  const com = { ...base, kit };

  if (RECLAMACAO.test(t)) return { ...com, intencao: "reclamacao", confianca: 0.8, resumo: "reclamação" };
  // D5: desconto/negociação vence a escolha de kit, o "quero fechar" e a objeção de preço.
  if (DESCONTO.test(t)) return { ...com, intencao: "pede_desconto", confianca: 0.9, resumo: "pediu desconto ou negociar o valor" };
  if (RECUSA_QUERER.test(t) && !OBJ_PRECO.test(t)) return { ...com, intencao: "nao_quer_mais", confianca: 0.9, resumo: "não quer mais" };
  if (ehRecusaCurta(t) && !OBJ_PRECO.test(t)) return { ...com, intencao: "nao_quer_mais", confianca: 0.85, resumo: "recusou" };
  // Adiamento com data ou motivo ("não quero agora, só mês que vem"): não é recusa, segue como falta de dinheiro/tempo.
  const adia = ehAdiamento(t);
  if (parada === "conversa" && !adia && NAO_VOU_QUERER.test(t))
    return OBJ_PRECO.test(t)
      ? { ...com, intencao: "objecao_preco", confianca: 0.7, resumo: "achou caro" }
      : { ...com, intencao: "nao_quer_mais", confianca: 0.85, resumo: "não vai querer" };
  if (parada === "nao_quer_mais" && !adia) {
    // "Não quero, está caro": o motivo vem junto; a objeção vale mais que o não seco.
    if (OBJ_PRECO.test(t)) return { ...com, intencao: "objecao_preco", confianca: 0.7, resumo: "achou caro" };
    return { ...com, intencao: "nao_quer_mais", confianca: 0.9, resumo: "não quer mais" };
  }
  if (/^(?:👍[🏻🏼🏽🏾🏿]?|😍)[.! ]*$/u.test(t)) return { ...com, intencao: "interesse", confianca: 0.7, resumo: "aceite positivo" };
  if (kit && escolhaDeKit(texto)) return { ...com, intencao: "escolheu_kit", confianca: 0.85, resumo: `escolheu ${kit}` };
  if (SEM_DINHEIRO.test(t)) return { ...com, intencao: "sem_dinheiro_agora", confianca: 0.8, resumo: "sem dinheiro agora" };
  if (FECHAR.test(t)) return { ...com, intencao: "quer_fechar", confianca: 0.85, resumo: "quer fechar" };
  if (/\b(pix|cartao|credito|debito|boleto|parcel\w*|pag(?:ar|o|amento)\s+(?:na|quando|ao)\s+entrega|pagar quando chegar)\b/.test(t)) return { ...com, intencao: "pagamento", confianca: 0.85, resumo: "perguntou sobre pagamento" };
  if (MEDO.test(t)) return { ...com, intencao: "objecao_medo", confianca: 0.8, resumo: "medo de golpe ou da compra" };
  if (OBJ_PRECO.test(t)) return { ...com, intencao: "objecao_preco", confianca: 0.8, resumo: "achou caro" };
  if (PRECO.test(t)) return { ...com, intencao: "pergunta_preco", confianca: 0.85, resumo: "perguntou preço" };
  if (ENTREGA.test(t)) return { ...com, intencao: "pergunta_entrega", confianca: 0.85, resumo: "perguntou da entrega" };
  if (TEMPO.test(t)) return { ...com, intencao: "objecao_tempo", confianca: 0.75, resumo: "vai pensar ou deixar pra depois" };
  if (FUNCIONA.test(t)) return { ...com, intencao: "objecao_funciona", confianca: 0.75, resumo: "dúvida se funciona" };
  if (OUTRO_PRODUTO.test(t)) return { ...com, intencao: "ja_comprou_outro", confianca: 0.7, resumo: "já usa outro produto" };
  if (/^(?:(?:oi|ola|bom dia|boa tarde|boa noite)[,! ]*)?(?:tudo (?:bem|bom)(?:\s+(?:e|com)\s+(?:voce|vc|contigo))?)?[?!. ,]*$/.test(t) && /\p{L}/u.test(t)) return { ...com, intencao: "saudacao", confianca: 0.8, resumo: "cumprimento" };
  if (ELOGIO.test(t) && !INTERESSE.test(t)) return { ...com, intencao: "elogio", confianca: 0.7, resumo: "está gostando" };
  if (INTERESSE.test(t)) return { ...com, intencao: "interesse", confianca: 0.7, resumo: "quer saber mais" };
  return { ...com, intencao: "outro", confianca: 0.3, resumo: "outra coisa" };
}

/** O que o julgamento barato devolve (etapa 2). Tudo opcional: resposta incompleta vale menos. */
export type LeituraIA = {
  intencao?: Intencao;
  kit?: string | null;
  irritada?: boolean;
  quente?: number;
  resumo?: string;
  confianca?: number;
};

const PARA = new Set<Intencao>(["parada", "numero_errado"]);

/**
 * Junta regras e IA. Regra de parada vale sempre; fora disso a IA confiante
 * (0,7 ou mais) decide, menos quando as regras já viram fechamento ou
 * reclamação — na dúvida, não vende pra quem reclama.
 */
export function combinar(regras: Leitura, ia: LeituraIA | null): Leitura & { discordou?: boolean } {
  if (!ia?.intencao || typeof ia.confianca !== "number") return regras;
  const confiante = ia.confianca >= 0.7;
  if (PARA.has(regras.intencao)) return { ...regras, discordou: confiante && !PARA.has(ia.intencao) };
  if (!confiante) return regras;
  if (regras.intencao === "nao_quer_mais" && !PARA.has(ia.intencao)) return { ...regras, irritada: regras.irritada || Boolean(ia.irritada) };
  if ((regras.intencao === "pergunta_preco" || regras.intencao === "objecao_preco") && (ia.intencao === "elogio" || ia.intencao === "interesse" || ia.intencao === "outro")) return regras;
  // D5: pedido de desconto lido pelas regras não é desfeito pelo Jev (só a parada vence, acima).
  if (regras.intencao === "pede_desconto") return { ...regras, irritada: regras.irritada || Boolean(ia.irritada) };
  if ((regras.intencao === "escolheu_kit" || regras.intencao === "quer_fechar") && !PARA.has(ia.intencao) && ia.intencao !== "reclamacao")
    return { ...regras, irritada: regras.irritada || Boolean(ia.irritada) };
  if (regras.intencao === "reclamacao" && ia.intencao !== "parada") return { ...regras, irritada: regras.irritada || Boolean(ia.irritada) };
  let intencao = ia.intencao;
  if ((ia.quente ?? 0) >= 0.85 && (intencao === "interesse" || intencao === "outro")) intencao = "quer_fechar";
  return {
    intencao,
    kit: ia.kit ?? regras.kit,
    irritada: regras.irritada || Boolean(ia.irritada),
    confianca: ia.confianca,
    resumo: ia.resumo?.slice(0, 120) || regras.resumo,
    fonte: "ia",
  };
}
