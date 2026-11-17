/**
 * Contrato da tela do motor de disparo (`/app/disparo`): o que as rotas
 * `GET /api/v1/disparo/{estado,fila,chips,conversas}` devolvem e o que o
 * `PATCH /api/v1/disparo/config` aceita.
 *
 * A tela edita o motor INTEIRO (ritmo completo, cadência, etapa
 * de origem, mensagens, proibidos e modo). O que continua de fora, e este arquivo
 * é onde isso fica escrito em código:
 *
 *   - `organization_id` no corpo é recusado com 422 (o schema é `.strict()`; a
 *     organização vem da sessão);
 *   - `modo` só com papel `admin` (`papelNecessario`), e o envio real segue
 *     exigindo também `DISPARO_REAL_LIBERADO=sim` no servidor, que nenhuma rota toca;
 *   - nada que o motor não aceitaria: o ritmo parcial passa pelo próprio
 *     `ritmoSchema`, e chave que ele descartaria vira 422 em vez de sumir.
 */
import { z } from "zod";

import { CADENCIAS } from "@/lib/disparo/cadencia";
import { blocoSchema, MODOS, modelosBaseSchema, proibidosBaseSchema, ritmoSchema } from "@/lib/disparo/config";
import { PERFIS } from "@/lib/disparo/perfis";

/** Estados da fila (`disparo_envios.estado`). */
export const ESTADOS_DA_FILA = ["pendente", "enviando", "enviado", "simulado", "cancelado", "falhou"] as const;
export type EstadoDaFila = (typeof ESTADOS_DA_FILA)[number];

/** "fila" = o que ainda vai sair ou saiu simulado: a visão padrão da tela. */
export const FILTROS_DA_FILA = ["fila", ...ESTADOS_DA_FILA] as const;
export type FiltroDaFila = (typeof FILTROS_DA_FILA)[number];

export const TAMANHO_DA_PAGINA = 20;

export const consultaDaFilaSchema = z.object({
  estado: z.enum(FILTROS_DA_FILA).default("fila"),
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
});

export const FILTROS_DE_CONVERSA = ["todas", "operador", "quentes"] as const;
export const consultaDeConversasSchema = z.object({
  filtro: z.enum(FILTROS_DE_CONVERSA).default("todas"),
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
});

/** Minutos desde a meia-noite (0 a 1440). A tela edita em "HH:MM". */
const bloco = blocoSchema;
const faixa = z
  .object({ min: z.number().min(0).max(24 * 60), max: z.number().min(0).max(24 * 60) })
  .refine((f) => f.max >= f.min, { message: "faixa com máximo menor que o mínimo" });

/**
 * Limites da tela nos campos básicos do ritmo (mais apertados que os do motor: ninguém precisa de 5 blocos num
 * dia nem de 200 aberturas por hora). Valem por cima do `ritmoSchema` na edição.
 */
export const edicaoDoRitmoSchema = z
  .object({
    janela: z
      .object({
        semana: z.array(bloco).max(4),
        sabado: z.array(bloco).max(4),
        domingo: z.array(bloco).max(4),
      })
      .partial()
      .strict(),
    intervaloNova: faixa,
    pausa: faixa,
    pausaACada: faixa,
    maxAberturasHora: z.number().int().min(1).max(60),
    maxEnviosHora: z.number().int().min(1).max(120),
    /**
     * O `ritmoSchema` é tolerante nestes dois blocos (grampeia o valor estranho para nunca derrubar o ritmo inteiro);
     * a edição pela tela é estrita: valor fora da faixa é 422, não grampo silencioso.
     */
    naoEntregue: z
      .object({
        ligado: z.boolean(),
        horasMarcar: z.number().min(1).max(24 * 7),
        horasRemover: z.number().min(1).max(24 * 14),
        janelaDias: z.number().int().min(1).max(30),
      })
      .partial()
      .strict()
      .refine((n) => n.horasMarcar === undefined || n.horasRemover === undefined || n.horasRemover >= n.horasMarcar, {
        message: "remover antes de marcar",
      }),
    chipMudo: z.object({ pausa: z.boolean() }).partial().strict(),
  })
  .partial()
  .strict();

export type EdicaoDoRitmo = z.infer<typeof edicaoDoRitmoSchema>;

const objetoSimples = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Caminhos de chave que existem na entrada e o `ritmoSchema` descartou na saída (chave que o motor não conhece). */
function chavesDescartadas(entrada: unknown, saida: unknown, caminho: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(entrada) && Array.isArray(saida)) {
    return entrada.flatMap((v, i) => chavesDescartadas(v, saida[i], [...caminho, i]));
  }
  if (!objetoSimples(entrada) || !objetoSimples(saida)) return [];
  return Object.keys(entrada).flatMap((k) =>
    Object.hasOwn(saida, k) ? chavesDescartadas(entrada[k], saida[k], [...caminho, k]) : [[...caminho, k]],
  );
}

/**
 * Ritmo parcial: qualquer campo do `ritmoSchema`, validado por ele mesmo. A SAÍDA é a entrada intacta, sem os
 * valores padrão: o PATCH mescla no jsonb gravado (`mesclarRitmo`), e um padrão injetado aqui apagaria o que está
 * gravado e não veio no corpo. O conjunto mesclado passa de novo pelo `ritmoSchema` na rota.
 */
export const edicaoDoRitmoCompletaSchema = z.record(z.string(), z.unknown()).superRefine((parcial, ctx) => {
  const r = ritmoSchema.safeParse(parcial);
  if (!r.success) {
    for (const issue of r.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path as (string | number)[] });
    return;
  }
  for (const caminho of chavesDescartadas(parcial, r.data)) {
    ctx.addIssue({ code: "custom", message: "campo que o motor não conhece", path: caminho });
  }
  const basicos = Object.fromEntries(Object.entries(parcial).filter(([k]) => k in edicaoDoRitmoSchema.shape));
  const limites = edicaoDoRitmoSchema.safeParse(basicos);
  if (!limites.success) {
    for (const issue of limites.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path as (string | number)[] });
  }
});

const cadenciaSchema = z.string().refine((id) => Object.hasOwn(CADENCIAS, id), { message: "cadência desconhecida" });

/** Maior padrão de palavra proibida aceito pela tela. */
export const TAMANHO_MAXIMO_DO_PROIBIDO = 200;

/**
 * Quantificador aninhado óbvio — `(x+)+`, `(a*)*`, `(?:ab+){2,}` —, o desenho clássico de regex que trava o processo
 * (backtracking catastrófico) a cada texto verificado. O verificador roda no motor para todo envio: um padrão desses
 * gravado pela tela pararia o motor inteiro. Não é um detector completo; pega o óbvio.
 */
const QUANTIFICADOR_ANINHADO = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

const proibidosDaEdicaoSchema = proibidosBaseSchema.max(200).superRefine((regras, ctx) => {
  regras.forEach((regra, i) => {
    if (regra.padrao.length > TAMANHO_MAXIMO_DO_PROIBIDO) {
      ctx.addIssue({ code: "custom", message: "padrão longo demais", path: [i, "padrao"] });
      return;
    }
    if (QUANTIFICADOR_ANINHADO.test(regra.padrao)) {
      ctx.addIssue({ code: "custom", message: "quantificador aninhado (trava o motor)", path: [i, "padrao"] });
      return;
    }
    try {
      new RegExp(regra.padrao, "i");
    } catch {
      ctx.addIssue({ code: "custom", message: "expressão inválida", path: [i, "padrao"] });
    }
  });
});

/** Chave de `modelos` = um tipo de envio: o mesmo formato do CHECK de `disparo_envios.tipo` (migration 0234). */
const TIPO_DE_ENVIO = /^[a-z0-9_:]{2,40}$/;

export const edicaoDaConfigSchema = z
  .object({
    /** Pausa: `false` para o motor; `true` o retoma (sempre sob a trava dupla). */
    ligado: z.boolean(),
    /** Aberturas por chip por dia; `null` tira o teto e fica só a rampa. */
    teto_diario: z.number().int().min(1).max(500).nullable(),
    ritmo: edicaoDoRitmoCompletaSchema,
    /**
     * Atalho: aplica os campos do perfil (`lib/disparo/perfis.ts`) no ritmo gravado. Mesma permissão de quem edita o
     * ritmo. Com `ritmo` junto, o perfil vai primeiro e a edição por cima.
     */
    perfil: z.enum(PERFIS),
    /** Um id de `CADENCIAS` (`lib/disparo/cadencia.ts`). */
    cadencia: cadenciaSchema,
    /** Etapa de onde saem os leads das aberturas. A rota confere que é da organização (422 se não for). */
    fonte_stage_id: z.uuid().nullable(),
    /** Variações por tipo (`abertura`, `toque_2`, `tipo:grupo`...). Substitui a lista inteira. */
    modelos: modelosBaseSchema
      .refine((m) => Object.keys(m).length <= 100, { message: "tipos demais" })
      .refine((m) => Object.keys(m).every((tipo) => TIPO_DE_ENVIO.test(tipo)), { message: "tipo com formato inválido" }),
    proibidos: proibidosDaEdicaoSchema,
    /** Só `admin` (`papelNecessario`). Real só envia com `DISPARO_REAL_LIBERADO=sim` no servidor. */
    modo: z.enum(MODOS),
  })
  .partial()
  // `.strict()` é a trava: `organization_id` ou qualquer campo desconhecido vira 422.
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nada para alterar" });
export type EdicaoDaConfig = z.infer<typeof edicaoDaConfigSchema>;

/** Papel mínimo para aplicar a edição: trocar o `modo` é do `admin`; o resto, do `manager`. */
export function papelNecessario(edicao: EdicaoDaConfig): "manager" | "admin" {
  return edicao.modo !== undefined ? "admin" : "manager";
}

/** O que a tela mostra do ritmo vigente (já com os defaults do motor). */
export type RitmoVigente = z.infer<typeof ritmoSchema>;

export type EstadoDoMotor = {
  existe: boolean;
  ligado: boolean;
  /** O que está gravado na organização. */
  modo: "simulado" | "real";
  /** O que vale de verdade agora: só "real" com as DUAS chaves. */
  modo_efetivo: "simulado" | "real";
  /** Primeira chave: `disparo_config.modo = real`. */
  chave_da_organizacao: boolean;
  /** Segunda chave: variável do servidor. Só o booleano, nunca o valor. */
  chave_do_servidor: boolean;
  /** Terceira trava (opcional): null = sem restrição; número = quantos destinos a lista permite. Nunca os números. */
  destinos_permitidos: number | null;
  motivo_simulado: string | null;
  teto_diario: number | null;
  cadencia: string;
  atendimento_ligado: boolean;
  agora: string;
  fuso_minutos: number;
  hoje: {
    data: string;
    feriado: boolean;
    janela: { inicio: number; fim: number }[];
    dentro_da_janela: boolean;
  };
  janela: {
    semana: { inicio: number; fim: number }[];
    sabado: { inicio: number; fim: number }[];
    domingo: { inicio: number; fim: number }[];
  };
  ritmo: {
    intervalo_nova: { min: number; max: number };
    intervalo_piso_min: number;
    pausa: { min: number; max: number };
    pausa_a_cada: { min: number; max: number };
    max_aberturas_hora: number;
    max_envios_hora: number;
  };
  /** Menor `proximo_envio_em`/`enviar_apos` entre o que ainda vai sair. */
  proximo_envio: { quando: string; origem: "chip" | "fila" } | null;
  contagens: Record<EstadoDaFila, number> & { hoje: number };
  chips: { total: number; ativos: number; sem_canal: number };
};

export type EnvioDaTela = {
  id: string;
  estado: EstadoDaFila;
  tipo: string;
  origem: string;
  passo: { ordem: number; total: number; dia: number | null; automatico: boolean } | null;
  texto: string;
  tem_midia: boolean;
  enviar_apos: string;
  enviado_em: string | null;
  motivo: string | null;
  lead: { id: string; nome: string } | null;
  chip: { id: string; nome: string } | null;
};

/** Os números e os motivos da cor do chip no dia local (`disparo_saude_dia`, calculados em `lib/disparo/saude.ts`). */
export type SaudeDoDiaDaTela = {
  dia: string;
  saude: "verde" | "amarelo" | "vermelho";
  dia_rampa: number;
  aberturas: number;
  respostas: number;
  /** Janela longa da taxa de resposta (7 dias por padrão): a taxa só vale depois de 30 aberturas nela. */
  aberturas_janela: number;
  respostas_janela: number;
  /** Aberturas reais com mais de 6 h e quantas delas têm status de entrega: a base do bloqueio provável. */
  maduras: number;
  com_ack: number;
  bloqueio_provavel: number;
  nao_quero: number;
  irritacao: number;
  reconexoes: number;
  quedas: number;
  motivos: { indicador: string; cor: "amarelo" | "vermelho"; texto: string }[];
  calculado_em: string;
};

export type ChipDaTela = {
  id: string;
  nome: string;
  estado: "rampa" | "ativo" | "pausado" | "desligado";
  saude: "verde" | "amarelo" | "vermelho";
  dia_rampa: number;
  /** A conexão do chip (`channel_sessions.id`); null = chip sem canal (só simula). */
  channel_session_id: string | null;
  tem_canal: boolean;
  pausado_ate: string | null;
  proximo_envio_em: string | null;
  ultimo_envio_em: string | null;
  envios_hoje: number;
  teto_hoje: number;
  /** Por que a cor é amarela ou vermelha agora (texto do último cálculo ou do freio de restrição). */
  saude_motivo: string | null;
  /** null = o motor ainda não calculou a saúde deste chip hoje. */
  saude_do_dia: SaudeDoDiaDaTela | null;
};

export type ConversaDaTela = {
  lead_id: string;
  lead_nome: string;
  etapa: string;
  quente: boolean;
  precisa_operador: boolean;
  motivo_operador: string | null;
  auto_seguidas: number;
  atualizada_em: string;
  ultima_leitura: { texto: string; decisao: string | null; irritada: boolean; em: string } | null;
  conversation_id: string | null;
};

export type Pagina<T> = { itens: T[]; pagina: number; tamanho: number; total: number };

/** Uma etapa ativa da organização, para escolher de onde vêm os leads do motor. */
export type EtapaDaTela = { id: string; nome: string; funil_id: string; funil: string };

/** `GET /api/v1/disparo/config`: o que a tela edita. */
export type ConfigDaTela =
  | { existe: false; recomendado: RitmoVigente }
  | {
      existe: true;
      etapas: EtapaDaTela[];
      /** A etapa escolhida, quando ela (ou o funil dela) foi arquivada; null se está ativa ou não há escolha. */
      etapa_arquivada: { id: string; nome: string } | null;
      leads_na_etapa: number | null;
      ligado: boolean;
      modo: "simulado" | "real";
      teto_diario: number | null;
      cadencia: string;
      fonte_stage_id: string | null;
      ritmo: RitmoVigente;
      perfil: "conservador" | "recomendado" | "acelerado" | "personalizado";
      modelos: Record<string, string[]>;
      proibidos: { padrao: string; motivo: string; excetoUltimo?: boolean }[];
      recomendado: RitmoVigente;
    };

/** `GET /api/v1/disparo/simulacao` (as datas chegam como texto ISO). */
export type SimulacaoDaTela = {
  perfil: string;
  perfil_atual: string;
  dia: string;
  janela: { inicio: number; fim: number }[];
  fuso_minutos: number;
  porChip: { nome: string; diaRampa: number; envios: string[]; pausas: { inicio: string; fim: string }[]; parado: string | null }[];
  totalNovas: number;
  primeira: string | null;
  ultima: string | null;
  pausasLongas: number;
};

/** Um problema de validação devolvido pelo PATCH (422), com o caminho do campo. */
export type ProblemaDeCampo = { caminho: string; mensagem: string };

