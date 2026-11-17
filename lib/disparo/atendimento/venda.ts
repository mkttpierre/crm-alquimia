/**
 * Decisão do atendimento, perfil VENDA (portado de `decidir` de uma organização,
 * `src/lib/atendimento.ts`, e ligado ao agente de objeções, o que uma organização ainda
 * não tinha feito). Função PURA: recebe a leitura, o estado da conversa e a
 * configuração da casa; devolve as ações (responder, avisar, encerrar) e o
 * estado novo. Quem grava, enfileira e avisa é `atendimento.ts`.
 *
 * Regras que não se negociam, na ordem em que valem:
 *  1. Lead em `nao_contatar` que escreve de novo: só registra.
 *  2. Parada dura, número errado ou irritação: encerra, nada sai, ninguém é
 *     notificado. A regra de parada vence o Jev (`combinar`).
 *  2a. Opção de queixa do braço A do teste A/B (`queixas`): uma resposta por conversa,
 *     antes da tabela; preço, escolha de kit e "quero fechar" vencem a queixa.
 *  3. Recusa educada: oferece o Método se elegível; senão encerra como perdido.
 *  4. Reclamação e assunto da lista de desvios: operador, nada sai.
 *  5. Lead quente (já com o operador): nada automático.
 *  6. No máximo `limiteAutomaticas` respostas automáticas seguidas (a mesma
 *     regra do motor, `podeResponderSozinho`) e `limiteObjecoes` objeções de
 *     tipos diferentes; passou, é com o operador.
 *  4b. Pedido de desconto ou de negociar o valor (D5): o atendimento nunca
 *     oferece valor fora da tabela nem fala de desconto; para, avisa e deixa o
 *     operador negociar. Vale também quando o Jev lê outra coisa.
 *  8. "Quero fechar" SEM dizer a quantidade não é compra: não para, não
 *     avisa e não marca quente; manda o funil de valores (se ainda não viu) ou a
 *     pergunta do kit. Só a quantidade dita (`escolheu_kit`) manda o pacote de
 *     fechamento e, depois dele, dispara a parada.
 *  7. "Quero sim" ANTES da tabela é aceite de ouvir, não compra (caso da
 *     lead marcada pronta para fechar sem ter visto preço): sai a
 *     explicação do produto e depois o funil de valores.
 */
import type { Proibido } from "../config";
import { ehSoAceite, falaBemDoTratamento, type Intencao, normalizar, pedeDesconto } from "../leitura";
import { podeResponderSozinho } from "../regras";
import { objecaoPorRegra, type Plano } from "./agente";
import type { ConfigQueixa, ConfigVenda, Parte } from "./config";
import type { Acao, Decisao, EstadoConversa, LeadDoAtendimento, LeituraFinal } from "./estado";
import { montarPartes, montarResposta } from "./pecas";
import { motivoForaDaTabela } from "./parada";
import { dataDoRetorno } from "./data-do-retorno";

export type EntradaVenda = {
  config: ConfigVenda;
  leitura: LeituraFinal;
  /** O que o lead escreveu (mensagens seguidas juntas), ou "(áudio)". */
  texto: string;
  estado: EstadoConversa;
  lead: LeadDoAtendimento;
  /** Plano do agente (regras e, se preciso, Jev), calculado antes por quem chama. */
  plano: Plano;
  limiteAutomaticas: number;
  /** Quantos toques do follow-up do kit já saíram para a lead (o motor manda; o atendimento só lê). */
  toquesEnviados?: number;
  proibidos: Proibido[];
  agora: Date;
  fusoMinutos: number;
};

/** Intenções em que a peça de objeção do agente (pelo gatilho) vale mais que a leitura. */
const OBJECAO_PRIMEIRO = new Set<Intencao>([
  "outro",
  "objecao_funciona",
  "objecao_medo",
  "objecao_tempo",
  "sem_dinheiro_agora",
  "ja_comprou_outro",
]);

const trecho = (t: string, n = 80) => t.replace(/\s+/g, " ").trim().slice(0, n);
const assuntoSaude = (texto: string) => /\b(diabet\w*|hipertens\w*|pressao alta|gestant\w*|gravid\w*|amament\w*|remedio\w*|medicamento\w*|alerg\w*|cirurg\w*|tireoide|efeito colateral)\b/.test(normalizar(texto));

/**
 * Pergunta ou relato de saúde que só o operador responde (gestação, amamentação, remédio em uso, alergia, cirurgia,
 * tireoide, câncer, rim, fígado, anticoagulante, efeito colateral, passou mal...). Texto qualquer; normaliza aqui.
 * "Isso é remédio?" (pergunta sobre o produto) não entra: só quem toma/usa remédio ou o mistura com o produto.
 */
const SAUDE_SENSIVEL = new RegExp(
  [
    "\\b(?:gestant\\w*|gravid\\w*|gestacao|amament\\w*|lactante|lactacao|alerg\\w*|cirurg\\w*|operad[oa]|pos operatorio|tireoid\\w*|hipotireoid\\w*|hipertireoid\\w*|efeitos? colaterais?|cancer\\w*|quimio\\w*|radioterap\\w*|rim|rins|renal|renais|figado|hepat\\w*|anticoagulant\\w*|varfarina|marevan|diabet\\w*|hipertens\\w*|pressao alta|infarto|avc|trombose|epilep\\w*|convuls\\w*|lupus|transplant\\w*|dialise|contraindic\\w*)\\b",
    "(?:passei|passou|passar|passamos|ficou|fiquei|me fez|fez) mal\\b",
    "\\b(?:tomo|uso|usando|tomando|faco uso|em uso|tratamento com|controlad\\w*)\\b[^.?!]{0,30}\\b(?:remedios?|medicamentos?|medicacao|medicacoes|comprimidos?)\\b",
    "\\b(?:remedios?|medicamentos?|medicacao)\\b[^.?!]{0,30}\\b(?:junto|misturar|interfere|interacao|conflit\\w*|cortar|continuo|controlad\\w*)\\b",
    "\\bposso tomar (?:junto )?com\\b",
  ].join("|"),
);
export const saudeSensivel = (texto: string) => SAUDE_SENSIVEL.test(normalizar(texto).replace(/\s+/g, " "));

export function decidirVenda(e: EntradaVenda): Decisao {
  const { config: c, texto, lead } = e;
  let l = e.leitura;
  const estado: EstadoConversa = { ...e.estado, dados: { ...e.estado.dados } };
  const d = estado.dados;
  const acoes: Acao[] = [];
  let respondeu = false;
  /** O que esta decisão atingiu; a organização decide quais viram ponto de parada (`./parada.ts`). */
  const eventos: string[] = [];
  const evento = (e: string) => {
    if (!eventos.includes(e)) eventos.push(e);
  };

  /** A lead marcou o dia da compra ("compro dia 20"): o retorno nasce com o motivo "compra" (passo 5b). */
  let compraMarcada = false;
  const fim = (resumo: string): Decisao => {
    if (respondeu) estado.autoSeguidas += 1;
    // A promessa soma o retorno, sem trocar a resposta da objeção nem a escada.
    const falta = ehFaltaDeDinheiro(c, l.intencao, texto) || d.faltaDeDinheiro > 0 || (e.plano.tipo === "objecao" && e.plano.objecao.id === "sem_dinheiro");
    const data = c.retornoReserva.ligado && (falta || compraMarcada) && !estado.quente && ["respondeu", "qualificando"].includes(estado.etapa)
      ? dataDoRetorno(texto, e.agora) : null;
    if (data) {
      d.retornoEm = data.toISOString();
      d.retornoPedido = {
        kit: d.kitEscolhido ?? l.kit,
        condicao: d.entradaOferecida ? c.semCondicao : d.tabelaEnviada ? c.escada[d.degrau] ?? null : null,
        ...(compraMarcada ? { motivo: "compra" as const } : {}),
      };
    }
    return { acoes, estado, resumo, eventos, ...(data ? { retornoEm: data.toISOString() } : {}) };
  };
  const operador = (motivo: string): Decisao => {
    estado.precisaOperador = true;
    estado.motivoOperador = motivo;
    acoes.push({ tipo: "avisar", nivel: "operador", titulo: `Atendimento: ${motivo}`.slice(0, 200), corpo: corpoDoAviso(lead, texto) });
    return fim(`pro operador (${motivo})`);
  };
  const ctx = { lead, agora: e.agora, fusoMinutos: e.fusoMinutos, proibidos: e.proibidos };
  /** Põe uma resposta (ou partes soltas) na saída. false = barrada ou no limite (quem chama manda ao operador). */
  const responder = (resposta: string, partes?: Parte[], valoresExtras: readonly number[] = []): { ok: true } | { ok: false; motivo: string } => {
    if (!respondeu && !podeResponderSozinho(Array<string>(estado.autoSeguidas).fill("auto"), e.limiteAutomaticas)) {
      evento("excedeu_limite");
      return { ok: false, motivo: `limite de ${e.limiteAutomaticas} respostas automáticas seguidas` };
    }
    const m = partes ? montarPartes(partes, ctx) : montarResposta(c.respostas, resposta, ctx);
    if (!m.ok) return { ok: false, motivo: `resposta automática barrada (${resposta}): ${m.motivo}` };
    // Piso de preço (D5): nada automático cita valor fora da tabela nem fala de desconto.
    // `valoresExtras`: os valores do Método, liberados só nas respostas dele.
    for (const p of m.partes) {
      const fora = p.texto ? motivoForaDaTabela(p.texto, c.kits, valoresExtras) : null;
      if (fora) return { ok: false, motivo: `resposta automática barrada (${resposta}): ${fora}` };
    }
    acoes.push({ tipo: "responder", resposta, partes: m.partes });
    respondeu = true;
    return { ok: true };
  };
  const compra = (kit: string | null) => {
    acoes.push({
      tipo: "avisar",
      nivel: "compra",
      titulo: `Quer comprar: ${lead.nome ?? lead.telefone ?? "lead"}${kit ? ` (${kit})` : ""}`.slice(0, 200),
      corpo: c.avisoCompra
        .replaceAll("{nome}", lead.nome ?? "(sem nome)")
        .replaceAll("{telefone}", lead.telefone ?? "")
        .replaceAll("{kit}", kit ?? "a definir")
        .replaceAll("{disse}", trecho(texto, 200)),
    });
  };

  // 1. Encerrado que escreve de novo: só registra.
  if (estado.etapa === "nao_contatar") return { acoes, estado, resumo: "lead na lista de não contatar: só registrado" };

  // 2. Parada dura, número errado, irritação.
  if (l.intencao === "parada" || l.intencao === "numero_errado" || l.irritada) {
    const motivo =
      l.intencao === "numero_errado" ? "Número errado" : l.intencao === "parada" ? `Pediu pra parar: "${trecho(texto)}"` : `Irritada: "${trecho(texto)}"`;
    acoes.push({ tipo: "encerrar", etapa: "nao_contatar", motivo, irritada: l.irritada });
    Object.assign(estado, { etapa: "nao_contatar", quente: false, precisaOperador: false, motivoOperador: null });
    return { acoes, estado, resumo: l.discordou ? "encerrado (parei por segurança; o Jev achou que era conversa)" : "encerrado (parada dura)" };
  }
  // 2a. Opção de queixa (braço A do teste A/B): a lead respondeu à pergunta da abertura
  // com uma das opções ("atrasos", "nada", "e a integração?"). Vem antes do Método, da recusa e dos desvios: "nada não" é
  // resposta à pergunta, não recusa; "integracao" responde e só então vai ao operador. Preço, kit e "quero fechar" vencem.
  const queixa = queixaDaLead(c, l, texto, estado, lead);
  if (queixa) {
    const r = responder(queixa.resposta);
    if (!r.ok) return operador(r.motivo);
    d.queixa = queixa.id;
    estado.etapa = "qualificando";
    if (queixa.operador) return operador(queixa.motivo ?? `escolheu a opção "${queixa.id}": continuar você`);
    return fim(`queixa (${queixa.id}): resposta na fila`);
  }
  // 2b. Método (downsell). Recurso desligado ou config antiga: nada disto roda.
  const m = c.metodo?.ligado ? c.metodo : null;
  const valoresDoMetodo = m ? [m.soMetodoCents, m.comCardapioCents, m.cardapioCents] : [];
  /** A oferta do Método, uma vez por lead e nunca para cliente. */
  const podeOfertarMetodo = Boolean(m) && !d.metodo.oferecido && d.metodo.etapa === "nenhuma" && !ehCliente(c, lead);
  const ofertarMetodo = (resumo: string): Decisao => {
    const r = responder(m!.oferta, undefined, valoresDoMetodo);
    if (!r.ok) return operador(r.motivo);
    d.metodo = { ...d.metodo, etapa: "ofertado", oferecido: true };
    estado.etapa = "qualificando";
    return fim(resumo);
  };
  // "Não é o momento" depois do penúltimo toque do follow-up: pula direto para a oferta (antes de virar "não quer mais").
  const fu = c.followupKit?.ligado ? c.followupKit : null;
  if (
    podeOfertarMetodo &&
    fu &&
    (e.toquesEnviados ?? 0) >= fu.toques.length - 1 &&
    !estado.quente &&
    estado.etapa !== "pronto_fechar" &&
    estado.etapa !== "fechado" &&
    regexDe(fu.semMomento).test(normalizar(texto).replace(/\s+/g, " ").trim())
  ) {
    return ofertarMetodo("não é o momento depois do follow-up do kit: oferta do Método");
  }
  if (l.intencao === "nao_quer_mais" && podeOfertarMetodo) {
    return ofertarMetodo("disse que não tem interesse: oferta do Método");
  }
  // 3. Recusa educada.
  if (l.intencao === "nao_quer_mais") {
    acoes.push({ tipo: "encerrar", etapa: "perdido", motivo: `Disse que não quer: "${trecho(texto)}"`, irritada: false });
    Object.assign(estado, { etapa: "perdido", quente: false, precisaOperador: false, motivoOperador: null });
    return { acoes, estado, resumo: "encerrado (não quer mais, sem resposta)" };
  }
  // 4. Reclamação e desvios da casa.
  if (l.intencao === "reclamacao") return operador(`reclamação: "${trecho(texto, 100)}"`);
  if (/^https?:\/\/\S+$/i.test(texto.trim())) return operador("mandou link: abrir e responder você");
  const desvio = c.desvios.find((x) => {
    try {
      return new RegExp(x.padrao, "i").test(texto);
    } catch {
      return false;
    }
  });
  if (desvio) return operador(`${desvio.motivo} ("${trecho(texto)}")`);
  if (texto === "(áudio)" || texto === "(mídia)") {
    evento("mandou_midia");
    return operador("mandou áudio ou mídia: ouvir e responder");
  }
  // 4b. Desconto/negociação (D5): só o operador negocia.
  if (l.intencao === "pede_desconto" || pedeDesconto(texto)) {
    evento("pede_desconto");
    // Kit junto com desconto NÃO vira compra (D5, `parada.test.ts`): o fechamento depende do preço que só o operador dá.
    return operador(`pediu desconto ou negociar o valor: só você negocia ("${trecho(texto, 100)}")`);
  }

  // 4b2. Saúde que a casa não cobriu com objeção (gestante, remédio, tireoide, alergia, cirurgia...): só o operador responde,
  // antes de interesse, preço ou funil, em qualquer etapa. Objeção configurada que casou (plano `objecao`) segue vencendo;
  // escolha de kit junto com saúde segue o caminho da compra (registra e avisa).
  if (saudeSensivel(texto) && e.plano.tipo !== "objecao" && l.intencao !== "escolheu_kit") {
    evento("saude_sensivel");
    return operador(`dúvida ou relato de saúde: só você responde ("${trecho(texto, 100)}")`);
  }

  // 4c. Dentro do funil do Método: o "sim", a escolha do valor e a espera do Pix (a conversa espera, nada sai).
  if (m && d.metodo.etapa !== "nenhuma" && d.metodo.etapa !== "pago") {
    const t = normalizar(texto).replace(/\s+/g, " ").trim();
    // O "sim" seco só vale como escolha (o valor menor) depois que a mensagem do Pix com o bump já saiu (etapa "escolhendo").
    const escolha = escolhaDoMetodo(t, m, d.metodo.etapa === "escolhendo");
    if (d.metodo.etapa === "aguardando_pix") return operador("escreveu enquanto espera o Pix do Método: confirmar o pagamento e liberar");
    if (escolha) {
      d.metodo = { ...d.metodo, etapa: "aguardando_pix", comCardapio: escolha === "com", valorCents: escolha === "com" ? m.comCardapioCents : m.soMetodoCents };
      evento("pediu_pix_metodo");
      estado.etapa = "qualificando";
      return fim(`Método: escolheu ${escolha === "com" ? "com o cardápio" : "só o método"}, aviso do Pix ao operador (a conversa espera)`);
    }
    // O "sim", o pedido de explicação ("como funciona?", "quanto custa?") ou o interesse que o Jev já leu valem como aceite:
    // `metodo.pedirPix` já explica o Método, dá o preço e oferece o bump. Recusa clara já saiu antes (nao_quer_mais).
    if (d.metodo.etapa === "ofertado" && aceitaOMetodo(t, l.intencao)) {
      const r = responder(m.pedirPix, undefined, valoresDoMetodo);
      if (!r.ok) return operador(r.motivo);
      d.metodo = { ...d.metodo, etapa: "escolhendo" };
      estado.etapa = "qualificando";
      return fim(ehSimDoMetodo(t) ? "Método: disse sim, mensagem do Pix com o bump do cardápio" : "Método: pediu explicação ou mostrou interesse, mensagem do Método com preço e bump");
    }
    if (d.metodo.etapa === "escolhendo") return operador(`Método: não entendi se é só o método ou com o cardápio ("${trecho(texto, 100)}")`);
    // "ofertado" e disse outra coisa: segue o atendimento normal.
  }

  // 5. Já está com o operador.
  if (estado.quente || estado.etapa === "pronto_fechar" || estado.etapa === "fechado") {
    if (l.kit && !d.kitEscolhido) {
      d.kitEscolhido = l.kit;
      compra(l.kit);
      return fim(`quente: kit ${l.kit} anotado e operador avisado`);
    }
    return operador("escreveu de novo (já está com você)");
  }
  if (estado.etapa === "perdido") return operador("tinha sido marcado como perdido e escreveu de novo");

  // 5b. "Compro dia X" (retomada): depois da tabela, a lead marca o dia da compra. Não é compra agora
  // (não para, não avisa, não marca quente): sai a confirmação da casa, se houver, e o retorno fica para o dia
  // (`retornoPedido.motivo = "compra"`; o texto do dia é `modelos.retorno_compra`, senão o do retorno da reserva).
  // Escolher o kit, perguntar o preço e a falta de dinheiro seguem os caminhos de sempre.
  if (
    c.retornoReserva.ligado &&
    d.tabelaEnviada &&
    !l.kit &&
    !["escolheu_kit", "pergunta_preco", "objecao_preco", "sem_dinheiro_agora"].includes(l.intencao) &&
    !ehFaltaDeDinheiro(c, l.intencao, texto) &&
    compraComData(texto, e.agora)
  ) {
    compraMarcada = true;
    estado.etapa = "qualificando";
    // "Quero fechar, pago dia 20": o operador tem de saber na hora que a lead quer comprar.
    // Com o evento, o atendimento cancela o retorno (regra de "quer fechar") e a compra fica com o operador.
    if (l.intencao === "quer_fechar") evento("quer_fechar");
    if (c.respostas.compro_dia_confirma) {
      const r = responder("compro_dia_confirma");
      if (!r.ok) return operador(r.motivo);
    }
    return fim("marcou o dia da compra: retorno agendado para o dia");
  }

  const uso = normalizar(texto);
  if (ehCliente(c, lead) && ["ja_comprou_outro", "elogio", "interesse"].includes(l.intencao) && /\b(?:uso|usando|tomo|tomando)\b/.test(uso) && !/\b(?:outro|outra|outra marca|outro produto)\b/.test(uso)) {
    l = { ...l, intencao: "interesse" };
  }

  // 7. Aceite seco antes da tabela.
  if (!l.kit && !d.tabelaEnviada && ehSoAceite(texto) && ["interesse", "quer_fechar", "escolheu_kit"].includes(l.intencao)) {
    l = { ...l, intencao: "interesse" };
  }

  const plano = e.plano;
  // Pedido do site: quer comprar sozinho.
  if (plano.tipo === "site") {
    const r = responder("site", [{ texto: plano.texto, midia: null }]);
    if (!r.ok) return operador(r.motivo);
    evento("pediu_site");
    estado.quente = true;
    estado.etapa = "pronto_fechar";
    compra(d.kitEscolhido ?? `${plano.links.at(-1)!.meses} meses`);
    return fim(`pediu o site: links (${plano.links.map((x) => x.meses).join(" e ")} meses) e operador avisado`);
  }

  // Recusar o kit menor por preço NÃO oferece o Método: o low ticket só entra
  // depois da cadência sem compra ou quando a lead diz que não tem interesse.

  switch (l.intencao) {
    case "escolheu_kit":
    case "quer_fechar": {
      const kit = plano.tipo === "fechamento" ? `${plano.kit} meses` : (l.kit ?? null);
      // "Quero fechar" SEM dizer a quantidade: ainda não é compra. Não para,
      // não avisa, não marca quente. Qualifica: tabela se ainda não viu os valores, senão a pergunta do kit.
      // Só a quantidade dita (`escolheu_kit`) dispara o pacote de fechamento e, depois dele, a parada.
      if (!kit) {
        // Mas o operador quer saber na hora que o lead disse que quer comprar: ponto de aviso (que não para a conversa).
        evento("quer_fechar");
        if (!d.tabelaEnviada && !ehCliente(c, lead) && c.escada[0]) {
          const tab = responder(c.escada[0]);
          if (!tab.ok) return operador(tab.motivo);
          d.tabelaEnviada = true;
          d.explicacaoEnviada ??= false;
          d.degrau = 0;
          estado.etapa = "qualificando";
          return fim("quer fechar sem dizer o kit: funil de valores (ainda não parou)");
        }
        if (!c.perguntaKit) return operador("quer fechar e não disse o kit: perguntar você");
        const r = responder(c.perguntaKit);
        if (!r.ok) return operador(r.motivo);
        if (estado.etapa === "respondeu") estado.etapa = "qualificando";
        return fim("quer fechar sem dizer o kit: perguntou qual (ainda não parou)");
      }
      evento("escolheu_kit");
      Object.assign(estado, { quente: true, etapa: "pronto_fechar", precisaOperador: false, motivoOperador: null });
      if (kit) d.kitEscolhido = kit;
      if (assuntoSaude(texto)) {
        compra(kit);
        return fim(`quer comprar (${kit}) e relatou questão de saúde: operador avisado`);
      }
      if (plano.tipo === "fechamento") {
        const r = responder("fechamento", plano.partes);
        if (r.ok) d.fechamentoEnviado = true;
      } else if (c.perguntaKit) responder(c.perguntaKit);
      compra(kit);
      return fim(`quer comprar${kit ? ` (${kit})` : ""}: operador avisado, automação parou`);
    }

    case "pergunta_preco":
    case "interesse": {
      const cliente = ehCliente(c, lead);
      // O "Que bom ouvir isso" da reposição só cabe quando o cliente fala bem do tratamento
      // (está tomando, gostando, viu resultado). Qualquer outro interesse, e o "sim" depois da reposição, vai ao funil.
      if (cliente && l.intencao === "interesse" && !d.clienteRespondido && c.clientes && falaBemDoTratamento(texto)) {
        const r = responder(c.clientes.resposta);
        if (!r.ok) return operador(r.motivo);
        d.clienteRespondido = true;
        estado.etapa = "qualificando";
        return fim(`cliente: ${c.clientes.resposta}`);
      }
      if (d.tabelaEnviada) {
        if (l.intencao === "interesse" && ehSoAceite(texto) && c.perguntaKit) {
          const r = responder(c.perguntaKit);
          if (!r.ok) return operador(r.motivo);
          return fim("aceite após valores: perguntou o kit");
        }
        // Viu só o preço e agora quer entender: explica e conduz à escolha do kit, uma vez.
        // Já ouviu a explicação (ou o mesmo áudio como objeção "funciona"), ou não se sabe: operador.
        if (
          l.intencao === "interesse" &&
          d.explicacaoEnviada === false &&
          c.explicacao &&
          c.perguntaKit &&
          !d.objecoesUsadas.includes("funciona")
        ) {
          const r = responder(c.explicacao);
          if (!r.ok) return operador(r.motivo);
          d.explicacaoEnviada = true;
          const p = responder(c.perguntaKit);
          if (!p.ok) return operador(p.motivo);
          return fim("viu a tabela e quis saber mais: explicação do produto + pergunta do kit");
        }
        return operador("já recebeu a tabela e voltou a perguntar: responder com calma");
      }
      const ancora = c.escada[0];
      if (!ancora) return operador("perguntou preço e a casa não tem tabela configurada");
      // Cliente que já comprou conhece o produto: vai direto ao funil, sem a explicação.
      const explica = l.intencao === "interesse" && Boolean(c.explicacao) && !cliente;
      if (explica) {
        const r = responder(c.explicacao!);
        if (!r.ok) return operador(r.motivo);
      }
      const tab = responder(ancora);
      if (!tab.ok) return operador(tab.motivo);
      d.tabelaEnviada = true;
      // Cliente não recebe a explicação nem depois do funil: marcada como já vista.
      d.explicacaoEnviada = explica || cliente;
      d.degrau = 0;
      estado.etapa = "qualificando";
      return fim(explica ? "explicação do produto + funil de valores" : "funil de valores");
    }

    case "saudacao": {
      if (d.saudacaoRespondida || !c.respostas.saudacao) return operador("saudação sem resposta disponível");
      const r = responder("saudacao");
      if (!r.ok) return operador(r.motivo);
      d.saudacaoRespondida = true;
      return fim("saudação");
    }
    case "pagamento": {
      if (plano.tipo === "operador") return operador(plano.motivo);
      if (plano.tipo === "objecao") {
        const o = plano.objecao;
        if (d.objecoesUsadas.includes(o.id)) return operador("objeção de pagamento repetida");
        const r = responder(`obj_${o.id}`, [...(o.midia ? [{ texto: "", midia: o.midia }] : []), { texto: o.pergunta, midia: null }]);
        if (!r.ok) return operador(r.motivo);
        d.objecoesUsadas = [...d.objecoesUsadas, o.id];
        return fim(`objeção (${o.id}): resposta na fila`);
      }
      if (!c.respostas.pagamento) return operador("perguntou sobre pagamento");
      const r = responder("pagamento");
      if (!r.ok) return operador(r.motivo);
      return fim("pagamento");
    }
    case "pergunta_entrega": {
      if (!c.entrega) return operador("perguntou da entrega");
      const r = responder(c.entrega);
      if (!r.ok) return operador(r.motivo);
      if (estado.etapa === "respondeu") estado.etapa = "qualificando";
      return fim("entrega");
    }

    case "objecao_preco": {
      const proximo = d.tabelaEnviada ? d.degrau + 1 : 0;
      const id = c.escada[proximo];
      const tipos = new Set([...d.objecoesRespondidas, "objecao_preco"]);
      if (!id || tipos.size > c.limiteObjecoes) {
        evento("excedeu_limite");
        return operador("objeção de preço depois do último degrau (ou do limite de objeções): responder com calma");
      }
      const r = responder(id);
      if (!r.ok) return operador(r.motivo);
      d.objecoesRespondidas = [...tipos];
      d.degrau = proximo;
      if (!d.tabelaEnviada) d.explicacaoEnviada ??= false;
      d.tabelaEnviada = true;
      estado.etapa = "qualificando";
      return fim(`objeção de preço: desceu para o degrau ${proximo} (${id})`);
    }

    case "elogio": {
      if (ehCliente(c, lead) && c.clientes && !d.clienteRespondido) {
        const r = responder(c.clientes.resposta);
        if (!r.ok) return operador(r.motivo);
        d.clienteRespondido = true;
        estado.etapa = "qualificando";
        return fim("elogio de cliente: resposta da casa");
      }
      return operador("respondeu com elogio: ver se vale oferecer");
    }
  }

  // Falta de dinheiro DE NOVO: só aqui saem os kits de entrada (3 e 2 meses), uma vez. A primeira segue o fluxo normal.
  if (c.semCondicao && ehFaltaDeDinheiro(c, l.intencao, texto)) {
    d.faltaDeDinheiro += 1;
    if (d.faltaDeDinheiro >= 2 && !d.entradaOferecida) {
      const r = responder(c.semCondicao);
      if (!r.ok) return operador(r.motivo);
      d.entradaOferecida = true;
      estado.etapa = "qualificando";
      return fim("falta de dinheiro repetida: kits de entrada (3 e 2 meses)");
    }
  }

  // Objeções (com peça do agente ou com o texto da casa) e o que não foi lido.
  if (OBJECAO_PRIMEIRO.has(l.intencao)) {
    if (plano.tipo === "operador") return operador(plano.motivo);
    const tipo = plano.tipo === "objecao" ? plano.objecao.id : l.intencao === "outro" ? null : l.intencao;
    if (tipo) {
      const ja = d.objecoesRespondidas;
      if (ja.includes(tipo) || new Set([...ja, tipo]).size > c.limiteObjecoes) {
        evento("excedeu_limite");
        return operador(`objeção (${tipo}) de novo ou já respondi ${c.limiteObjecoes}: responder com calma`);
      }
      let r: { ok: true } | { ok: false; motivo: string };
      if (plano.tipo === "objecao") {
        const o = plano.objecao;
        r = responder(`obj_${o.id}`, [...(o.midia ? [{ texto: "", midia: o.midia }] : []), { texto: o.pergunta, midia: null }]);
        if (r.ok) d.objecoesUsadas = [...d.objecoesUsadas, o.id];
      } else {
        const id = c.respostaPorObjecao[l.intencao];
        if (!id) return operador(`objeção (${l.resumo}) sem resposta pronta`);
        r = responder(id);
      }
      if (!r.ok) return operador(r.motivo);
      d.objecoesRespondidas = [...ja, tipo];
      estado.etapa = "qualificando";
      return fim(`objeção (${tipo}): resposta na fila`);
    }
  }

  return operador(`respondeu e não consegui ler com segurança ("${trecho(texto)}")`);
}

/**
 * Quantidade dita solta DEPOIS da tabela ("tenho 4", "4", "fico com 6"): vira o texto
 * "quero o de N meses" para a leitura e o agente (N de 1 a 12). Se a casa não vende esse kit, o
 * agente pergunta qual kit e o operador é avisado mesmo assim, com o N que o lead disse.
 * O aviso e o registro seguem com a frase literal do lead. null = não é isso.
 */
export function quantidadeSolta(texto: string, tabelaEnviada: boolean): string | null {
  if (!tabelaEnviada) return null;
  const m = /^(?:(?:eu|ja|so|apenas)\s+)*(?:tenho|temos|fico com|vou de|vou ficar com|quero|preciso de)?\s*(?:o\s+de\s+)?(\d{1,2})(?:\s*(?:meses|mes))?[.! ]*$/.exec(
    normalizar(texto).replace(/\s+/g, " ").trim(),
  );
  if (!m) return null;
  const meses = Number(m[1]);
  return meses >= 1 && meses <= 12 ? `quero o de ${meses} meses` : null;
}

/** Intenções que vencem a queixa: quem pergunta preço, escolhe kit, quer fechar, pede desconto ou reclama segue o seu caminho. */
const VENCEM_A_QUEIXA = new Set<Intencao>(["pergunta_preco", "escolheu_kit", "quer_fechar", "objecao_preco", "pede_desconto", "reclamacao"]);

/**
 * A opção de queixa que vale para esta mensagem (a primeira de `queixas` cujo gatilho bate), ou null. Só para lead do
 * braço A (`custom_fields.ab_braco = "A"`), antes da tabela, sem queixa anterior, na etapa `respondeu`/`qualificando`,
 * fora do funil do Método, e nunca com relato de saúde (esse é sempre do operador).
 */
function queixaDaLead(c: ConfigVenda, l: LeituraFinal, texto: string, estado: EstadoConversa, lead: LeadDoAtendimento): ConfigQueixa | null {
  if (!c.queixas?.length || lead.campos.ab_braco !== "A") return null;
  const d = estado.dados;
  if (d.tabelaEnviada || d.queixa || estado.quente || d.metodo.etapa !== "nenhuma") return null;
  if (estado.etapa !== "respondeu" && estado.etapa !== "qualificando") return null;
  if (VENCEM_A_QUEIXA.has(l.intencao) || l.kit || pedeDesconto(texto) || saudeSensivel(texto)) return null;
  const t = normalizar(texto).replace(/\s+/g, " ").trim();
  return c.queixas.find((q) => regexDe(q.gatilho).test(t)) ?? null;
}

/** Regex vinda da config; padrão ruim no banco não derruba o atendimento (nunca casa). */
function regexDe(padrao: string): RegExp {
  try {
    return new RegExp(padrao);
  } catch {
    return /$^/;
  }
}

/** O "sim" a quem recebeu a oferta do Método ("sim", "quero", "pode mandar o pix"); "não..." nunca. */
export const ehSimDoMetodo = (t: string) => !/^(nao|n)\b/.test(t) && /^(sim|s|pode|quero|claro|bora|vamos|aham|uhum|ok|manda|me manda|isso)\b/.test(t);

/** Pedido de explicação, de preço ou de garantia a quem recebeu o convite do Método. Mencionar kit, meses ou frascos fica de fora do preço e da garantia. */
const PEDE_EXPLICACAO =
  /\bcomo (e|eh|funciona|faz|fazem|seria|e que funciona)\b|\bme explica\b|\bexplica( melhor| direito)?\b|\bpode (me )?(explicar|contar|falar)\b|\bquero (saber|entender|conhecer|ver)\b|\bdo que se trata\b|\bo que (e|eh) (isso|isto|esse|essa|o metodo)\b|\b(mand\w*|me passa|passa|envia|me envia|fala|me fala|conta|me conta) (mais )?(detalhes|informacoes|info)\b|\bmais (detalhes|informacoes|info)\b/;
const PEDE_PRECO_OU_GARANTIA = /\bquanto (custa|fica|sai|e|eh)\b|\bqual (e )?(o )?(valor|preco|investimento)\b|\bvalor\b|\bpreco\b|\bgarantia\b/;
const FALA_DE_KIT = /\b(kits?|meses|mes|frascos?|potes?|tratamento)\b|\b\d+ ?(m|meses|mes)\b/;

/** "Como funciona?", "quanto custa?", "tem garantia?", "manda mais detalhes": pede explicação do Método (texto já normalizado; "não..." nunca). */
export function pedeExplicacaoDoMetodo(t: string): boolean {
  if (/\bnao\b|^n\b/.test(t)) return false;
  if (PEDE_EXPLICACAO.test(t)) return true;
  return PEDE_PRECO_OU_GARANTIA.test(t) && !FALA_DE_KIT.test(t);
}

/**
 * Aceite do convite do Método: o "sim", o pedido de explicação (regex) ou o interesse que o Jev já leu
 * (`intencao`, sem chamada nova). Recusa ("não...") nunca é aceite. Texto já normalizado.
 */
export function aceitaOMetodo(t: string, intencao?: Intencao): boolean {
  if (ehSimDoMetodo(t) || pedeExplicacaoDoMetodo(t)) return true;
  return intencao === "interesse" && !/\bnao\b|^n\b/.test(t);
}

/**
 * Só o aceite seco, sem dizer qual: "sim", "ok", "pode mandar o pix", "manda o pix", "quero o método", "o mais barato".
 * Frase com mais conteúdo ("quero algo simples", "sim mas tenho uma dúvida") não entra: segue para o operador.
 */
const ACEITE_SECO =
  /^(?:(?:sim|ss|s|ok|okay|claro|aham|uhum|bora|vamos|isso|pode|quero|manda|me manda|mande|vou querer)(?:[ ,.!]+|$))+(?:(?:mandar|me mandar|ser)\s*)?(?:o\s+)?(?:(?:pix|metodo|valor)\s*)*(?:por favor|pfv|pf)?[.! ]*$/;
const MAIS_BARATO = /^(?:(?:quero|fico com|vou de|pode ser)\s+)?(?:o\s+)?(?:mais\s+)?(?:barato|baratinho)[.! ]*$/;

/** Os dois valores da oferta, em centavos, como a organização configurou (`metodo` da config de atendimento). */
export interface ValoresDoMetodo {
  soMetodoCents: number;
  comCardapioCents: number;
}

/**
 * O valor como a lead escreve, para entrar num regex: "30" (com ",00" opcional) ou "29[,.]90". Nenhum número é fixo
 * no leitor: cada organização tem a própria oferta, e o "o de 47" de uma não pode virar escolha na outra.
 */
function valorEscrito(cents: number): string {
  const reais = Math.floor(cents / 100);
  const centavos = cents % 100;
  return centavos === 0 ? `${reais}(?:[,.]00)?` : `${reais}[,.]${String(centavos).padStart(2, "0")}`;
}
const precoSeco = (cents: number) =>
  new RegExp(`^(?:(?:quero|fico com|vou de|pode ser)\\s+)?(?:o\\s+)?(?:de\\s+)?${valorEscrito(cents)}(?:\\s*reais)?[.! ]*$`);
/** "o de 30", "só o de 30", "de 45" no meio da frase; "de 30 dias", "de 30%" ou "de 300" não é o preço 30. */
const precoCitado = (cents: number) =>
  new RegExp(`\\b(?:so (?:o )?(?:de )?|o de |de )${valorEscrito(cents)}(?!\\d)(?![,.]\\d)(?!\\s*(?:dias?|mes|meses|anos?|horas?|minutos?|vezes|%|x\\b))`);

/**
 * Qual valor do Método a lead escolheu: "so" (só o método), "com" (com o cardápio) ou null. Texto já normalizado.
 * `valores` são os da organização (nunca números fixos). `naDuvida` (etapa "escolhendo", depois da mensagem com as duas
 * opções): o aceite seco vale o valor menor. A mensagem do Pix não numera as opções, então "1" e "2" soltos não são escolha.
 */
export function escolhaDoMetodo(t: string, valores: ValoresDoMetodo, naDuvida = true): "so" | "com" | null {
  if (
    /\bso (o )?metodo\b|\b(apenas|somente) (o )?metodo\b|\bsem (o )?cardapio\b|\bnao (quero|vou querer|preciso do?) (o )?cardapio\b|\bo (simples|basico)\b/.test(t) ||
    precoCitado(valores.soMetodoCents).test(t)
  )
    return "so";
  if (
    /\bcom (o )?cardapio\b|\b(quero|vou querer|incluo|inclui|levo|vou levar|quero levar|pode incluir) (o )?cardapio\b|\bcardapio (tambem|junto)\b|\b(os|com os) dois\b|\bambos\b|\bcompleto\b|\bquero tudo\b/.test(t) ||
    precoCitado(valores.comCardapioCents).test(t)
  )
    return "com";
  if (!naDuvida) return null;
  if (precoSeco(valores.comCardapioCents).test(t)) return "com";
  if (precoSeco(valores.soMetodoCents).test(t) || MAIS_BARATO.test(t) || ACEITE_SECO.test(t)) return "so";
  return null;
}

/** Verbo de compra para um dia marcado ("compro dia 20", "fecho sexta", "pago mês que vem"); texto normalizado. */
const COMPRA_NO_DIA = /\b(compro|vou comprar|fecho|faco o pedido|pego|pago)\b/;
const NEGA_A_COMPRA = /\b(nao|n) (vou )?(compr|fech|faco|peg|pag)/;

/** A data em que a lead disse que compra, ou null (sem verbo de compra, com negação ou sem data que `dataDoRetorno` leia). */
export function compraComData(texto: string, agora: Date): Date | null {
  const t = normalizar(texto).replace(/\s+/g, " ").trim();
  if (!COMPRA_NO_DIA.test(t) || NEGA_A_COMPRA.test(t)) return null;
  return dataDoRetorno(texto, agora);
}

/** Objeção da casa (por gatilho) que é "não tenho dinheiro"; a intenção `sem_dinheiro_agora` também vale. */
const OBJECAO_SEM_DINHEIRO = "sem_dinheiro";
const ehFaltaDeDinheiro = (c: ConfigVenda, intencao: Intencao, texto: string) =>
  intencao === "sem_dinheiro_agora" || objecaoPorRegra(c.objecoes, texto)?.id === OBJECAO_SEM_DINHEIRO;

/**
 * Lead sorteado num teste A/B da abertura (`custom_fields.ab_teste` preenchido): entra
 * no teste como quem ainda não conhece o produto, então NÃO é cliente, mesmo com classe P1-P4, `produto_origem` ou
 * trilha de cliente (quem só tinha classe ou produto de origem caía aí). Vale aqui e em `situacaoDoKit` (`../repositorio-supabase.ts`).
 */
export const noTesteAB = (campos: Record<string, unknown> | null | undefined): boolean =>
  typeof campos?.ab_teste === "string" && campos.ab_teste.trim().length > 0 && !comprouDepoisDoSorteio(campos);

/**
 * Compra aprovada (`custom_fields.compras_aprovadas`, `{ [transação]: "aprovada" }`, gravada pela integração de pagamento
 * da organização): quem comprou depois de sorteado volta a ser cliente. Reembolso troca o valor e não conta.
 */
const comprouDepoisDoSorteio = (campos: Record<string, unknown>): boolean => {
  const compras = campos.compras_aprovadas;
  return Boolean(compras) && typeof compras === "object" && !Array.isArray(compras) && Object.values(compras as Record<string, unknown>).includes("aprovada");
};

export const ehCliente = (c: ConfigVenda, lead: LeadDoAtendimento) =>
  !noTesteAB(lead.campos) &&
  Boolean((typeof lead.campos.classe === "string" && /^P[1-4]$/i.test(lead.campos.classe.trim())) || (typeof lead.campos.produto_origem === "string" && lead.campos.produto_origem.trim()) || (c.clientes && typeof lead.campos.trilha === "string" && c.clientes.trilhas.includes(lead.campos.trilha)));

export function corpoDoAviso(lead: LeadDoAtendimento, texto: string): string {
  return [`${lead.nome ?? "(sem nome)"} · ${lead.telefone ?? "sem telefone"}`, `Disse: "${trecho(texto, 300)}"`].join("\n");
}
