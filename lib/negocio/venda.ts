/**
 * Registrar venda: o contrato do corpo e as contas puras (sem banco). A operação em si é `fn_registrar_venda` (migration
 * 0251), chamada por `registrar-venda.ts`. A tela e a rota importam daqui: um schema só, para o formulário não oferecer
 * um campo que a rota descarta.
 *
 * Dinheiro em centavos inteiros. A organização NUNCA vem do corpo (a rota usa a da sessão) e a moeda é a do negócio.
 */
import { z } from "zod";

import { diaCivil } from "./faturamento";

const CENTS_MAX = 100_000_000_00; // mesmo teto do item do negócio (schema-item.ts)
const MAX_LINHAS = 50;
const centavos = z.number().int().min(0).max(CENTS_MAX);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymdValido(s: string): boolean {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const linhaDeVendaSchema = z
  .object({
    /** Produto do catálogo (nome e sku vêm dele). Sem produto, a linha é avulsa e `nome` é obrigatório. */
    product_id: z.string().uuid().optional(),
    nome: z.string().trim().min(1).max(200).optional(),
    sku: z.string().trim().min(1).max(80).nullable().optional(),
    quantidade: z.number().int().min(1).max(100_000).default(1),
    /** O valor da linha: vem preenchido do cadastro do produto e é editável POR LINHA. O que vale é este. */
    preco_unit_cents: centavos,
    desconto_cents: centavos.default(0),
  })
  .superRefine((v, ctx) => {
    if (!v.product_id && !v.nome) {
      ctx.addIssue({ code: "custom", path: ["nome"], message: "Escolha um produto ou dê um nome ao item avulso." });
    }
    if (v.desconto_cents > v.quantidade * v.preco_unit_cents) {
      ctx.addIssue({ code: "custom", path: ["desconto_cents"], message: "O desconto passa do valor da linha." });
    }
  });
export type LinhaDeVenda = z.infer<typeof linhaDeVendaSchema>;

export const vendaCriarSchema = z
  .object({
    /** Contato que comprou. Obrigatório, a não ser que venha o negócio do dossiê (que já aponta o contato). */
    contact_id: z.string().uuid().optional(),
    /** Negócio de onde o botão foi clicado (dossiê). Se estiver aberto, é ele que ganha; senão a venda abre um novo. */
    lead_id: z.string().uuid().optional(),
    /**
     * O negócio que o quadro MOSTROU ao operador: o id dele, ou "novo" (a venda abriria um negócio novo). A função do banco
     * recusa (`venda:alvo_mudou`) se, na hora de confirmar, o alvo real for outro (por exemplo, outro operador encerrou o
     * negócio mostrado): sem isso a venda cairia em outro negócio ou abriria um novo em silêncio. Ausente = sem conferência
     * (clientes de API que não mostram prévia).
     */
    negocio_previsto: z.union([z.literal("novo"), z.string().uuid()]).optional(),
    /** Dia da venda (AAAA-MM-DD, no fuso da organização). Padrão: hoje. Passado vale; futuro é recusado. */
    data_venda: z.string().refine(ymdValido, "Use AAAA-MM-DD.").optional(),
    itens: z.array(linhaDeVendaSchema).min(1, "Adicione ao menos um produto.").max(MAX_LINHAS),
  })
  .superRefine((v, ctx) => {
    if (!v.contact_id && !v.lead_id) {
      ctx.addIssue({ code: "custom", path: ["contact_id"], message: "Informe o contato da venda." });
    }
  });
export type VendaCriarInput = z.infer<typeof vendaCriarSchema>;

/** quantidade × preço − desconto, somado. Mesma conta do banco (`total_cents` da linha, sem acréscimo). */
export function totalDaVenda(linhas: ReadonlyArray<{ quantidade: number; preco_unit_cents: number; desconto_cents: number }>): number {
  return linhas.reduce((soma, l) => soma + (l.quantidade * l.preco_unit_cents - l.desconto_cents), 0);
}

/** O que `fn_registrar_venda` lê de cada linha. Produto do catálogo: o nome e o sku são do catálogo, não do corpo. */
export function itensParaRpc(linhas: ReadonlyArray<LinhaDeVenda>) {
  return linhas.map((l) => ({
    product_id: l.product_id ?? null,
    nome: l.product_id ? null : (l.nome ?? null),
    sku: l.product_id ? null : (l.sku ?? null),
    quantidade: l.quantidade,
    preco_unit_cents: l.preco_unit_cents,
    desconto_cents: l.desconto_cents,
  }));
}

// ── a data da venda ──────────────────────────────────────────────────────────────────────────────────────────────

function fusoValido(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "America/Sao_Paulo";
  }
}

/** Quanto o relógio do fuso está adiantado em relação ao UTC naquele instante, em ms. */
function deslocamentoMs(timezone: string, instante: Date): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: fusoValido(timezone),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instante);
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  const comoUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

export type InstanteDaVenda =
  | { ok: true; instante: Date }
  | { ok: false; motivo: "data_futura" | "data_invalida" };

/**
 * Quando a venda "aconteceu", em instante UTC para gravar em `crm_leads.closed_at` (que é o que o Faturamento lê).
 *  · sem data, ou a data de HOJE no fuso da organização: agora;
 *  · data passada: o MEIO do dia no fuso da organização, para a venda contar nesse dia e não escorregar para o vizinho
 *    por diferença de fuso;
 *  · data futura: recusada. O "hoje" é o do fuso da organização, não o do UTC.
 */
export function instanteDaVenda(dataVenda: string | undefined, timezone: string, agora: Date): InstanteDaVenda {
  if (!dataVenda) return { ok: true, instante: agora };
  if (!ymdValido(dataVenda)) return { ok: false, motivo: "data_invalida" };
  const hoje = diaCivil(agora, timezone);
  if (dataVenda > hoje) return { ok: false, motivo: "data_futura" };
  if (dataVenda === hoje) return { ok: true, instante: agora };

  const [a, m, d] = dataVenda.split("-").map(Number) as [number, number, number];
  const meioDiaUtc = Date.UTC(a, m - 1, d, 12);
  let instante = new Date(meioDiaUtc - deslocamentoMs(timezone, new Date(meioDiaUtc)));
  // Borda de horário de verão: se o meio-dia calculado caiu em outro dia civil, o 12:00 UTC (dia certo em qualquer fuso
  // entre -12 e +11) é o plano B.
  if (diaCivil(instante, timezone) !== dataVenda) instante = new Date(meioDiaUtc);
  return { ok: true, instante };
}
