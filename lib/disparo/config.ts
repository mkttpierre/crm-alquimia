/**
 * Configuração do motor de disparo, por organização.
 *
 * Fonte: `disparo_config` (migration 0234). As colunas simples (modo, ligado,
 * teto diário, cadência) vivem como coluna; o resto do ritmo vive em
 * `disparo_config.ritmo` (jsonb) e SÓ é lido por este schema — nenhum leitor
 * anda no path do jsonb direto (anti-pattern nº 6 do CLAUDE.md).
 *
 * Os defaults são o regime do motor portado de um motor anterior depois da restrição de
 * Janela 8h-19h de segunda a sábado e 8h-12h no domingo, nunca
 * menos de 10 min entre mensagens novas, no máximo 6 aberturas por hora, pausa
 * longa de 20 a 40 min a cada 5 a 9 envios novos (chip maduro: 15 a 30 a cada
 * 7 a 12; domingo: 12 a 20 a cada 10 a 14), rampa de 10 a 36 aberturas por dia.
 * Conferido contra `src/lib/ritmo.ts` de um CRM anterior.
 * Organização que precisa de outro regime (a organização B: só dia útil, almoço livre)
 * sobrescreve no jsonb — o motor não sabe de qual negócio é.
 */
import { z } from "zod";

/** Bloco de horário do dia, em minutos desde a meia-noite local. `fim` é exclusivo. */
export const blocoSchema = z
  .object({ inicio: z.number().int().min(0).max(1440), fim: z.number().int().min(0).max(1440) })
  .refine((b) => b.fim > b.inicio, { message: "bloco com fim antes do início" });
export type Bloco = z.infer<typeof blocoSchema>;

const faixaSchema = z
  .object({ min: z.number().min(0), max: z.number().min(0) })
  .refine((f) => f.max >= f.min, { message: "faixa com máximo menor que o mínimo" });
export type Faixa = z.infer<typeof faixaSchema>;

/**
 * Feriados nacionais (sem envio). Lista, não cálculo: Carnaval e Corpus Christi
 * móveis já entram datados, e quem opera tira ou põe um dia sem deploy
 * (ex.: uma organização que envia num feriado tira a data do jsonb dela).
 */
export const FERIADOS_NACIONAIS = [
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-04-03", "2026-04-21", "2026-05-01", "2026-06-04",
  "2026-09-07", "2026-10-12", "2026-11-02", "2026-11-15", "2026-11-20", "2026-12-25",
  "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-26", "2027-04-21", "2027-05-01", "2027-05-27",
  "2027-09-07", "2027-10-12", "2027-11-02", "2027-11-15", "2027-11-20", "2027-12-25",
] as const;

/**
 * Condição sobre um campo do lead (`crm_leads.custom_fields`): `igual` (um
 * valor ou lista de valores aceitos) e/ou `minimo` (número). Usada pela
 * escolha de modelo e pelo filtro de relevância dos lembretes.
 */
export const condicaoSchema = z.object({
  campo: z.string().min(1),
  igual: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]).optional(),
  minimo: z.number().optional(),
});
export type Condicao = z.infer<typeof condicaoSchema>;

const objetoOuVazio = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Padrão da trava de não entregue (`ritmo.naoEntregue`). */
export const NAO_ENTREGUE_PADRAO = { ligado: true, horasMarcar: 24, horasRemover: 48, janelaDias: 7 } as const;

const grampo = (v: unknown, padrao: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : padrao;

/**
 * `ritmo.naoEntregue` como o worker o entende (`lerConfigTrava` delega para cá): só `false` desliga, número fora da
 * faixa é grampeado, não-número volta ao padrão, `horasRemover` nunca abaixo de `horasMarcar`, `janelaDias` inteiro.
 */
export function normalizarNaoEntregue(bruto: unknown): { ligado: boolean; horasMarcar: number; horasRemover: number; janelaDias: number } {
  const c = objetoOuVazio(bruto);
  const horasMarcar = grampo(c.horasMarcar, NAO_ENTREGUE_PADRAO.horasMarcar, 1, 24 * 7);
  return {
    ligado: c.ligado === false ? false : NAO_ENTREGUE_PADRAO.ligado,
    horasMarcar,
    horasRemover: Math.max(horasMarcar, grampo(c.horasRemover, NAO_ENTREGUE_PADRAO.horasRemover, 1, 24 * 14)),
    janelaDias: Math.round(grampo(c.janelaDias, NAO_ENTREGUE_PADRAO.janelaDias, 1, 30)),
  };
}

export const ritmoSchema = z.object({
  /** Deslocamento do fuso local em minutos (São Paulo = -180, sem horário de verão desde 2019). */
  fusoMinutos: z.number().int().min(-720).max(840).default(-180),
  /** Blocos de envio de mensagem NOVA. Lista vazia = não prospecta nesse dia. */
  janela: z
    .object({
      semana: z.array(blocoSchema).default([{ inicio: 8 * 60, fim: 19 * 60 }]),
      sabado: z.array(blocoSchema).default([{ inicio: 8 * 60, fim: 19 * 60 }]),
      domingo: z.array(blocoSchema).default([{ inicio: 8 * 60, fim: 12 * 60 }]),
    })
    .prefault({}),
  feriados: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([...FERIADOS_NACIONAIS]),
  /** Piso duro entre duas mensagens NOVAS do mesmo chip (abertura ou toque), em minutos. */
  intervaloNovaPisoMin: z.number().min(1).default(10),
  /** Intervalo sorteado entre mensagens novas (chip em rampa e chip maduro). */
  intervaloNova: faixaSchema.default({ min: 10, max: 18 }),
  intervaloNovaMaduro: faixaSchema.default({ min: 10, max: 15 }),
  /** Primeiros dias da rampa: espaçamento maior (índice 0 = dia 1). */
  intervaloInicioRampa: z.array(faixaSchema).default([
    { min: 20, max: 40 },
    { min: 15, max: 30 },
  ]),
  intervaloDomingo: faixaSchema.default({ min: 10, max: 13 }),
  /** Ritmo humano: de vez em quando, um intervalo a mais. */
  extraChance: z.number().min(0).max(1).default(1 / 6),
  extra: faixaSchema.default({ min: 5, max: 15 }),
  /** Piso entre QUAISQUER duas mensagens do chip (respostas inclusive), em segundos. */
  intervaloMinimoSeg: z.number().int().min(0).default(90),
  maxEnviosHora: z.number().int().min(1).default(12),
  maxAberturasHora: z.number().int().min(1).default(6),
  limitePorClasseDia: z.record(z.string(), z.number().int().min(0)).default({}),
  /**
   * Pausa longa: dura `pausa` minutos a cada `pausaACada` envios novos (pontas
   * inclusive). Chip maduro (`diaMaduro` em diante) e domingo têm faixa própria;
   * `null` = usa a faixa comum (a organização B, que não diferencia).
   */
  pausa: faixaSchema.default({ min: 20, max: 40 }),
  pausaACada: faixaSchema.default({ min: 5, max: 9 }),
  pausaMaduro: faixaSchema.nullable().default({ min: 15, max: 30 }),
  pausaACadaMaduro: faixaSchema.nullable().default({ min: 7, max: 12 }),
  pausaDomingo: faixaSchema.nullable().default({ min: 12, max: 20 }),
  pausaACadaDomingo: faixaSchema.nullable().default({ min: 10, max: 14 }),
  /** Aberturas por chip por dia, pelo dia da rampa (índice 0 = dia 1; depois do fim, o último). */
  rampa: z.array(z.number().int().min(0)).min(1).default([10, 12, 14, 17, 20, 23, 26, 29, 32, 34, 36]),
  diaMaduro: z.number().int().min(1).default(12),
  /**
   * Chips que ficam um degrau atrás na rampa e com no máximo `rampaAtrasadaTeto` aberturas por dia (uma organização faz isso com
   * os chips de outra oferta, base mais fria). Lista de nomes de chip; vazia = ninguém.
   */
  chipsRampaAtrasada: z.array(z.string()).default([]),
  rampaAtrasadaTeto: z.number().int().min(1).default(50),
  /**
   * Rampa própria de um chip (aberturas por dia, índice 0 = dia 1; depois do fim, o último valor). Serve ao chip
   * frio, sem histórico, que precisa começar bem abaixo da rampa da organização. Vence `chipsRampaAtrasada`.
   * Chave = nome do chip em `disparo_chips`. Vazio = todos seguem a rampa da organização.
   */
  rampasPorChip: z.record(z.string(), z.array(z.number().int().min(0)).min(1)).default({}),
  /** Imagem única da abertura, com o modelo como legenda. Null conserva texto/prévia por lead. Validada antes de enfileirar. */
  aberturaMidiaId: z.string().nullable().default(null),
  /**
   * Quem pode receber a próxima abertura (todos os campos vêm de `custom_fields` do lead). Tudo desligado por padrão:
   * a organização B não usa. `porChipOrigem`: o lead só sai pelo chip em `chip_origem` (trilha do produto: o produto A nos chips
   * alfa/beta, o produto B nos chips gama/delta). `classes`: só estas classes (vazia = todas). `semPendenciaOperador`: pula quem
   * tem `precisa_operador`.
   */
  filtroAbertura: z
    .object({
      porChipOrigem: z.boolean().default(false),
      classes: z.array(z.string()).default([]),
      semPendenciaOperador: z.boolean().default(false),
      /** Campos de `custom_fields` que precisam ser iguais ao valor (texto), ex.: `{ d1_pronto: "true" }` (organização B). */
      camposIguais: z.record(z.string().regex(/^[a-z_0-9]+$/), z.string()).default({}),
    })
    .prefault({}),
  /**
   * Freios de saúde do chip (PLANO-DISPAROS 5.3), calculados por chip por dia sobre as aberturas do dia.
   * Os limiares são frações (0,02 = 2%): `amarelo` é o teto do verde, `vermelho` o teto do amarelo.
   * Ver `lib/disparo/saude.ts`.
   */
  saude: z
    .object({
      ligado: z.boolean().default(true),
      /** De quanto em quanto tempo o motor recalcula a saúde de um chip (a conta lê o banco). */
      recalcularACadaMin: z.number().min(1).default(15),
      /** Bloqueio provável: aberturas ainda com 1 tique depois de `horasSemEntrega` horas. */
      horasSemEntrega: z.number().min(1).default(6),
      bloqueio: z.object({ amarelo: z.number().min(0).default(0.02), vermelho: z.number().min(0).default(0.04) }).prefault({}),
      /** "Não quero" + "pare" sobre as aberturas do dia. */
      naoQuero: z.object({ amarelo: z.number().min(0).default(0.03), vermelho: z.number().min(0).default(0.05) }).prefault({}),
      /** Irritação, "spam", denúncia, Procon: contagem no dia (>= amarelo e >= vermelho). */
      irritacao: z.object({ amarelo: z.number().int().min(1).default(1), vermelho: z.number().int().min(1).default(2) }).prefault({}),
      /** Taxa de resposta, só depois de `minAberturas` aberturas na janela de `janelaDias` dias. */
      resposta: z
        .object({
          minAberturas: z.number().int().min(1).default(30),
          janelaDias: z.number().int().min(1).max(30).default(7),
          ok: z.number().min(0).default(0.05),
          vermelho: z.number().min(0).default(0.03),
        })
        .prefault({}),
      /** Reconexões no dia que fazem amarelo; close, 428 ou logout é vermelho direto. */
      reconexoesAmarelo: z.number().int().min(1).default(1),
      /** Duração mínima, em segundos, para distinguir reconexão de refresh rápido. */
      reconexaoMinSegundos: z.number().int().min(0).default(30),
      /** Abaixo disto de aberturas maduras (percentuais sem amostra enganam), a % não é avaliada. */
      amostraMinima: z.number().int().min(1).default(5),
      /** Só avalia o bloqueio provável se ao menos esta fração das aberturas maduras tem algum ack (cobertura do dado). */
      coberturaMinima: z.number().min(0).max(1).default(0.5),
      /** Vermelho para o chip por tantas horas e volta ao dia 1; só a mão do operador o liga de novo. */
      vermelhoHoras: z.number().min(1).default(48),
    })
    .prefault({}),
  /**
   * Quarentena e frequência por lead (PLANO-DISPAROS 5.4). Opt-out e parada continuam permanentes
   * (`contacts.is_blocked`); isto cuida do lead que só não respondeu.
   */
  quarentena: z
    .object({
      ligado: z.boolean().default(true),
      /** Dias fora depois do último toque sem resposta. */
      dias: z.number().int().min(1).default(45),
      /** No máximo 1 abordagem fria (abertura) por lead a cada tantos dias. */
      diasEntreAbordagens: z.number().int().min(1).default(30),
      /** Mensagens do motor sem resposta no mês (janela de `diasEntreAbordagens`) antes de segurar a próxima. */
      maxSemRespostaMes: z.number().int().min(1).default(3),
    })
    .prefault({}),
  /**
   * Validade da fila (auditoria 3): o que ficou parado (chip vermelho dias, pausa, motor desligado) não
   * sai depois fora de contexto. A sequência do operador tem a própria (30 min, `VALIDADE_DA_SEQUENCIA_MS`).
   */
  validade: z
    .object({
      /** Resposta automática (`origem = 'auto'`) atrasada mais que isto sobre o agendado é cancelada, com aviso. */
      autoHoras: z.number().min(0.25).default(2),
      /** Toque de cadência atrasado mais que isto é reprogramado (não sai em rajada quando o chip volta). */
      toqueAtrasoHoras: z.number().min(1).default(24),
      /** O toque reprogramado vai para um horário sorteado dentro destas próximas horas (o ritmo do chip segue valendo). */
      toqueEspalharHoras: z.number().min(1).default(24),
      /** Linha `enviando` há mais que isto (minutos) é encerrada pela varredura de presos. */
      enviandoPresoMin: z.number().min(5).default(10),
      /** Motor ligado sem NADA sair por tantas horas de janela aberta no dia: aviso de parada silenciosa na Central. */
      paradaSilenciosaHoras: z.number().min(1).default(4),
    })
    .prefault({}),
  /** Teto TOTAL do chip no dia = aberturas × fator + folga (respostas e toques também aquecem). */
  fatorTotal: z.number().min(1).default(2.2),
  folgaTotal: z.number().int().min(0).default(10),
  /** Primeiro envio do dia sai num minuto sorteado, nunca em ponto. */
  primeiroEnvioDoDiaMin: faixaSchema.default({ min: 0, max: 25 }),
  /** Respostas automáticas seguidas sem o operador no meio. Depois disso, segura e avisa. */
  limiteAutomaticasSeguidas: z.number().int().min(0).default(2),
  /** "golpe" sozinho é parada dura? (B2B sim; numa organização é objeção de medo de compra.) */
  golpeEhParada: z.boolean().default(false),
  /** Janela, em segundos depois do nosso envio, em que uma resposta pronta conta como robô. */
  respostaAutomaticaSeg: z.number().int().min(0).default(120),
  /**
   * Passos manuais (lembretes ao operador, ex.: D4 áudio e D10 ligação da
   * organização B). `tetoDia`: no máximo N lembretes daquele tipo por dia na
   * organização (tipo ausente = sem teto). `relevancia`: só leads que batem em
   * PELO MENOS UMA condição recebem o lembrete (lista vazia = todos); os outros
   * pulam direto para o próximo passo automático, e o pulo fica registrado.
   */
  lembretes: z
    .object({
      tetoDia: z.record(z.string(), z.number().int().min(0)).default({}),
      relevancia: z.array(condicaoSchema).default([]),
    })
    .prefault({}),
  /**
   * Trava de não entregue (`lib/disparo/trava-nao-entregue.ts`): lead com 1 tique sem entrega por `horasMarcar` horas
   * sai dos envios novos; por `horasRemover`, sai da fila do chip. Ligada por padrão. TOLERANTE campo a campo, com o
   * mesmo grampo que o worker aplica (`normalizarNaoEntregue`): um valor estranho aqui nunca derruba o ritmo inteiro
   * para o padrão. A edição pela tela é estrita (`lib/disparo-painel/esquemas.ts`). A variável
   * `DISPARO_TRAVA_NAO_ENTREGUE=off` no servidor vence o banco e desliga tudo (trava de emergência).
   */
  naoEntregue: z.preprocess(
    normalizarNaoEntregue,
    z.object({ ligado: z.boolean(), horasMarcar: z.number(), horasRemover: z.number(), janelaDias: z.number().int() }),
  ),
  /**
   * Chip mudo (`lib/disparo/sem-confirmacao.ts`): o aviso na Central sai sempre; `pausa` decide se o motor também
   * pausa o chip (só com o freio de saúde ligado). Desligada por padrão, e só `true` a liga (tolerante como o bloco
   * acima). A variável `DISPARO_CHIP_MUDO_PAUSA`, quando definida no servidor, vence o banco (`on` liga, qualquer
   * outro valor desliga).
   */
  chipMudo: z.preprocess((v) => ({ pausa: objetoOuVazio(v).pausa === true }), z.object({ pausa: z.boolean() })),
});
export type Ritmo = z.infer<typeof ritmoSchema>;

/**
 * O que a imagem da abertura (`ritmo.aberturaMidiaId`) pode ser: o motor manda imagem com a mensagem como legenda,
 * e só isso. Vídeo ainda não sai por esse caminho. Vale na tela (gaveta Personalizar) e no PATCH de config.
 */
export const MIMES_DA_ABERTURA = ["image/jpeg", "image/png", "image/webp"] as const;
export const ABERTURA_SO_IMAGEM = "A abertura aceita só imagem; vídeo ainda não é enviado pelo motor.";

export const MODOS = ["simulado", "real"] as const;
export type ModoDisparo = (typeof MODOS)[number];

/** A linha de `disparo_config` já normalizada. */
export type ConfigDisparo = {
  organizationId: string;
  ligado: boolean;
  modo: ModoDisparo;
  /** Limite externo de aberturas por chip por dia (null = só a rampa). */
  tetoDiario: number | null;
  cadencia: string;
  fonteStageId: string | null;
  ritmo: Ritmo;
  /** Modelos de texto por tipo (`abertura`, `toque_2`...) ou `tipo:grupo`. */
  modelos: Record<string, string[]>;
  /** Padrões proibidos da casa, além dos de sempre. */
  proibidos: Proibido[];
  /** Slots fixos da organização e regra de esconder o nome (`disparo_config.slots`). */
  slots: SlotsDaOrg;
  /** Qual lista de `modelos` cada lead recebe, em ordem (`disparo_config.escolha`). */
  escolha: RegraDeEscolha[];
  /**
   * Janela das respostas (`disparo_config.atendimento.janelaResposta`, minutos locais, todo dia). O motor a confere de
   * novo na hora de enviar a resposta automática e a sequência do operador. Ausente = 8h–22h.
   */
  janelaResposta?: { inicioMin: number; fimMin: number } | null;
};

/**
 * Regra da casa para o verificador. `excetoUltimo`: liberado só no último toque
 * (a "última cartada" de uma organização — o brinde extra — só pode aparecer na última
 * mensagem ao lead).
 */
export type Proibido = { padrao: string; motivo: string; excetoUltimo?: boolean };

/** Sem o `.default`: é a forma que a edição pela tela valida (um default ali apagaria o que não veio no corpo). */
export const modelosBaseSchema = z.record(z.string(), z.array(z.string()));
export const modelosSchema = modelosBaseSchema.default({});
export const proibidosBaseSchema = z.array(
  z.object({ padrao: z.string().min(1), motivo: z.string().min(1), excetoUltimo: z.boolean().optional() }),
);
export const proibidosSchema = proibidosBaseSchema.default([]);

/**
 * `disparo_config.slots`: valores iguais para todo lead da organização (ex.: o
 * nome do operador da organização B) e quando o nome do lead NÃO deve ir no texto
 * (ex.: número da recepção, `porta = blindada`).
 */
export const slotsSchema = z
  .object({
    fixos: z.record(z.string().regex(/^[a-z_0-9]+$/), z.string()).default({}),
    semNomeQuando: z.array(condicaoSchema).default([]),
  })
  .prefault({});
export type SlotsDaOrg = z.infer<typeof slotsSchema>;

/**
 * `disparo_config.escolha`: regras em ordem. Para um passo `tipo`, valem as
 * regras daquele tipo cujas condições (TODAS) batem com o lead; cada uma aponta
 * uma lista de `modelos`. O motor tenta a primeira; se faltar campo para
 * preencher o texto, tenta a seguinte (é assim que "pelo nome" cai para "sem
 * nome" na organização B). Sem regra para o tipo, vale a lista `tipo:grupo` e depois
 * `tipo`.
 */
export const regraDeEscolhaSchema = z.object({
  tipo: z.string().min(1),
  quando: z.array(condicaoSchema).default([]),
  lista: z.string().min(1),
});
export type RegraDeEscolha = z.infer<typeof regraDeEscolhaSchema>;
export const escolhaSchema = z.array(regraDeEscolhaSchema).default([]);

/** A condição bate com os campos do lead? Campo ausente nunca bate. */
export function bateCondicao(c: Condicao, campos: Record<string, unknown>): boolean {
  const v = campos[c.campo];
  if (v === undefined || v === null || v === "") return false;
  if (c.igual !== undefined) {
    const aceitos = Array.isArray(c.igual) ? c.igual : [c.igual];
    if (!aceitos.some((a) => String(a) === String(v))) return false;
  }
  if (c.minimo !== undefined && !(Number(v) >= c.minimo)) return false;
  return true;
}

/** Ritmo com todos os defaults (o que vale para uma org sem nada no jsonb). */
export const RITMO_PADRAO: Ritmo = ritmoSchema.parse({});

/** Lê o jsonb do banco sem nunca lançar: valor inválido cai no padrão. */
export function lerRitmo(bruto: unknown): Ritmo {
  const r = ritmoSchema.safeParse(bruto ?? {});
  return r.success ? r.data : RITMO_PADRAO;
}
