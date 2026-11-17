/**
 * O painel "Vendas e faturamento" do Início: agregações PURAS.
 *
 * A conta de dinheiro NÃO é reescrita aqui: faturamento, número de vendas, ticket médio, série por dia e produtos vêm de
 * `calcularFaturamento` (a mesma da tela Faturamento e da API `/api/v1/revenue`), chamada para o período e para o anterior de
 * mesmo tamanho. A regra de produto interno também é a de lá: com `somenteNegocios` (a organização tem produto `so_interno`)
 * o pedido pago da loja, que está a preço cheio, fica FORA do total, das vendas, do ticket, da série e dos produtos — e o
 * painel nem carrega o valor dele (não existe campo para isso no resultado). O painel não lê preço de catálogo nenhum.
 *
 * O que é novo aqui, e só olha negócios ganhos: origem (pelas tags de origem da organização), conversão lead → venda,
 * tempo médio até a venda, recompra e o progresso da meta do mês.
 */
import { normalizarOrigem, type RegrasDeOrigem } from "@/lib/leads/tag-de-origem";

import {
  SEM_PRODUTO,
  calcularFaturamento,
  diaCivil,
  variacaoPercentual,
  type EntradaFaturamento,
  type Faturamento,
  type NegocioGanhoParaFaturar,
} from "./faturamento";
import { calcularProgressoDaMeta, type ProgressoDaMeta } from "./meta-mensal";
import { primeiroDiaDoMes } from "./periodos-do-painel";

/** Quantos produtos aparecem no ranking. */
export const MAX_PRODUTOS_NO_PAINEL = 8;
/** Quantas origens aparecem; o resto vira "outras". */
export const MAX_ORIGENS_NO_PAINEL = 8;

/** Um número do período, com o do período anterior e a variação. `variacao` é `null` sem base (anterior zero). */
export interface NumeroComparado {
  atual: number;
  anterior: number;
  variacao: number | null;
}

/** O mesmo, quando o número pode não existir (ticket sem venda, taxa sem lead). `variacao` em % relativa. */
export interface NumeroOpcional {
  atual: number | null;
  anterior: number | null;
  variacao: number | null;
}

export interface PontoDaSerie {
  /** AAAA-MM-DD do dia no período atual. */
  dia: string;
  total_cents: number;
  /** O dia de MESMA posição no período de comparação (1º dia com 1º dia). `null` quando o outro período é mais curto. */
  anterior_cents: number | null;
  vendas: number;
}

export interface ProdutoDoPainel {
  chave: string;
  nome: string | null;
  quantidade: number;
  total_cents: number;
}

export interface OrigemDoPainel {
  tag: string;
  vendas: number;
  total_cents: number;
}

export interface ContagemDeLeads {
  /** Leads criados no período. */
  criados: number;
  /** Desses, os que hoje estão ganhos. */
  ganhos: number;
}

/** Uma venda ganha de quem já tem cadastro, para contar recompra. */
export interface CompraDoContato {
  contact_id: string;
  lead_id: string;
  closed_at: string;
}

export interface EntradaDoPainelDeVendas extends Omit<EntradaFaturamento, "granularidade" | "nomesDosAtendentes"> {
  /** O período de comparação (ver `periodoDeComparacao`): quem chama decide; o painel não assume "mesmo tamanho". */
  anterior: { desde: string; ate: string };
  /** Hoje, no fuso da organização (AAAA-MM-DD): o mês da meta é o dele. */
  hoje: string;
  /** `organizations.settings` já lido; as tags de origem são as VALORES de `por_fonte`. */
  regrasDeOrigem: RegrasDeOrigem;
  leads: { atual: ContagemDeLeads; anterior: ContagemDeLeads };
  /** Todas as vendas ganhas (até o fim do período) dos contatos que compraram em algum dos dois períodos. */
  comprasDosContatos: CompraDoContato[];
  metaCents: number | null;
}

export interface PainelDeVendas {
  moeda: string;
  desde: string;
  ate: string;
  anterior: { desde: string; ate: string };
  faturamento: NumeroComparado;
  vendas: NumeroComparado;
  ticket_medio: NumeroOpcional;
  serie: PontoDaSerie[];
  produtos: ProdutoDoPainel[];
  /** Valor das vendas cujo negócio não detalha produto (o que sobra do valor sobre os itens). */
  sem_produto_cents: number;
  origem: {
    /** A organização cadastrou regras de origem (`settings.origem.por_fonte`). Sem elas não há o que agrupar. */
    configurada: boolean;
    linhas: OrigemDoPainel[];
    sem_origem: { vendas: number; total_cents: number };
  };
  conversao: { leads: number; ganhos: number; taxa: NumeroOpcional };
  tempo_ate_a_venda_ms: NumeroOpcional;
  recompra: { clientes: number; recompradores: number; taxa: NumeroOpcional };
  /** Progresso da meta do MÊS CORRENTE (não do período escolhido); `null` sem meta. */
  meta: ProgressoDaMeta | null;
  /** O faturamento do mês corrente, da mesma conta (base da meta). */
  mes_corrente_cents: number;
  /** A organização tem produto interno: pedidos da loja ficam fora do total (o painel só avisa; não mostra o valor). */
  somente_negocios: boolean;
  ignorados_outra_moeda: number;
}

function comparar(atual: number, anterior: number): NumeroComparado {
  return { atual, anterior, variacao: variacaoPercentual(atual, anterior) };
}

function compararOpcional(atual: number | null, anterior: number | null): NumeroOpcional {
  return { atual, anterior, variacao: atual !== null && anterior !== null ? variacaoPercentual(atual, anterior) : null };
}

/** O negócio conta no período? Mesma régua de `calcularFaturamento`: dia civil no fuso, na moeda da consulta. */
function negociosDoPeriodo(e: EntradaDoPainelDeVendas, desde: string, ate: string): NegocioGanhoParaFaturar[] {
  return e.negocios.filter((n) => {
    const dia = diaCivil(n.closed_at, e.timezone);
    return dia >= desde && dia <= ate && (n.currency ?? e.moeda) === e.moeda;
  });
}

/** As tags de origem que a organização reconhece: os valores de `por_fonte`, em maiúsculas, sem repetir. */
export function tagsDeOrigemDaOrganizacao(regras: RegrasDeOrigem): string[] {
  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const valor of Object.values(regras.por_fonte ?? {})) {
    const tag = valor.trim().toUpperCase();
    const chave = normalizarOrigem(tag);
    if (!chave || vistas.has(chave)) continue;
    vistas.add(chave);
    saida.push(tag);
  }
  return saida;
}

function agruparPorOrigem(negocios: NegocioGanhoParaFaturar[], regras: RegrasDeOrigem): PainelDeVendas["origem"] {
  const tags = tagsDeOrigemDaOrganizacao(regras);
  const grupos = new Map<string, OrigemDoPainel>();
  const sem = { vendas: 0, total_cents: 0 };

  for (const n of negocios) {
    const valor = n.value_cents ?? 0;
    const doNegocio = new Set((n.tags ?? []).map((t) => normalizarOrigem(t)));
    // Mais de uma tag de origem no mesmo negócio: vale a primeira na ordem das regras, para a venda contar uma vez só.
    const achada = tags.find((t) => doNegocio.has(normalizarOrigem(t)));
    if (!achada) {
      sem.vendas += 1;
      sem.total_cents += valor;
      continue;
    }
    const g = grupos.get(achada) ?? { tag: achada, vendas: 0, total_cents: 0 };
    g.vendas += 1;
    g.total_cents += valor;
    grupos.set(achada, g);
  }

  const ordenadas = [...grupos.values()].sort((a, b) => b.total_cents - a.total_cents || b.vendas - a.vendas || a.tag.localeCompare(b.tag));
  const linhas = ordenadas.slice(0, MAX_ORIGENS_NO_PAINEL);
  // O que passa do limite não some: vira a linha "OUTRAS", para a soma das linhas continuar fechando com o total.
  const resto = ordenadas.slice(MAX_ORIGENS_NO_PAINEL);
  if (resto.length > 0) {
    linhas.push({ tag: "OUTRAS", vendas: resto.reduce((s, g) => s + g.vendas, 0), total_cents: resto.reduce((s, g) => s + g.total_cents, 0) });
  }
  return { configurada: tags.length > 0, linhas, sem_origem: sem };
}

/** Média, em ms, entre o nascimento do lead e a venda. Negócio sem `created_at` (ou com data impossível) fica de fora. */
export function tempoMedioAteAVenda(negocios: ReadonlyArray<Pick<NegocioGanhoParaFaturar, "created_at" | "closed_at">>): number | null {
  const duracoes: number[] = [];
  for (const n of negocios) {
    if (!n.created_at) continue;
    const ms = new Date(n.closed_at).getTime() - new Date(n.created_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) duracoes.push(ms);
  }
  if (duracoes.length === 0) return null;
  return Math.round(duracoes.reduce((s, d) => s + d, 0) / duracoes.length);
}

/**
 * Recompra: dos clientes (contatos distintos) que compraram no período, quantos têm DUAS ou mais compras ganhas até o fim
 * dele — a de agora e uma anterior, ou duas dentro do próprio período. Negócio sem contato não entra na conta.
 */
export function calcularRecompra(
  doPeriodo: ReadonlyArray<Pick<NegocioGanhoParaFaturar, "contact_id">>,
  compras: ReadonlyArray<CompraDoContato>,
  fimDoPeriodo: string,
  timezone: string,
): { clientes: number; recompradores: number; taxa: number | null } {
  const clientes = new Set<string>();
  for (const n of doPeriodo) if (n.contact_id) clientes.add(n.contact_id);

  const porContato = new Map<string, Set<string>>();
  for (const c of compras) {
    if (!clientes.has(c.contact_id)) continue;
    if (diaCivil(c.closed_at, timezone) > fimDoPeriodo) continue;
    const ids = porContato.get(c.contact_id) ?? new Set<string>();
    ids.add(c.lead_id);
    porContato.set(c.contact_id, ids);
  }
  let recompradores = 0;
  for (const ids of porContato.values()) if (ids.size >= 2) recompradores += 1;
  return { clientes: clientes.size, recompradores, taxa: clientes.size > 0 ? recompradores / clientes.size : null };
}

const taxaDe = (c: ContagemDeLeads): number | null => (c.criados > 0 ? c.ganhos / c.criados : null);

export function calcularPainelDeVendas(e: EntradaDoPainelDeVendas): PainelDeVendas {
  const base = { ...e, granularidade: "dia" as const };
  const atual: Faturamento = calcularFaturamento(base);
  const ant = e.anterior;
  const antes: Faturamento = calcularFaturamento({ ...base, ...ant });

  // O dia 1 do período com o dia 1 do anterior, e assim por diante. O anterior pode ser mais curto (mês de 30 dias contra 31).
  const serie: PontoDaSerie[] = atual.serie.map((p, i) => ({
    dia: p.chave,
    total_cents: p.total_cents,
    vendas: p.vendas,
    anterior_cents: antes.serie[i]?.total_cents ?? null,
  }));

  const produtos = atual.por_produto
    .filter((p) => p.chave !== SEM_PRODUTO)
    .sort((a, b) => b.quantidade - a.quantidade || b.total_cents - a.total_cents || (a.nome ?? "").localeCompare(b.nome ?? ""))
    .slice(0, MAX_PRODUTOS_NO_PAINEL)
    .map((p) => ({ chave: p.chave, nome: p.nome, quantidade: p.quantidade, total_cents: p.total_cents }));
  const semProduto = atual.por_produto.find((p) => p.chave === SEM_PRODUTO)?.total_cents ?? 0;

  const negociosAtual = negociosDoPeriodo(e, e.desde, e.ate);
  const negociosAnterior = negociosDoPeriodo(e, ant.desde, ant.ate);

  const recompraAtual = calcularRecompra(negociosAtual, e.comprasDosContatos, e.ate, e.timezone);
  const recompraAnterior = calcularRecompra(negociosAnterior, e.comprasDosContatos, ant.ate, e.timezone);

  // A meta é do MÊS CORRENTE, seja qual for o período escolhido: a mesma conta, só que do dia 1 até hoje.
  const mes = calcularFaturamento({ ...base, desde: primeiroDiaDoMes(e.hoje), ate: e.hoje, granularidade: "mes" });

  return {
    moeda: e.moeda,
    desde: e.desde,
    ate: e.ate,
    anterior: ant,
    faturamento: comparar(atual.total_cents, antes.total_cents),
    vendas: comparar(atual.numero_de_vendas, antes.numero_de_vendas),
    ticket_medio: compararOpcional(atual.ticket_medio_cents, antes.ticket_medio_cents),
    serie,
    produtos,
    sem_produto_cents: semProduto,
    origem: agruparPorOrigem(negociosAtual, e.regrasDeOrigem),
    conversao: {
      leads: e.leads.atual.criados,
      ganhos: e.leads.atual.ganhos,
      taxa: compararOpcional(taxaDe(e.leads.atual), taxaDe(e.leads.anterior)),
    },
    tempo_ate_a_venda_ms: compararOpcional(tempoMedioAteAVenda(negociosAtual), tempoMedioAteAVenda(negociosAnterior)),
    recompra: {
      clientes: recompraAtual.clientes,
      recompradores: recompraAtual.recompradores,
      taxa: compararOpcional(recompraAtual.taxa, recompraAnterior.taxa),
    },
    meta: calcularProgressoDaMeta({ metaCents: e.metaCents, realizadoCents: mes.total_cents, hoje: e.hoje }),
    mes_corrente_cents: mes.total_cents,
    somente_negocios: atual.somente_negocios,
    ignorados_outra_moeda: atual.ignorados_outra_moeda,
  };
}
