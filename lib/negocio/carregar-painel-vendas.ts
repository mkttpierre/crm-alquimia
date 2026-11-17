/**
 * Carrega o painel "Vendas e faturamento" do Início: busca as linhas (com a organização da SESSÃO, nunca do corpo) e entrega
 * para `calcularPainelDeVendas`. É a MESMA fonte da tela Faturamento (`repositorioFaturamentoSupabase`), com as leituras a
 * mais de `repositorio-painel-vendas.ts`.
 *
 * A janela de busca cobre o período, o anterior E o mês corrente (a meta é do mês de hoje, seja qual for o período).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { carregarRegrasDeOrigem } from "@/lib/leads/regras-de-origem";
import type { RegrasDeOrigem } from "@/lib/leads/tag-de-origem";

import { diaCivil, janelaDeBusca, somarDias } from "./faturamento";
import { calcularPainelDeVendas, type PainelDeVendas } from "./painel-vendas";
import { limitesDoPeriodo, periodoDeComparacao, primeiroDiaDoMes, resolverPeriodo, type ChaveDePeriodo, type PeriodoDoPainel } from "./periodos-do-painel";
import { repositorioFaturamentoSupabase, type RepositorioFaturamento } from "./repositorio-faturamento";
import { repositorioPainelDeVendasSupabase, type RepositorioDoPainelDeVendas } from "./repositorio-painel-vendas";

const FUSO_PADRAO = "America/Sao_Paulo";

export interface DependenciasDoPainel {
  faturamento: RepositorioFaturamento;
  painel: RepositorioDoPainelDeVendas;
  regrasDeOrigem: () => Promise<RegrasDeOrigem>;
  moeda: string;
  agora: Date;
}

export interface PainelCarregado {
  painel: PainelDeVendas;
  periodo: PeriodoDoPainel;
  /** Hoje, no fuso da organização (AAAA-MM-DD): o gasto de anúncios não inclui este dia. */
  hoje: string;
  timezone: string;
  /** Alguma leitura bateu no teto: o número pode estar incompleto, e a tela avisa. */
  truncado: boolean;
}

export async function carregarPainelDeVendas(deps: DependenciasDoPainel, org: string, chave: ChaveDePeriodo): Promise<PainelCarregado> {
  const timezone = (await deps.faturamento.fuso(org)) ?? FUSO_PADRAO;
  const hoje = diaCivil(deps.agora, timezone);
  const periodo = resolverPeriodo(chave, hoje);
  const anterior = periodoDeComparacao(periodo);

  const inicioDaJanela = [anterior.desde, primeiroDiaDoMes(hoje)].sort()[0]!;
  const fimDaJanela = [periodo.ate, hoje].sort().at(-1)!;
  const dados = await deps.faturamento.carregar(org, janelaDeBusca(inicioDaJanela, fimDaJanela));

  // Quem comprou nos dois períodos: é o universo da recompra.
  const contatos = [
    ...new Set(
      dados.negocios
        .filter((n) => {
          const dia = diaCivil(n.closed_at, timezone);
          return dia >= anterior.desde && dia <= periodo.ate;
        })
        .flatMap((n) => (n.contact_id ? [n.contact_id] : [])),
    ),
  ];

  const limitesAtual = limitesDoPeriodo(periodo.desde, periodo.ate, timezone);
  const limitesAnterior = limitesDoPeriodo(anterior.desde, anterior.ate, timezone);
  const [regras, metaCents, leadsAtual, leadsAnterior, historico] = await Promise.all([
    deps.regrasDeOrigem(),
    deps.painel.metaMensal(org),
    deps.painel.contarLeads(org, limitesAtual),
    deps.painel.contarLeads(org, limitesAnterior),
    deps.painel.comprasDosContatos(org, contatos, `${somarDias(periodo.ate, 3)}T00:00:00.000Z`),
  ]);

  const painel = calcularPainelDeVendas({
    negocios: dados.negocios,
    pedidos: dados.pedidos,
    pipelines: dados.pipelines,
    moeda: deps.moeda,
    timezone,
    desde: periodo.desde,
    ate: periodo.ate,
    anterior,
    somenteNegocios: dados.temProdutoInterno,
    hoje,
    regrasDeOrigem: regras,
    leads: { atual: leadsAtual, anterior: leadsAnterior },
    comprasDosContatos: historico.compras,
    metaCents,
  });

  return { painel, periodo, hoje, timezone, truncado: dados.truncado || historico.truncado };
}

/** O mesmo, ligado ao cliente da sessão. */
export async function carregarPainelDeVendasDaSessao(db: SupabaseClient, org: string, chave: ChaveDePeriodo, agora: Date = new Date()): Promise<PainelCarregado> {
  return carregarPainelDeVendas(
    {
      faturamento: repositorioFaturamentoSupabase(db),
      painel: repositorioPainelDeVendasSupabase(db),
      regrasDeOrigem: () => carregarRegrasDeOrigem(db, org),
      moeda: await moedaDaOrganizacao(db, org),
      agora,
    },
    org,
    chave,
  );
}
