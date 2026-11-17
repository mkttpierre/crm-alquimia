/**
 * Meta Ads como fonte de gasto: usa o que já existe (credencial de leitura guardada em Configurações › Meta Ads e a leitura
 * de insights da tela Análise › Meta Ads). Nenhuma conexão nova, nenhuma chamada além das duas já usadas por aquela tela
 * (a lista de contas, para conferir a moeda, e os insights do período).
 *
 * O gasto é a soma do `spend` das campanhas da conta PADRÃO no período. As datas vão como o painel as tem (dia civil da
 * organização); a plataforma as lê no fuso da conta de anúncios, uma diferença de horas na borda do período.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";

import { lerCredencialDeLeitura } from "../credenciais-de-leitura";
import { lerInsights, listarContas, type LinhaDeInsightCrua } from "../meta/insights";
import type { FalhaDeLeitura, ResultadoDeLeitura } from "../types";
import type { FonteDeGasto, LeituraDeGasto } from "./fonte";

/**
 * Quanto tempo o gasto de um intervalo fica guardado: a cota da plataforma é baixa e cada clique de período a gastaria.
 *
 * É o MÍNIMO, não o teto: o `unstable_cache` do Next entrega o valor vencido e só o renova em segundo plano. Quem abre o
 * painel primeiro depois do vencimento ainda vê o valor velho (e se a renovação falhar, o velho continua). O que garante a
 * troca na hora quando a conexão muda é a chave, não a validade.
 */
export const VALIDADE_DO_GASTO_S = 15 * 60;
/** A lista de contas só serve para conferir a moeda e quase nunca muda. Mesma regra: mínimo, não teto. */
export const VALIDADE_DAS_CONTAS_S = 60 * 60;

/** Guarda o resultado de `ler` por `segundos` sob `chave`. O que `ler` LANÇA não é guardado (contrato do `unstable_cache`). */
export type Memorizar = <T>(chave: readonly string[], segundos: number, ler: () => Promise<T>) => Promise<T>;

/** O cache de verdade: o `unstable_cache` do Next. A chave carrega organização+conta+período+moeda; NUNCA o token. */
export const memorizarNoServidor: Memorizar = (chave, segundos, ler) => unstable_cache(ler, [...chave], { revalidate: segundos })();

export interface DependenciasDoGastoMeta {
  lerCredencial: typeof lerCredencialDeLeitura;
  listarContas: typeof listarContas;
  lerInsights: typeof lerInsights;
  memorizar: Memorizar;
}

const PADRAO: DependenciasDoGastoMeta = { lerCredencial: lerCredencialDeLeitura, listarContas, lerInsights, memorizar: memorizarNoServidor };

/** Falha de leitura levada como exceção só para atravessar o cache SEM ser guardada por ele. */
class FalhaNaLeitura extends Error {
  constructor(
    readonly falha: FalhaDeLeitura,
    readonly detalhe: string,
  ) {
    super(detalhe);
  }
}

/**
 * Lê pela plataforma passando pelo cache: sucesso fica guardado; falha (cota, token, rede) vira exceção dentro do cache, que
 * não a guarda, e volta como `{ ok: false }` para quem chamou. Assim uma falha de 1 segundo não fica 15 minutos na tela.
 */
async function lerComCache<T>(deps: DependenciasDoGastoMeta, chave: readonly string[], segundos: number, ler: () => Promise<ResultadoDeLeitura<T>>): Promise<ResultadoDeLeitura<T>> {
  try {
    const dados = await deps.memorizar(chave, segundos, async () => {
      const r = await ler();
      if (!r.ok) throw new FalhaNaLeitura(r.falha, r.detalhe);
      return r.dados;
    });
    return { ok: true, dados };
  } catch (erro) {
    if (erro instanceof FalhaNaLeitura) return { ok: false, falha: erro.falha, detalhe: erro.detalhe };
    return { ok: false, falha: "transitorio", detalhe: "cache indisponível" };
  }
}

/**
 * Impressão do token para a chave do cache: muda quando o token muda, e não deixa o token sair dele (sha256, 16 hex).
 * Nunca ponha o token em claro numa chave de cache.
 */
export function impressaoDoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** "123.45" → 12345. Texto que não é número vale zero (campanha sem veiculação volta sem `spend`). */
export function gastoEmCentavos(spend: string | undefined): number {
  const n = Number(spend);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

export function somarGasto(linhas: ReadonlyArray<Pick<LinhaDeInsightCrua, "spend">>): number {
  return linhas.reduce((s, l) => s + gastoEmCentavos(l.spend), 0);
}

/** O `admin` é o cliente de serviço: a tabela de conexões tem RLS sem policies e só ele a enxerga. */
export function criarFonteMetaAds(admin: SupabaseClient, deps: DependenciasDoGastoMeta = PADRAO): FonteDeGasto {
  return {
    plataforma: "meta_ads",
    async lerGasto(pedido): Promise<LeituraDeGasto> {
      const credencial = await deps.lerCredencial(admin, pedido.organizationId, "meta_ads");
      if (!credencial.ok) {
        return credencial.motivo === "sem_conexao"
          ? { estado: "nao_conectada", plataforma: "meta_ads" }
          : { estado: "indisponivel", plataforma: "meta_ads", motivo: "cifra_indisponivel" };
      }

      const { accessToken, contaPadrao } = credencial.credencial;
      if (!contaPadrao) return { estado: "sem_conta", plataforma: "meta_ads" };
      const conta = contaPadrao.startsWith("act_") ? contaPadrao : `act_${contaPadrao}`;

      // Só o dia de hoje (ou nada): a plataforma ainda não fechou, não há o que ler e não se gasta cota.
      if (pedido.ate < pedido.de) return { estado: "dia_incompleto", plataforma: "meta_ads" };

      // A lista de contas depende de QUEM lê (o token) e de qual conta se confere (a padrão): reconectar com outro token, ou
      // trocar a conta padrão, muda a chave e dispensa a lista velha, que daria "permissão insuficiente" ou "moeda diferente" falsos.
      const chaveDasContas = ["gasto-meta", "contas", pedido.organizationId, conta, impressaoDoToken(accessToken)];
      const [contas, insights] = await Promise.all([
        lerComCache(deps, chaveDasContas, VALIDADE_DAS_CONTAS_S, () => deps.listarContas(accessToken)),
        lerComCache(deps, ["gasto-meta", "insights", pedido.organizationId, conta, pedido.de, pedido.ate, pedido.moeda], VALIDADE_DO_GASTO_S, () =>
          deps.lerInsights(accessToken, conta, pedido.de, pedido.ate),
        ),
      ]);
      if (!contas.ok) return { estado: "indisponivel", plataforma: "meta_ads", motivo: contas.falha };
      const daConta = contas.dados.find((c) => c.id === conta);
      // O token não alcança a conta padrão: é o caso de permissão, e a tela de Meta Ads já explica como resolver.
      if (!daConta) return { estado: "indisponivel", plataforma: "meta_ads", motivo: "permissao_insuficiente" };
      if (daConta.moeda !== pedido.moeda) return { estado: "moeda_diferente", plataforma: "meta_ads", moeda_da_conta: daConta.moeda };
      if (!insights.ok) return { estado: "indisponivel", plataforma: "meta_ads", motivo: insights.falha };

      return { estado: "conectada", plataforma: "meta_ads", gasto_cents: somarGasto(insights.dados), moeda: daConta.moeda };
    },
  };
}
