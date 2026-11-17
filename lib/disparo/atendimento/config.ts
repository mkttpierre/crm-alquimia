/**
 * Configuração do ATENDIMENTO (o que acontece quando o lead responde), por
 * organização.
 *
 * Fonte: `disparo_config.atendimento` (jsonb, migration 0241), lido SÓ por este
 * schema (anti-pattern nº 6). Tudo que é da casa — textos, áudios, objeções,
 * kits, escada de preço, pacote de fechamento — é DADO da organização: o código
 * não conhece a voz de nenhum negócio. Os dois perfis portados dos CRMs antigos:
 *
 *   venda        venda para pessoa pelo WhatsApp (o atendimento de uma organização): tabela
 *                de preços, escada de kits, objeções com áudio pronto, pacote de
 *                fechamento e aviso de compra ao operador.
 *   prospeccao   prospecção fria para empresa (o atendimento da organização B):
 *                pergunta o motivo do não, responde objeção com pergunta, manda
 *                o convite do diagnóstico ao interesse claro; horário e agenda
 *                ficam com o operador (a agenda é a Fase 6).
 *
 * Mídia aponta para `media_library` por id (e nome, para quem lê o jsonb). O id
 * é resolvido pelo seed da organização; o atendimento não sobe arquivo.
 */
import { z } from "zod";

import { logger } from "../../logger";
import { ETAPAS_ATENDIMENTO } from "./estado";

export const midiaSchema = z.object({
  /** `media_library.id` da MESMA organização. null = ainda não importada (o envio é barrado). */
  id: z.uuid().nullable().default(null),
  nome: z.string().min(1),
  /** Duração do áudio em segundos: a parte seguinte espera ele tocar. */
  segundos: z.number().min(0).optional(),
});
export type Midia = z.infer<typeof midiaSchema>;

/** Uma mensagem de uma resposta: texto (com `{slot}`), mídia, ou os dois (texto vira legenda). */
export const parteSchema = z
  .object({ texto: z.string().default(""), midia: midiaSchema.nullable().default(null) })
  .refine((p) => p.texto.trim() !== "" || p.midia !== null, { message: "parte sem texto e sem mídia" });
export type Parte = z.infer<typeof parteSchema>;

const idSchema = z.string().regex(/^[a-z0-9_]{2,40}$/);

/**
 * Para onde vai o card do funil quando a etapa do atendimento muda: etapa do
 * atendimento → `crm_stages.slug` do funil do lead. Etapa ausente = o card não
 * se mexe (ex.: "respondeu" na organização B fica em cadência). `{}` = o atendimento
 * não move card nenhum. Quem aplica é `./funil.ts`; o seed confere que o slug
 * existe no funil padrão da organização.
 */
export const funilSchema = z.partialRecord(z.enum(ETAPAS_ATENDIMENTO), z.string().regex(/^[a-z0-9_-]{1,80}$/)).default({});
export type MapaDoFunil = z.infer<typeof funilSchema>;

/**
 * Respostas prontas: id → versões; cada versão é uma SEQUÊNCIA de partes (o
 * funil de valores de uma organização são 7 partes; o convite da organização B são 2). A versão sai
 * girando por lead, para dois leads não receberem o mesmo texto ao mesmo tempo.
 */
export const respostasSchema = z.record(idSchema, z.array(z.array(parteSchema).min(1)).min(1)).default({});
export type Respostas = z.infer<typeof respostasSchema>;

/**
 * Objeção com peça pronta. `gatilho` é regex sobre o texto normalizado (sem
 * acento, minúsculo); a ORDEM importa (a primeira que bate ganha). `jev` é a
 * descrição que o julgamento barato usa quando o gatilho não bate. `pergunta`
 * sai junto: a peça sozinha nunca fecha a conversa. `soPeloGatilho`: o Jev não
 * libera esta peça (dúvida de saúde é do operador quando não é o gatilho exato).
 */
export const objecaoSchema = z.object({
  id: idSchema,
  gatilho: z.string().min(1),
  jev: z.string().min(1),
  midia: midiaSchema.nullable().default(null),
  pergunta: z.string().min(1),
  soPeloGatilho: z.boolean().default(false),
});
export type Objecao = z.infer<typeof objecaoSchema>;

export const kitSchema = z.object({
  meses: z.number().int().min(1).max(36),
  potes: z.number().int().min(0),
  gratis: z.number().int().min(0),
  pixCents: z.number().int().min(0),
  /**
   * Valor da parcela do cartão (a tabela diz "12x 92,77"), em centavos. Entra na
   * lista de valores PERMITIDOS: nenhum texto automático do perfil venda cita
   * dinheiro que não seja o pix ou a parcela de um kit (ver `./parada.ts`).
   */
  parcelaCents: z.number().int().min(0).optional(),
  link: z.url(),
  /** Só depois que a escada acabou (kit de entrada). */
  ultimoRecurso: z.boolean().default(false),
});
export type Kit = z.infer<typeof kitSchema>;

/**
 * Situações em que a decisão do atendimento PODE disparar um ponto de parada.
 * Quem as emite são `venda.ts` e `prospeccao.ts`; a lista fecha o vocabulário (um
 * gatilho de config com evento que ninguém emite seria evento sem consumer).
 *
 * `quer_fechar` fica no vocabulário só para não invalidar configs já gravadas: a
 * decisão NÃO o emite ("quero fechar" sem dizer a quantidade não para;
 * com a quantidade dita o evento é `escolheu_kit`). Config nova não deve usá-lo.
 */
export const EVENTOS_DE_PARADA = [
  "escolheu_kit",
  "quer_fechar",
  "pediu_site",
  "pede_desconto",
  "excedeu_limite",
  "lead_quente",
  "horario",
  "diagnostico_enviado",
  "mandou_midia",
  "pediu_pix_metodo",
  "retorno_reserva_enviado",
] as const;
export type EventoDeParada = (typeof EVENTOS_DE_PARADA)[number];

/**
 * PONTO DE PARADA: o objetivo que, atingido, passa a conversa ao operador. Dado da
 * organização (`disparo_config.atendimento.parada`). O gatilho é um `evento` da
 * decisão e/ou um `padrao` (regex sobre o texto normalizado, sem acento e
 * minúsculo: ex. o lead deu endereço). Quando dispara:
 *   parar     a conversa é pausada pelo mesmo mecanismo do botão "pausar automático"
 *             da tela (`bot_silenced_until`): o atendimento cala e o botão "retomar" devolve;
 *   notificar o aviso no formato da casa vai ao celular pessoal do operador
 *             (`parada.celular`) — atrás da trava de envio real; em simulado só é registrado;
 *   etapa     o card vai para a etapa (slug) do funil do lead; com `pipeline` (slug),
 *             muda de funil; sem recuar card que já está adiante;
 *   tag       etiqueta aplicada ao lead e à conversa, para o operador filtrar.
 */
export const pontoDeParadaSchema = z
  .object({
    id: idSchema,
    evento: z.enum(EVENTOS_DE_PARADA).optional(),
    padrao: z.string().min(1).optional(),
    /** Rótulo do aviso: "VALORES" em "Respondeu VALORES". */
    titulo: z.string().min(1).max(60),
    /** Formato próprio do aviso deste ponto (no lugar de `parada.aviso`); aceita também `{chip}`. */
    aviso: z.string().min(1).optional(),
    parar: z.boolean().default(true),
    notificar: z.boolean().default(true),
    etapa: z.string().regex(/^[a-z0-9_-]{1,80}$/).optional(),
    pipeline: z.string().regex(/^[a-z0-9_-]{1,80}$/).optional(),
    tag: z.string().trim().toLowerCase().min(1).max(40).optional(),
  })
  .refine((p) => p.evento !== undefined || p.padrao !== undefined, { message: "ponto de parada sem gatilho (evento ou padrao)" })
  .refine((p) => p.pipeline === undefined || p.etapa !== undefined, { message: "pipeline sem etapa de destino" });
export type PontoDeParada = z.infer<typeof pontoDeParadaSchema>;

export const paradaSchema = z
  .object({
    /** WhatsApp pessoal do operador, só dígitos com DDI (ex.: 5511999999999). null = não notifica. */
    celular: z.string().regex(/^\d{10,15}$/).nullable().default(null),
    /** Formato do aviso: `{titulo}`, `{nome}`, `{telefone}`, `{disse}`. */
    aviso: z.string().min(1).default("Respondeu {titulo}\nNome: {nome}\nWhatsApp: {telefone}"),
    pontos: z.array(pontoDeParadaSchema).default([]),
  })
  .prefault({});
export type ConfigDeParada = z.infer<typeof paradaSchema>;

/**
 * Janela em que as RESPOSTAS automáticas podem sair (minutos desde a meia-noite local), todo dia.
 * Própria do atendimento: não mexe na janela de prospecção do ritmo. Resposta decidida fora dela
 * fica para o início da janela (mais um sorteio de minutos). Padrão 8h–22h.
 */
export const janelaRespostaSchema = z
  .object({ inicioMin: z.number().int().min(0).max(1439).default(8 * 60), fimMin: z.number().int().min(1).max(1440).default(22 * 60) })
  .refine((j) => j.fimMin > j.inicioMin, { message: "janelaResposta: o fim tem de ser depois do início" })
  .prefault({});
export type JanelaResposta = z.infer<typeof janelaRespostaSchema>;

/** Texto que manda direto para o operador (ex.: assunto que só ele trata). */
export const desvioSchema = z.object({ padrao: z.string().min(1), motivo: z.string().min(1) });

/**
 * Resposta a uma opção de queixa (retomada): a abertura do braço A do teste A/B pergunta o que mais
 * incomoda e a lead responde com uma palavra ("atrasos", "nada", "e a integração?"). `gatilho` é regex sobre o texto
 * normalizado (sem acento, minúsculo, espaços juntos); a ORDEM da lista importa (a primeira que bate vence).
 * `operador`: responde e passa a conversa ao operador (com `motivo`, ou um motivo padrão). Uma por conversa, só antes
 * da tabela e só para lead com `custom_fields.ab_braco = "A"` (ver `decidirVenda`).
 */
export const queixaSchema = z.object({
  id: idSchema,
  gatilho: z.string().min(1),
  resposta: idSchema,
  operador: z.boolean().default(false),
  motivo: z.string().min(1).nullable().default(null),
});
export type ConfigQueixa = z.infer<typeof queixaSchema>;

/**
 * Produto barato "Oferta de Entrada" (downsell). Tudo é dado da casa: os textos moram em `respostas`
 * (ids abaixo) e os valores aqui. Ausente ou `ligado: false` = recurso desligado (config antiga segue igual).
 * Os valores do Método (e só eles) passam na trava de preço, e só nas respostas `oferta` e `pedirPix`.
 */
export const metodoSchema = z.object({
  ligado: z.boolean().default(false),
  /** Oferta do Método (uma vez por lead, nunca para cliente). */
  oferta: idSchema,
  /** Resposta ao "sim": o Pix do método mais o bump do cardápio, na mesma mensagem. */
  pedirPix: idSchema,
  /** Valores em centavos: só o método / com o cardápio / o cardápio sozinho (trava de preço e leitura da escolha). Sem default: cada organização tem a própria oferta. */
  soMetodoCents: z.number().int().min(1),
  comCardapioCents: z.number().int().min(1),
  cardapioCents: z.number().int().min(0),
  /** `{link_entrega}` das mensagens depois do pagamento. Sem ele a confirmação não agenda nada. */
  linkEntrega: z.url().nullable().default(null),
  /** Link de quem pagou com o cardápio (`comCardapioCents`). Sem ele, a entrega usa `linkEntrega`. */
  linkEntregaComCardapio: z.url().nullable().default(null),
  /** Mensagens depois do pagamento confirmado: D0 (na hora), D7 e D14 (ids de `respostas`). */
  d0: idSchema,
  d7: idSchema,
  d14: idSchema,
  diasD7: z.number().int().min(1).default(7),
  diasD14: z.number().int().min(1).default(14),
  /** Marca VIP gravada na conversa depois do pagamento (desconto no Pix do kit, em %). */
  vipDescontoPct: z.number().int().min(0).max(100).default(10),
});
export type ConfigMetodo = z.infer<typeof metodoSchema>;

/**
 * Follow-up do kit (só para quem viu a tabela e parou de responder): toques a `dia` dias da última mensagem
 * da lead; depois do último sem retorno em `horasAteOferta`, entra a oferta do Método (se estiver ligada).
 */
export const followupKitSchema = z.object({
  ligado: z.boolean().default(false),
  toques: z.array(z.object({ dia: z.number().int().min(1).max(60), resposta: idSchema })).min(1).max(9),
  horasAteOferta: z.number().int().min(1).max(240).default(48),
  /** Depois do penúltimo toque, estas frases (regex sobre o texto normalizado) pulam direto para a oferta do Método. */
  semMomento: z.string().min(1).default("nao (e|eh) (o )?momento|agora nao|nao quero (agora|no momento)|mais pra frente|outra hora"),
  /**
   * Os mesmos toques também quando o OPERADOR manda o funil de valores pela caixa de conversa (retomada).
   * Padrão desligado. `funis`: prefixos do `tipo` na fila (o atalho com `_`). `liberaOperador`: quem mandou
   * o funil foi o operador, então a pendência da conversa (`precisa_operador`) é dada como atendida e os toques saem.
   */
  aposFunilDoOperador: z
    .object({
      ligado: z.boolean().default(false),
      funis: z.array(z.string().min(1)).default(["funil_valores"]),
      liberaOperador: z.boolean().default(true),
    })
    .prefault({}),
});
export type ConfigFollowupKit = z.infer<typeof followupKitSchema>;

export const vendaSchema = z.object({
  perfil: z.literal("venda"),
  ligado: z.boolean().default(false),
  respostas: respostasSchema,
  objecoes: z.array(objecaoSchema).default([]),
  /** Do maior para o menor. */
  kits: z.array(kitSchema).default([]),
  /**
   * Escada de preço: ids de `respostas`. Índice 0 é a âncora (a tabela que sai
   * na pergunta de preço); cada objeção de preço desce UM degrau, sem pular; o
   * último é o de menor valor que a casa oferece sozinha. Acabou a escada, é com o operador.
   */
  escada: z.array(idSchema).default([]),
  /**
   * Kits de entrada (os que ficam fora da tabela e da escada): id de `respostas` que só sai quando
   * o lead diz de novo que não tem dinheiro (a 2ª vez), uma vez por conversa. Ausente = vai ao operador.
   */
  semCondicao: idSchema.nullable().default(null),
  /** Oferta de Entrada (downsell). Ausente = desligado. */
  metodo: metodoSchema.nullable().default(null),
  /** Retorno de quem prometeu uma data por falta de dinheiro. Opt-in por organização. */
  retornoReserva: z.object({ ligado: z.boolean().default(false) }).prefault({}),
  /** Follow-up de 7 toques do kit. Ausente = desligado. */
  followupKit: followupKitSchema.nullable().default(null),
  /** Resposta que explica o produto antes da tabela ("quero sim" antes da tabela). */
  explicacao: idSchema.nullable().default(null),
  /** Respostas fixas por situação. Ausente = a situação vai para o operador. */
  entrega: idSchema.nullable().default(null),
  perguntaKit: idSchema.nullable().default(null),
  /** Respostas de texto para as objeções que nenhuma peça com áudio cobriu (intenção → id). */
  respostaPorObjecao: z.record(z.string(), idSchema).default({}),
  fechamento: z
    .object({
      partes: z.array(parteSchema).min(1),
      /**
       * Campanha com brinde que depende do plano (ex.: dois brindes só no de 12 meses): enquanto `ate` não passou,
       * o pacote de fechamento abre com `doze` (kit de 12 meses) ou `outros` (qualquer outro kit).
       */
      brindes: z.object({ ate: z.string().min(1), doze: z.string().min(1), outros: z.string().min(1) }).nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Pedido de link: texto com `{links}`; recomenda o kit um acima do escolhido. */
  site: z.object({ texto: z.string().min(1), textoSemAcima: z.string().min(1) }).nullable().default(null),
  /** Leads de quem já comprou (campo `trilha`): elogio e interesse viram esta resposta, uma vez. */
  clientes: z.object({ trilhas: z.array(z.string()).min(1), resposta: idSchema }).nullable().default(null),
  desvios: z.array(desvioSchema).default([]),
  /** Respostas às opções de queixa (braço A do teste A/B, antes da tabela). Vazio = desligado. Ver `queixaSchema`. */
  queixas: z.array(queixaSchema).default([]),
  /** Objeções automáticas de TIPOS diferentes numa conversa (preço conta uma vez, a escada inteira). */
  limiteObjecoes: z.number().int().min(0).default(2),
  /** Confiança mínima do Jev para escolher a objeção. */
  confiancaObjecaoJev: z.number().min(0).max(1).default(0.75),
  /** Aviso de compra ao operador (Central). `{nome}`, `{telefone}`, `{kit}`, `{disse}`. */
  funil: funilSchema,
  /** Pontos de parada (objetivos que passam a conversa ao operador). Ver `pontoDeParadaSchema`. */
  parada: paradaSchema,
  /** Janela das respostas automáticas (padrão 8h-22h); fora dela a resposta espera abrir. */
  janelaResposta: janelaRespostaSchema,
  avisoCompra: z.string().default("Quer comprar: {nome} ({telefone}). Kit: {kit}. Disse: \"{disse}\""),
  /** Contexto curto do negócio para as perguntas do Jev ("vendedor de um produto de exemplo"). */
  contextoJev: z.string().default("vendedor falando com um cliente pelo WhatsApp"),
});
export type ConfigVenda = z.infer<typeof vendaSchema>;

export const prospeccaoSchema = z.object({
  perfil: z.literal("prospeccao"),
  ligado: z.boolean().default(false),
  respostas: respostasSchema,
  /**
   * Objeções que a casa responde com pergunta, uma vez cada. `gatilho` é regex
   * sobre o texto normalizado (ordem importa); a resposta é `objecao_<id>`.
   */
  objecoes: z.array(z.object({ id: idSchema, gatilho: z.string().min(1), descricao: z.string().min(1) })).default([]),
  /** Objeção que pede a conversa com quem decide junto (resposta própria, sempre avisa). */
  objecaoDecisor: idSchema.nullable().default(null),
  /** Convite do diagnóstico ao interesse claro: URL base; o link leva `?c=<campo codigo>`. */
  diagnostico: z
    .object({ url: z.url(), campoCodigo: z.string().default("codigo"), etapasAntesDaConversa: z.array(z.string()).default([]) })
    .nullable()
    .default(null),
  funil: funilSchema,
  parada: paradaSchema,
  /** Janela das respostas automáticas (padrão 8h-22h); fora dela a resposta espera abrir. */
  janelaResposta: janelaRespostaSchema,
  contextoJev: z.string().default("prospecção comercial para empresas pelo WhatsApp"),
});
export type ConfigProspeccao = z.infer<typeof prospeccaoSchema>;

export const atendimentoSchema = z.discriminatedUnion("perfil", [vendaSchema, prospeccaoSchema]);
export type ConfigAtendimento = z.infer<typeof atendimentoSchema>;

/**
 * Lê o jsonb sem nunca lançar. Inválido ou vazio = null (o atendimento não roda
 * e a mensagem só fica registrada, como antes desta etapa).
 *
 * Exceção: se o ÚNICO problema é o bloco `metodo` (Oferta de Entrada, opcional) — por exemplo
 * sem os valores, que não têm default —, só o Método fica desligado, o resto do atendimento
 * segue, e o log diz quais campos faltam. Desligar a organização inteira por um recurso
 * opcional incompleto seria a falha mais surpreendente. `errosDaConfig` segue apontando o campo.
 */
export function lerConfigAtendimento(bruto: unknown): ConfigAtendimento | null {
  const r = atendimentoSchema.safeParse(bruto);
  if (r.success) return r.data;
  const soNoMetodo = r.error.issues.length > 0 && r.error.issues.every((i) => i.path[0] === "metodo");
  if (!soNoMetodo || typeof bruto !== "object" || bruto === null) return null;
  const semMetodo = atendimentoSchema.safeParse({ ...(bruto as Record<string, unknown>), metodo: null });
  if (!semMetodo.success) return null;
  avisarMetodoIncompleto(
    (bruto as Record<string, unknown>).metodo,
    r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  );
  return semMetodo.data;
}

/**
 * A leitura roda a cada tick do motor e a cada mensagem: o aviso sai UMA vez por bloco `metodo` distinto (por
 * processo), e não sai quando o bloco já diz `ligado: false` (desligado de propósito, só sem os valores).
 */
const METODOS_JA_AVISADOS = new Set<string>();
function avisarMetodoIncompleto(metodo: unknown, campos: string[]): void {
  if (typeof metodo === "object" && metodo !== null && (metodo as { ligado?: unknown }).ligado === false) return;
  let chave: string;
  try {
    chave = JSON.stringify(metodo) ?? "";
  } catch {
    chave = "";
  }
  if (METODOS_JA_AVISADOS.has(chave)) return;
  if (METODOS_JA_AVISADOS.size >= 500) METODOS_JA_AVISADOS.clear();
  METODOS_JA_AVISADOS.add(chave);
  logger.warn("atendimento: bloco metodo inválido, Oferta de Entrada desligada; o resto do atendimento segue", { campos });
}

/** Erros legíveis do jsonb (o seed confere antes de gravar). */
export function errosDaConfig(bruto: unknown): string[] {
  const r = atendimentoSchema.safeParse(bruto);
  if (r.success) return conferirReferencias(r.data);
  return r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

/** Referências internas: toda resposta citada existe; todo gatilho compila. */
export function conferirReferencias(c: ConfigAtendimento): string[] {
  const erros: string[] = [];
  for (const p of c.parada.pontos) {
    if (p.padrao !== undefined) {
      try {
        new RegExp(p.padrao);
      } catch {
        erros.push(`parada.${p.id}: padrão não compila`);
      }
    }
  }
  if (new Set(c.parada.pontos.map((p) => p.id)).size !== c.parada.pontos.length) erros.push("parada: id repetido");
  if (c.parada.pontos.some((p) => p.notificar) && !c.parada.celular) erros.push("parada: ponto manda notificar, mas parada.celular não está configurado");
  const existe =(id: string | null, onde: string) => {
    if (id && !c.respostas[id]) erros.push(`${onde}: resposta "${id}" não existe`);
  };
  if (c.perfil === "venda") {
    c.escada.forEach((id, i) => existe(id, `escada[${i}]`));
    existe(c.explicacao, "explicacao");
    existe(c.entrega, "entrega");
    existe(c.perguntaKit, "perguntaKit");
    existe(c.semCondicao, "semCondicao");
    if (c.metodo) {
      existe(c.metodo.oferta, "metodo.oferta");
      existe(c.metodo.pedirPix, "metodo.pedirPix");
      existe(c.metodo.d0, "metodo.d0");
      existe(c.metodo.d7, "metodo.d7");
      existe(c.metodo.d14, "metodo.d14");
      if (c.metodo.ligado && !c.parada.pontos.some((p) => p.evento === "pediu_pix_metodo")) {
        erros.push("metodo ligado sem ponto de parada pediu_pix_metodo: o operador não seria avisado do Pix");
      }
    }
    if (c.followupKit) {
      c.followupKit.toques.forEach((t, i) => existe(t.resposta, `followupKit.toques[${i}]`));
      try {
        new RegExp(c.followupKit.semMomento);
      } catch {
        erros.push("followupKit.semMomento: padrão não compila");
      }
    }
    for (const [k, id] of Object.entries(c.respostaPorObjecao)) existe(id, `respostaPorObjecao.${k}`);
    if (c.clientes) existe(c.clientes.resposta, "clientes.resposta");
    for (const o of c.objecoes) {
      try {
        new RegExp(o.gatilho);
      } catch {
        erros.push(`objecoes.${o.id}: gatilho não compila`);
      }
    }
    if (new Set(c.objecoes.map((o) => o.id)).size !== c.objecoes.length) erros.push("objecoes: id repetido");
    for (const d of c.desvios) {
      try {
        new RegExp(d.padrao);
      } catch {
        erros.push(`desvios: padrão não compila (${d.motivo})`);
      }
    }
    for (const q of c.queixas) {
      existe(q.resposta, `queixas.${q.id}`);
      try {
        new RegExp(q.gatilho);
      } catch {
        erros.push(`queixas.${q.id}: gatilho não compila`);
      }
    }
    if (new Set(c.queixas.map((q) => q.id)).size !== c.queixas.length) erros.push("queixas: id repetido");
  } else {
    for (const o of c.objecoes) {
      existe(`objecao_${o.id}`, `objecoes.${o.id}`);
      try {
        new RegExp(o.gatilho);
      } catch {
        erros.push(`objecoes.${o.id}: gatilho não compila`);
      }
    }
    if (c.objecaoDecisor) existe(`objecao_${c.objecaoDecisor}`, "objecaoDecisor");
    existe("motivo", "motivo (pergunta do não)");
    if (c.diagnostico) {
      existe("diagnostico_convite", "diagnostico");
      existe("diagnostico_link", "diagnostico");
    }
  }
  return erros;
}
