/**
 * Estado da conversa de atendimento de um lead e o vocabulário da decisão.
 *
 * Fonte: `disparo_conversas` (migration 0241), uma linha por lead. `etapa`,
 * `quente`, `precisa_operador` e `auto_seguidas` são coluna (a tela e o SQL de
 * prova leem direto); o resto do que a conversa já gastou (tabela enviada,
 * degrau da escada, objeções respondidas, kit escolhido) mora em `dados` jsonb,
 * lido SÓ por `lerDados` abaixo.
 *
 * Quando a etapa muda, o card do funil (`crm_leads.stage_id`) acompanha pela
 * equivalência que a organização declarou em `atendimento.funil` (ver
 * `./funil.ts`). Sem mapa, o card não se mexe — o padrão de toda config.
 */
import { z } from "zod";

import type { Leitura } from "../leitura";
import type { Parte } from "./config";

export const ETAPAS_ATENDIMENTO = ["respondeu", "qualificando", "pronto_fechar", "fechado", "perdido", "nao_contatar"] as const;
export type EtapaAtendimento = (typeof ETAPAS_ATENDIMENTO)[number];

/** Estados da conversa de prospecção (portados de um motor anterior, sem os de agenda). */
export const ESTADOS_PROSPECCAO = ["livre", "pediu_motivo", "objecao_respondida", "aguardando_operador"] as const;
export type EstadoProspeccao = (typeof ESTADOS_PROSPECCAO)[number];

export const dadosSchema = z
  .object({
    tabelaEnviada: z.boolean().default(false),
    /** Degrau da escada de preço já mostrado (0 = âncora). */
    degrau: z.number().int().min(0).default(0),
    /** Tipos de objeção que já receberam resposta automática (preço conta uma vez). */
    objecoesRespondidas: z.array(z.string()).default([]),
    /** Peças de objeção já usadas (cada uma sai uma vez). */
    objecoesUsadas: z.array(z.string()).default([]),
    /** Quantas vezes o lead disse que não tem dinheiro (a repetida libera os kits de entrada). */
    faltaDeDinheiro: z.number().int().min(0).default(0),
    /** Os kits de entrada (3 e 2 meses) já foram oferecidos. */
    entradaOferecida: z.boolean().default(false),
    kitEscolhido: z.string().nullable().default(null),
    /** Data do retorno combinado; null depois de cancelado ou enviado. */
    retornoEm: z.string().datetime().nullable().default(null),
    /** `motivo` "compra" = a lead marcou o dia da compra ("compro dia 20"); ausente = falta de dinheiro (o de sempre). */
    retornoPedido: z.object({ kit: z.string().nullable(), condicao: z.string().nullable(), motivo: z.enum(["compra"]).optional() }).nullable().default(null),
    /** Lastro do envio já concluído: o pós-envio não avisa duas vezes. */
    retornoEnviadoId: z.string().nullable().default(null),
    /** Oferta de entrada ("método"): onde a lead está no funil do produto de menor valor. */
    metodo: z
      .object({
        etapa: z.enum(["nenhuma", "ofertado", "escolhendo", "aguardando_pix", "pago"]).default("nenhuma"),
        /** A oferta já saiu (uma vez por lead). */
        oferecido: z.boolean().default(false),
        /** Valor só da oferta de entrada ou com o complemento (bump); null até ela escolher. */
        valorCents: z.number().int().nullable().default(null),
        comCardapio: z.boolean().nullable().default(null),
        pagoEm: z.string().nullable().default(null),
      })
      .prefault({}),
    /** Marca VIP (quem pagou a oferta de entrada): % de desconto no kit; 0 = sem marca. */
    vipDescontoPct: z.number().int().min(0).default(0),
    fechamentoEnviado: z.boolean().default(false),
    /**
     * A explicação do produto (`explicacao`) já saiu? null = não se sabe (conversa gravada antes de
     * existir o campo): aí o interesse depois da tabela continua indo ao operador, para não repetir o áudio.
     */
    explicacaoEnviada: z.boolean().nullable().default(null),
    clienteRespondido: z.boolean().default(false),
    /** A opção de queixa que a lead escolheu e já recebeu resposta (id de `queixas`); null = nenhuma. Uma por conversa. */
    queixa: z.string().nullable().default(null),
    saudacaoRespondida: z.boolean().default(false),
    /** Pontos de parada de COMPRA que já avisaram o celular do operador (idempotência: o mesmo pedido não avisa duas vezes). */
    avisadosCompra: z.array(z.string()).default([]),
    // Prospecção.
    estadoProspeccao: z.enum(ESTADOS_PROSPECCAO).default("livre"),
    recusou: z.boolean().default(false),
    diagnosticoEnviadoEm: z.string().nullable().default(null),
  })
  .prefault({});
export type DadosConversa = z.infer<typeof dadosSchema>;

export function lerDados(bruto: unknown): DadosConversa {
  const r = dadosSchema.safeParse(bruto ?? {});
  return r.success ? r.data : dadosSchema.parse({});
}

export type EstadoConversa = {
  etapa: EtapaAtendimento;
  quente: boolean;
  precisaOperador: boolean;
  motivoOperador: string | null;
  /** Respostas automáticas seguidas sem o operador no meio (uma por decisão, não por parte). */
  autoSeguidas: number;
  dados: DadosConversa;
};

export const conversaNova = (): EstadoConversa => ({
  etapa: "respondeu",
  quente: false,
  precisaOperador: false,
  motivoOperador: null,
  autoSeguidas: 0,
  dados: lerDados({}),
});

/** O lead visto pelo atendimento (só o que a decisão usa). */
export type LeadDoAtendimento = {
  id: string;
  nome: string | null;
  telefone: string | null;
  campos: Record<string, unknown>;
};

export type NivelDoAviso = "compra" | "operador" | "info";

export type Acao =
  /** Partes JÁ montadas (slots preenchidos e conferidas), na ordem; `aposSeg` é a espera desde a anterior. */
  | { tipo: "responder"; resposta: string; partes: (Parte & { aposSeg: number })[] }
  | { tipo: "avisar"; nivel: NivelDoAviso; titulo: string; corpo: string }
  | { tipo: "encerrar"; etapa: "nao_contatar" | "perdido"; motivo: string; irritada: boolean };

/**
 * `eventos`: o que a decisão atingiu (vocabulário `EVENTOS_DE_PARADA`). Quem
 * decide se algum vira PONTO DE PARADA é a configuração da organização
 * (`./parada.ts`); a decisão só diz o que aconteceu.
 */
export type Decisao = { acoes: Acao[]; estado: EstadoConversa; resumo: string; eventos?: string[]; retornoEm?: string };

export type LeituraFinal = Leitura & { discordou?: boolean };
