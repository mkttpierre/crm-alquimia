/**
 * Agente de objeções do perfil venda: decide QUAL peça pronta sai (áudio de
 * objeção com a pergunta de retorno, pacote de fechamento, links do site).
 * Portado de um motor anterior (`src/lib/agente.ts`), com as tabelas trocadas por
 * dado da organização (`ConfigVenda`). Funções puras; nada aqui fala com banco,
 * fila ou canal. Primeiro as regras (grátis); o Jev só entra quando nenhum
 * gatilho bateu.
 */
import { kitDoTexto, normalizar } from "../leitura";
import type { ConfigVenda, Kit, Objecao, Parte } from "./config";
import { escolha, type Julgar, type Pergunta } from "./jev";

export type EstadoAgente = {
  /** Objeções que já receberam a peça (cada uma sai uma vez; repetiu, é com o operador). */
  objecoesUsadas: string[];
  /** Meses do kit que o lead escolheu antes, se houver. */
  kitMeses?: number | null;
  fechamentoEnviado?: boolean;
};

export type Plano =
  | { tipo: "fechamento"; kit: number; partes: Parte[] }
  | { tipo: "perguntar_kit" }
  | { tipo: "site"; links: { meses: number; link: string }[]; texto: string }
  | { tipo: "objecao"; objecao: Objecao }
  | { tipo: "operador"; motivo: string }
  | { tipo: "nenhum" };

const PEDE_SITE =
  /(me )?(manda|envia|passa|mande)( o| um)? (o )?(site|link)|pelo site|no site|quero o (site|link)|so (o )?(site|link)|site que eu (mesm|fec|compr)|mando eu mesm|eu mesm[ao] (fecho|compro|faco)|prefiro (o )?(site|link)|compro (pelo|no) (site|link)/;

const limpo = (texto: string) => normalizar(texto).replace(/\s+/g, " ").trim();

/** "12 meses" → o kit de 12, se a casa vende. Unidades (frascos, potes) não dizem quantos meses cobrem: null. */
export function kitDosMeses(kits: Kit[], texto: string | null | undefined): Kit | null {
  if (!texto) return null;
  const m = /^(\d{1,2}) mes/.exec(normalizar(texto));
  return m ? (kits.find((k) => k.meses === Number(m[1])) ?? null) : null;
}

/** O kit logo acima (o upgrade do site). Acima do maior não há. */
export function kitAcima(kits: Kit[], meses: number): Kit | null {
  const i = kits.findIndex((k) => k.meses === meses);
  return i > 0 ? kits[i - 1]! : null;
}

export function textoDoSite(c: ConfigVenda, meses: number): { links: { meses: number; link: string }[]; texto: string } | null {
  const escolhido = c.kits.find((k) => k.meses === meses);
  if (!escolhido || !c.site) return null;
  const acima = kitAcima(c.kits, meses);
  if (!acima) {
    const links = [{ meses, link: escolhido.link }];
    return { links, texto: c.site.textoSemAcima.replace("{links}", `${meses} meses:\n${escolhido.link}`).replace("{meses}", String(meses)) };
  }
  const links = [
    { meses: acima.meses, link: acima.link },
    { meses, link: escolhido.link },
  ];
  const lista = links.map((l) => `${l.meses} meses:\n${l.link}`).join("\n\n");
  return { links, texto: c.site.texto.replace("{links}", lista).replace("{acima}", String(acima.meses)).replace("{meses}", String(meses)) };
}

/** A objeção pelo gatilho da casa. Gatilho que não compila é pulado (dado ruim não derruba). */
export function objecaoPorRegra(objecoes: Objecao[], texto: string): Objecao | null {
  const t = limpo(texto);
  for (const o of objecoes) {
    try {
      if (new RegExp(o.gatilho).test(t)) return o;
    } catch {
      continue;
    }
  }
  return null;
}

/** Só o texto: 1) pedido de site, 2) kit escolhido, 3) objeção pelo gatilho. */
export function planejar(c: ConfigVenda, texto: string, estado: EstadoAgente): Plano {
  const t = limpo(texto);
  const dito = kitDoTexto(texto);
  const kitDito = kitDosMeses(c.kits, dito);
  const meses = kitDito?.meses ?? estado.kitMeses ?? null;

  if (PEDE_SITE.test(t) && c.site) {
    if (!meses) return { tipo: "perguntar_kit" };
    const s = textoDoSite(c, meses);
    return s ? { tipo: "site", ...s } : { tipo: "perguntar_kit" };
  }

  if (dito && !estado.fechamentoEnviado && c.fechamento) {
    if (!kitDito) return { tipo: "perguntar_kit" };
    const b = c.fechamento.brindes;
    const vale = b && Date.now() < new Date(b.ate).getTime();
    const abertura = vale ? [{ texto: kitDito.meses === 12 ? b.doze : b.outros, midia: null }] : [];
    return { tipo: "fechamento", kit: kitDito.meses, partes: [...abertura, ...c.fechamento.partes] };
  }

  const o = objecaoPorRegra(c.objecoes, texto);
  if (o) {
    if (estado.objecoesUsadas.includes(o.id)) return { tipo: "operador", motivo: `objeção "${o.id}" de novo: responder com calma` };
    return { tipo: "objecao", objecao: o };
  }
  return { tipo: "nenhum" };
}

export function perguntaDaObjecao(c: ConfigVenda): Pergunta {
  const criterios: Record<string, string | null> = {
    nenhuma: "nenhuma das opções: cumprimento, dúvida solta, assunto diferente ou conversa normal",
  };
  for (const o of c.objecoes) criterios[o.id] = o.jev;
  return {
    type: "choice",
    instructions: `A pessoa está conversando com um ${c.contextoJev}. Qual objeção ou dúvida \`mensagem_do_lead\` expressa, lida como resposta a \`ultima_mensagem_nossa\`? Se for só uma pergunta normal, cumprimento ou aceitação, responda nenhuma.`,
    criteria: criterios,
  };
}

/**
 * Igual a `planejar`, mas, se as regras não acharam nada, pergunta ao Jev (só
 * texto com 3 palavras ou mais). Abaixo da confiança mínima vale "nenhum".
 */
export async function planejarComJev(
  c: ConfigVenda,
  texto: string,
  estado: EstadoAgente,
  nossaUltima: string | null,
  julgar: Julgar,
): Promise<Plano> {
  const p = planejar(c, texto, estado);
  if (p.tipo !== "nenhum" || texto.trim().split(/\s+/).length < 3 || !c.objecoes.length) return p;
  const j = await julgar({ mensagem_do_lead: texto, ultima_mensagem_nossa: nossaUltima }, { objecao: perguntaDaObjecao(c) });
  const e = escolha(j?.respostas.objecao);
  if (!e || e.opcao === "nenhuma" || e.confianca < c.confiancaObjecaoJev) return p;
  const o = c.objecoes.find((x) => x.id === e.opcao);
  if (!o) return p;
  // O Jev não decide dúvida de saúde: só o gatilho exato libera a peça.
  if (o.soPeloGatilho) return { tipo: "operador", motivo: `dúvida sensível ("${texto.slice(0, 80)}"): responder você` };
  if (estado.objecoesUsadas.includes(o.id)) return { tipo: "operador", motivo: `objeção "${o.id}" de novo: responder com calma` };
  return { tipo: "objecao", objecao: o };
}
