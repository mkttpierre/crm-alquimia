/**
 * Leitura da resposta do lead pelo Jev (perfil venda). Portada de um motor anterior
 * (`src/lib/leitura-jev.ts`): as perguntas e o mapeamento ficam aqui; o que
 * fazer com a leitura fica em `venda.ts`, e `combinar` (`../leitura.ts`)
 * mantém a trava — a regra de parada SEMPRE vence o Jev, e na dúvida entre
 * parar e conversar a confiança cai e valem as regras.
 *
 * O nome do produto e do negócio não mora aqui: vem de `contextoJev` da
 * configuração da organização.
 */
import type { Intencao, LeituraIA } from "../leitura";
import { escolha, type Julgar, type Pergunta, prob, type RespostaJev } from "./jev";

const INTENCOES: Record<Intencao, string> = {
  parada: "pede pra parar de receber mensagem, xinga, ameaça denunciar ou pergunta quem passou o número",
  numero_errado: "diz que o número está errado, que mandamos pra pessoa errada ou que a pessoa procurada não é ela",
  nao_quer_mais: "recusa de forma curta e educada, sem dar motivo (ex.: 'não, obrigada', 'não quero', 'não vou querer', 'sem interesse', 'não tenho interesse')",
  reclamacao: "reclama de um produto que já comprou (não funcionou, não chegou, fez mal, quer devolução)",
  pergunta_preco: "pergunta preço, valor, tabela, kits ou promoção (inclui 'quanto fica o de 3 meses?')",
  interesse: "mostra interesse ou aceita ouvir mais ('sim', 'pode contar', 'quero saber', 'como funciona')",
  quer_fechar: "quer comprar ou fechar agora, pergunta como pagar, pede o link ou o pix",
  escolheu_kit: "escolhe um kit, tratamento ou quantidade (ex.: 'quero o de 12 meses', '3 frascos')",
  pergunta_entrega: "pergunta de entrega, prazo, frete ou rastreio",
  saudacao: "cumprimento isolado sem outra intenção, como oi ou boa tarde",
  pagamento: "pergunta sobre formas de pagamento, pix, cartão, boleto, parcelas ou pagamento na entrega",
  objecao_preco: "acha caro, pesado ou fora do orçamento, ou pergunta se tem algo mais em conta ou mais barato (sem pedir para mudar o preço)",
  pede_desconto: "pede desconto, cupom, abatimento ou para negociar/baixar o valor ('faz mais barato', 'faz por 500', 'tem desconto no pix?')",
  objecao_funciona: "duvida que funcione, diz que já tentou de tudo ou pede prova de resultado",
  objecao_medo: "tem medo de golpe, de comprar pela internet ou quer pagar só na entrega",
  objecao_tempo: "diz que vai pensar, que está ocupada, 'agora não', que deixa pra depois ou que precisa falar com alguém (sem citar dinheiro)",
  sem_dinheiro_agora: "falta dinheiro ou cartão agora: não tem dinheiro, só consegue quando o cartão virar ou o salário cair, no mês que vem, depois do dia tal, 'quando eu puder', gastou com outra coisa",
  ja_comprou_outro: "diz que já comprou ou já usa outro produto parecido",
  elogio: "conta que está gostando do produto ou que já viu resultado",
  outro: "nenhuma das anteriores (cumprimento, pergunta solta, 'ok' ou emoji sozinho, agradecimento solto, link, mensagem automática de empresa, assunto diferente)",
};

export type PerguntasDaLeitura = "intencao" | "parar" | "irritada" | "quente";

export function perguntasDaLeitura(contexto: string): Record<PerguntasDaLeitura, Pergunta> {
  return {
    intencao: {
      type: "choice",
      instructions: `Qual é a intenção principal de \`mensagem_do_lead\`, lida como resposta a \`ultima_mensagem_nossa\`? Quem escreve do nosso lado é um ${contexto}. Um 'não' dentro de outra frase ('não tenho dinheiro agora') não é recusa: é objeção. Adiar a compra por causa de dinheiro, cartão ou data de pagamento ('depois do dia 10', 'mês que vem', 'quando eu puder') é sem_dinheiro_agora, mesmo sem a palavra dinheiro.`,
      criteria: INTENCOES,
    },
    parar: {
      type: "noul",
      instructions:
        "`mensagem_do_lead` pede claro para a gente PARAR DE MANDAR mensagem (tirar da lista, não escrever mais, bloquear, denunciar, perguntar quem passou o número) ou é uma recusa hostil? Recusa educada ('não quero', 'não, obrigada', 'agora não'), dúvida, objeção de preço ou 'vou pensar' NÃO é.",
    },
    irritada: { type: "noul", instructions: "A pessoa está irritada, ofendida ou ameaçando denunciar na `mensagem_do_lead`?" },
    quente: { type: "noul", instructions: "A pessoa está pronta pra comprar agora (quer pagar, pede o link ou o pix, escolheu o que levar)?" },
  };
}

/**
 * Respostas do Jev viram `LeituraIA`. Certeza de pedido para parar vira parada
 * (o mesmo "na dúvida, pare"); dúvida entre parar e conversar derruba a
 * confiança abaixo do corte de `combinar`, e valem as regras.
 */
export function leituraDeJev(r: Partial<Record<PerguntasDaLeitura, RespostaJev>>): LeituraIA | null {
  const i = escolha(r.intencao);
  if (!i || !Object.hasOwn(INTENCOES, i.opcao)) return null;
  let intencao = i.opcao as Intencao;
  let confianca = i.confianca;
  const parar = prob(r.parar);
  if (parar !== undefined) {
    if (parar >= 0.8) {
      intencao = "parada";
      confianca = Math.max(confianca, parar);
    } else if (parar >= 0.5 && intencao !== "parada") confianca = Math.min(confianca, 0.6);
    else if (parar < 0.5 && intencao === "parada") confianca = Math.min(confianca, 0.5);
  }
  return {
    intencao,
    irritada: (prob(r.irritada) ?? 0) >= 0.7,
    quente: prob(r.quente),
    confianca: Number(confianca.toFixed(2)),
    resumo: `Jev: ${intencao}`,
  };
}

export async function lerComJev(
  julgar: Julgar,
  p: { texto: string; nossaUltima: string | null; contexto: string; cliente: boolean },
): Promise<LeituraIA | null> {
  if (!p.texto.trim()) return null;
  const j = await julgar(
    {
      mensagem_do_lead: p.texto,
      ultima_mensagem_nossa: p.nossaUltima,
      conversa: p.cliente ? "cliente que já comprou" : "lead que ainda não comprou",
    },
    perguntasDaLeitura(p.contexto),
  );
  return j ? leituraDeJev(j.respostas) : null;
}

/**
 * Perfil prospecção (organização B): mesma ideia, outras intenções (`IntencaoProspeccao`).
 * Ainda não está ligado ao `prospeccao.ts` (hoje só regras); fica pronto para a ligação futura.
 * Parada continua vencendo.
 */
export type IntencaoDeProspeccao = "parada" | "numero_errado" | "recusa" | "objecao" | "interesse" | "horario" | "quem_e" | "outro";

const INTENCOES_PROSPECCAO: Record<IntencaoDeProspeccao, string> = {
  parada: "pede pra parar de receber mensagem, xinga, ameaça denunciar ou pergunta quem passou o número",
  numero_errado: "diz que o número está errado ou que não é a pessoa ou o lugar procurado",
  recusa: "diz que não tem interesse, de forma curta e educada, sem dar motivo (ex.: 'não, obrigado', 'agora não', 'não vou precisar')",
  objecao: "recusa ou duvida dando um motivo (já tem agência, sem verba, já tentou, não acredita, não precisa)",
  interesse: "aceita ouvir, pede o link, o preço, o orçamento, uma ligação ou explicação de como funciona",
  horario: "responde com dia ou hora para conversar ou ser chamada",
  quem_e: "pergunta quem está falando, de qual empresa ou como conseguimos o contato",
  outro: "nenhuma das anteriores (cumprimento, emoji, 'ok', aviso de que vai ver com alguém, assunto solto)",
};

export type PerguntasDaProspeccao = "intencao" | "parar" | "irritada";

export function perguntasDaProspeccao(contexto: string): Record<PerguntasDaProspeccao, Pergunta> {
  return {
    intencao: {
      type: "choice",
      instructions: `Qual é a intenção principal de \`mensagem_do_lead\`, lida como resposta a \`ultima_mensagem_nossa\`? Quem escreve do nosso lado é uma ${contexto}. 'Quanto custa?' e 'pode ligar' são interesse. 'Já tenho agência' é objeção, não parada.`,
      criteria: INTENCOES_PROSPECCAO,
    },
    parar: {
      type: "noul",
      instructions:
        "`mensagem_do_lead` é um pedido claro para a gente parar de mandar mensagem, ou uma recusa hostil? Recusa educada, objeção ou 'vou ver com alguém' NÃO é.",
    },
    irritada: { type: "noul", instructions: "A pessoa está irritada, ofendida ou ameaçando denunciar na `mensagem_do_lead`?" },
  };
}

export type LeituraProspeccaoJev = { intencao: IntencaoDeProspeccao; irritado: boolean; confianca: number };

export function leituraProspeccaoDeJev(r: Partial<Record<PerguntasDaProspeccao, RespostaJev>>): LeituraProspeccaoJev | null {
  const i = escolha(r.intencao);
  if (!i || !Object.hasOwn(INTENCOES_PROSPECCAO, i.opcao)) return null;
  let intencao = i.opcao as IntencaoDeProspeccao;
  let confianca = i.confianca;
  const parar = prob(r.parar);
  if (parar !== undefined) {
    if (parar >= 0.8) {
      intencao = "parada";
      confianca = Math.max(confianca, parar);
    } else if (parar >= 0.5 && intencao !== "parada") confianca = Math.min(confianca, 0.6);
    else if (parar < 0.5 && intencao === "parada") confianca = Math.min(confianca, 0.5);
  }
  return { intencao, irritado: (prob(r.irritada) ?? 0) >= 0.7, confianca: Number(confianca.toFixed(2)) };
}

export async function lerProspeccaoComJev(
  julgar: Julgar,
  p: { texto: string; nossaUltima: string | null; contexto: string },
): Promise<LeituraProspeccaoJev | null> {
  if (!p.texto.trim()) return null;
  const j = await julgar(
    { mensagem_do_lead: p.texto, ultima_mensagem_nossa: p.nossaUltima, conversa: "lead frio de prospecção" },
    perguntasDaProspeccao(p.contexto),
  );
  return j ? leituraProspeccaoDeJev(j.respostas) : null;
}
