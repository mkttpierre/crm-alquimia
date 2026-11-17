/**
 * Faturamento: agregações puras sobre as linhas que a rota busca (com a org da sessão, nunca do corpo).
 *
 * O que entra e a régua de "receita" está em `receita.ts` (negócio ganho + pedido pago). Dia, semana e mês são do FUSO
 * da organização (`organizations.timezone`): uma venda às 22h em São Paulo é do dia dela, não do dia seguinte em UTC.
 * Semana começa na segunda-feira. Dinheiro em centavos inteiros e uma moeda por consulta.
 */
import { z } from "zod";

import { pedidoTemReceita } from "./receita";

export type Granularidade = "dia" | "semana" | "mes";

export interface ItemDeNegocioGanho {
  product_id: string | null;
  nome: string;
  quantidade: number;
  total_cents: number;
  currency: string;
}

export interface NegocioGanhoParaFaturar {
  lead_id: string;
  pipeline_id: string;
  closed_at: string;
  value_cents: number | null;
  currency: string | null;
  itens: ItemDeNegocioGanho[];
  /** Título do negócio (para a tabela de vendas). */
  titulo?: string | null;
  /** Quem atendeu: `owner_user_id` (pessoa) ou `owner_kind = "ai"` (agente de IA). Ambos ausentes = sem atendente. */
  owner_user_id?: string | null;
  owner_kind?: string | null;
}

export interface PedidoParaFaturar {
  id: string;
  ordered_at: string;
  total_cents: number;
  currency: string;
  status: string;
}

export const SEM_PRODUTO = "__sem_produto__";

/** Linhas da tabela de vendas do painel. Mais que isso o painel avisa em vez de despejar a lista toda. */
export const MAX_VENDAS_NA_LISTA = 200;

export interface AtendenteDoPeriodo {
  /** `usuario` = uma pessoa; `ia` = negócios que são do agente de IA; `sem_atendente` = sem dono. */
  tipo: "usuario" | "ia" | "sem_atendente";
  user_id: string | null;
  nome: string | null;
  vendas: number;
  total_cents: number;
}

export interface VendaDoPeriodo {
  tipo: "negocio" | "pedido";
  /** Id do negócio ou do pedido. */
  id: string;
  /** Só negócio tem lead para onde ir; pedido da loja não. */
  lead_id: string | null;
  pipeline_id: string | null;
  titulo: string | null;
  funil: string | null;
  /** Instante da venda (ISO). */
  data: string;
  valor_cents: number;
  /** "2× 3 MESES (BETA)": nome do produto, com a quantidade quando passa de uma. */
  produtos: string[];
  atendente_id: string | null;
  atendente_nome: string | null;
  /** `null` no pedido da loja (não tem atendente). */
  atendente_tipo: AtendenteDoPeriodo["tipo"] | null;
}

export interface Faturamento {
  currency: string;
  desde: string;
  ate: string;
  granularidade: Granularidade;
  total_cents: number;
  receita_negocios_cents: number;
  receita_pedidos_cents: number;
  numero_de_vendas: number;
  ticket_medio_cents: number | null;
  serie: Array<{ chave: string; total_cents: number; vendas: number }>;
  por_produto: Array<{ chave: string; nome: string | null; quantidade: number; total_cents: number }>;
  por_pipeline: Array<{ pipeline_id: string; nome: string | null; total_cents: number; vendas: number }>;
  por_atendente: AtendenteDoPeriodo[];
  /** As vendas do período, a mais recente primeiro, limitadas a `MAX_VENDAS_NA_LISTA`. */
  vendas: VendaDoPeriodo[];
  vendas_cortadas: boolean;
  /** `true` = a organização tem produto `so_interno` (valor de comissão): o total conta SÓ negócios ganhos. */
  somente_negocios: boolean;
  /** Pedidos pagos da loja no período, que NÃO entram no total quando `somente_negocios`. `null` no modo de sempre. */
  fora_do_total: { pedidos_cents: number; pedidos: number } | null;
  ignorados_outra_moeda: number;
}

// ── datas ────────────────────────────────────────────────────────────────────────────────────────────────────────
const DIA_MS = 86_400_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymdValido(s: string): boolean {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const somarDias = (ymd: string, dias: number): string => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + dias * DIA_MS).toISOString().slice(0, 10);

/** Dia civil (AAAA-MM-DD) de um instante no fuso. Fuso inválido cai no padrão do produto. */
export function diaCivil(instante: string | Date, timezone: string): string {
  const d = typeof instante === "string" ? new Date(instante) : instante;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
}

function chaveDoDia(ymd: string, g: Granularidade): string {
  if (g === "dia") return ymd;
  if (g === "mes") return ymd.slice(0, 7);
  const diaDaSemana = new Date(`${ymd}T00:00:00.000Z`).getUTCDay(); // 0 = domingo
  return somarDias(ymd, -((diaDaSemana + 6) % 7));
}

export function chaveDoPeriodo(instante: string, g: Granularidade, timezone: string): string {
  return chaveDoDia(diaCivil(instante, timezone), g);
}

/** Janela UTC (fim exclusivo) que cobre qualquer fuso: um dia antes e dois depois. A filtragem fina é feita aqui no TS. */
export function janelaDeBusca(desde: string, ate: string): { de: string; ate: string } {
  return { de: `${somarDias(desde, -1)}T00:00:00.000Z`, ate: `${somarDias(ate, 3)}T00:00:00.000Z` };
}

export function periodoPadrao(hoje: string): { desde: string; ate: string } {
  return { desde: somarDias(hoje, -29), ate: hoje };
}

/** O período de MESMO tamanho que termina na véspera de `desde` — contra ele os cartões do painel se comparam. */
export function periodoAnterior(desde: string, ate: string): { desde: string; ate: string } {
  const dias = Math.round((new Date(`${ate}T00:00:00.000Z`).getTime() - new Date(`${desde}T00:00:00.000Z`).getTime()) / DIA_MS) + 1;
  const fim = somarDias(desde, -1);
  return { desde: somarDias(fim, -(dias - 1)), ate: fim };
}

/** Variação em %, uma casa decimal. Sem base (anterior zero) não há percentual: `null`, e a tela diz "sem comparação". */
export function variacaoPercentual(atual: number, anterior: number): number | null {
  if (anterior === 0) return null;
  return Math.round(((atual - anterior) / anterior) * 1000) / 10;
}

// ── entrada da rota ──────────────────────────────────────────────────────────────────────────────────────────────
const LIMITE_DIAS = 731;

export const consultaSchema = z
  .object({
    desde: z.string().refine(ymdValido, "use AAAA-MM-DD").optional(),
    ate: z.string().refine(ymdValido, "use AAAA-MM-DD").optional(),
    granularidade: z.enum(["dia", "semana", "mes"]).default("dia"),
    // Sem moeda na consulta, quem decide é a ORGANIZAÇÃO (rota); BRL fixo aqui mentiria para org em outra moeda.
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.desde && v.ate) {
      if (v.desde > v.ate) ctx.addIssue({ code: "custom", path: ["desde"], message: "A data inicial vem depois da final." });
      else if ((new Date(`${v.ate}T00:00:00.000Z`).getTime() - new Date(`${v.desde}T00:00:00.000Z`).getTime()) / DIA_MS > LIMITE_DIAS) {
        ctx.addIssue({ code: "custom", path: ["desde"], message: "O período passa de 2 anos." });
      }
    }
  });
export type ConsultaFaturamento = z.infer<typeof consultaSchema>;

// ── cálculo ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface EntradaFaturamento {
  negocios: NegocioGanhoParaFaturar[];
  pedidos: PedidoParaFaturar[];
  pipelines: Map<string, string>;
  moeda: string;
  timezone: string;
  desde: string;
  ate: string;
  granularidade: Granularidade;
  /** `owner_user_id` → nome (só o nome; nunca e-mail). Ausente: o painel mostra sem nome. */
  nomesDosAtendentes?: ReadonlyMap<string, string | null>;
  /**
   * A organização tem produto `so_interno`: o valor dos negócios é COMISSÃO, e somar pedido da loja (preço cheio) com
   * comissão daria um número que não é nem um nem outro. Então só negócios ganhos entram no total, nas vendas, no ticket,
   * na série e na lista; os pedidos pagos aparecem à parte, em `fora_do_total`. Sem produto interno: comportamento de sempre.
   */
  somenteNegocios?: boolean;
}

export function calcularFaturamento(e: EntradaFaturamento): Faturamento {
  const { moeda, timezone, desde, ate, granularidade } = e;
  let ignorados = 0;

  const serie = new Map<string, { chave: string; total_cents: number; vendas: number }>();
  for (let dia = desde; dia <= ate; dia = somarDias(dia, 1)) {
    const chave = chaveDoDia(dia, granularidade);
    if (!serie.has(chave)) serie.set(chave, { chave, total_cents: 0, vendas: 0 });
  }
  const noPeriodo = (dia: string) => dia >= desde && dia <= ate;
  const somarNaSerie = (instante: string, cents: number) => {
    const dia = diaCivil(instante, timezone);
    const bucket = serie.get(chaveDoDia(dia, granularidade));
    if (bucket) {
      bucket.total_cents += cents;
      bucket.vendas += 1;
    }
  };

  let receitaNegocios = 0;
  let receitaPedidos = 0;
  let foraDoTotalCents = 0;
  let foraDoTotalPedidos = 0;
  let numeroDeVendas = 0;
  const produtos = new Map<string, { chave: string; nome: string | null; quantidade: number; total_cents: number }>();
  const pipelines = new Map<string, { pipeline_id: string; nome: string | null; total_cents: number; vendas: number }>();
  const atendentes = new Map<string, AtendenteDoPeriodo>();
  const vendas: VendaDoPeriodo[] = [];
  const somarProduto = (chave: string, nome: string | null, quantidade: number, cents: number) => {
    const atual = produtos.get(chave) ?? { chave, nome, quantidade: 0, total_cents: 0 };
    atual.quantidade += quantidade;
    atual.total_cents += cents;
    produtos.set(chave, atual);
  };

  for (const n of e.negocios) {
    if (!noPeriodo(diaCivil(n.closed_at, timezone))) continue;
    if ((n.currency ?? moeda) !== moeda) {
      ignorados += 1;
      continue;
    }
    const valor = n.value_cents ?? 0;
    receitaNegocios += valor;
    numeroDeVendas += 1;
    somarNaSerie(n.closed_at, valor);

    const p = pipelines.get(n.pipeline_id) ?? { pipeline_id: n.pipeline_id, nome: e.pipelines.get(n.pipeline_id) ?? null, total_cents: 0, vendas: 0 };
    p.total_cents += valor;
    p.vendas += 1;
    pipelines.set(n.pipeline_id, p);

    const dono = n.owner_user_id ?? null;
    const tipoDoAtendente = dono ? "usuario" : n.owner_kind === "ai" ? "ia" : "sem_atendente";
    const chaveDoAtendente = dono ? `u:${dono}` : tipoDoAtendente;
    const nomeDoDono = dono ? (e.nomesDosAtendentes?.get(dono) ?? null) : null;
    const at: AtendenteDoPeriodo = atendentes.get(chaveDoAtendente) ?? { tipo: tipoDoAtendente, user_id: dono, nome: nomeDoDono, vendas: 0, total_cents: 0 };
    at.vendas += 1;
    at.total_cents += valor;
    atendentes.set(chaveDoAtendente, at);
    vendas.push({
      tipo: "negocio",
      id: n.lead_id,
      lead_id: n.lead_id,
      pipeline_id: n.pipeline_id,
      titulo: n.titulo ?? null,
      funil: e.pipelines.get(n.pipeline_id) ?? null,
      data: n.closed_at,
      valor_cents: valor,
      produtos: n.itens.filter((i) => i.currency === moeda).map((i) => (i.quantidade > 1 ? `${i.quantidade}× ${i.nome}` : i.nome)),
      atendente_id: dono,
      atendente_nome: nomeDoDono,
      atendente_tipo: tipoDoAtendente,
    });

    // Produto: só os itens na moeda; o que o valor do negócio tem a mais que os itens vira "sem produto", para a soma por
    // produto fechar com a receita de negócios (se não fechar, a diferença está à vista, não escondida).
    let explicado = 0;
    for (const i of n.itens) {
      if (i.currency !== moeda) continue;
      explicado += i.total_cents;
      somarProduto(i.product_id ?? `avulso:${i.nome.trim().toLowerCase()}`, i.nome, i.quantidade, i.total_cents);
    }
    if (valor > explicado) somarProduto(SEM_PRODUTO, null, 0, valor - explicado);
  }

  for (const p of e.pedidos) {
    if (!pedidoTemReceita(p.status)) continue;
    if (!noPeriodo(diaCivil(p.ordered_at, timezone))) continue;
    if (p.currency !== moeda) {
      ignorados += 1;
      continue;
    }
    if (e.somenteNegocios) {
      foraDoTotalCents += p.total_cents;
      foraDoTotalPedidos += 1;
      continue;
    }
    receitaPedidos += p.total_cents;
    numeroDeVendas += 1;
    somarNaSerie(p.ordered_at, p.total_cents);
    vendas.push({ tipo: "pedido", id: p.id, lead_id: null, pipeline_id: null, titulo: null, funil: null, data: p.ordered_at, valor_cents: p.total_cents, produtos: [], atendente_id: null, atendente_nome: null, atendente_tipo: null });
  }

  const total = receitaNegocios + receitaPedidos;
  return {
    currency: moeda,
    desde,
    ate,
    granularidade,
    total_cents: total,
    receita_negocios_cents: receitaNegocios,
    receita_pedidos_cents: receitaPedidos,
    numero_de_vendas: numeroDeVendas,
    ticket_medio_cents: numeroDeVendas > 0 ? Math.round(total / numeroDeVendas) : null,
    serie: [...serie.values()].sort((a, b) => a.chave.localeCompare(b.chave)),
    por_produto: [...produtos.values()].sort((a, b) => b.total_cents - a.total_cents),
    por_pipeline: [...pipelines.values()].sort((a, b) => b.total_cents - a.total_cents),
    por_atendente: [...atendentes.values()].sort((a, b) => b.vendas - a.vendas || b.total_cents - a.total_cents),
    vendas: vendas
      .sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime() || a.id.localeCompare(b.id))
      .slice(0, MAX_VENDAS_NA_LISTA),
    vendas_cortadas: vendas.length > MAX_VENDAS_NA_LISTA,
    somente_negocios: e.somenteNegocios === true,
    fora_do_total: e.somenteNegocios ? { pedidos_cents: foraDoTotalCents, pedidos: foraDoTotalPedidos } : null,
    ignorados_outra_moeda: ignorados,
  };
}

export interface PainelDeFaturamento extends Faturamento {
  /** O período anterior de mesmo tamanho, resumido: é o que os cartões comparam. */
  anterior: { desde: string; ate: string; total_cents: number; numero_de_vendas: number; ticket_medio_cents: number | null };
}

/** O faturamento do período + o resumo do período anterior de mesmo tamanho. As linhas devem cobrir os DOIS períodos. */
export function calcularPainel(e: EntradaFaturamento): PainelDeFaturamento {
  const atual = calcularFaturamento(e);
  const ant = periodoAnterior(e.desde, e.ate);
  const antes = calcularFaturamento({ ...e, ...ant });
  return {
    ...atual,
    anterior: { ...ant, total_cents: antes.total_cents, numero_de_vendas: antes.numero_de_vendas, ticket_medio_cents: antes.ticket_medio_cents },
  };
}
