/**
 * A "fonte de gasto": o que o painel "Vendas e faturamento" do Início pergunta a uma plataforma de anúncios — quanto se gastou
 * num período. UMA interface para qualquer plataforma; cada uma (`meta.ts`, `google.ts`) responde no seu formato e o painel
 * não sabe qual é.
 *
 * Contrato:
 *  - `lerGasto` NUNCA lança: tudo vira um estado de `LeituraDeGasto`. Uma plataforma fora do ar não derruba o painel.
 *  - "não conectada" é um estado, não um erro: é o que o Google devolve até alguém construir a conexão dele.
 *  - Plataforma na moeda errada não é somada (R$ + US$ daria um número que não é de ninguém).
 *  - Só leitura, com a credencial que a organização já guardou. Nenhuma API paga nova, nada é enviado à plataforma.
 */
import { somarDias } from "@/lib/negocio/faturamento";

import type { FalhaDeLeitura, PlataformaDeAnuncio } from "../types";

export interface PedidoDeGasto {
  organizationId: string;
  /** AAAA-MM-DD, inclusive. */
  de: string;
  /** AAAA-MM-DD, inclusive. */
  ate: string;
  /** A moeda da organização: o gasto só entra se a conta de anúncio for a mesma. */
  moeda: string;
}

export type LeituraDeGasto =
  | { estado: "conectada"; plataforma: PlataformaDeAnuncio; gasto_cents: number; moeda: string }
  | { estado: "nao_conectada"; plataforma: PlataformaDeAnuncio }
  /** Há credencial, mas ninguém escolheu a conta de anúncios padrão. */
  | { estado: "sem_conta"; plataforma: PlataformaDeAnuncio }
  | { estado: "moeda_diferente"; plataforma: PlataformaDeAnuncio; moeda_da_conta: string }
  /** O intervalo pedido é só o dia de hoje, que a plataforma ainda não fechou: não há o que ler (nem se chama a plataforma). */
  | { estado: "dia_incompleto"; plataforma: PlataformaDeAnuncio }
  | { estado: "indisponivel"; plataforma: PlataformaDeAnuncio; motivo: FalhaDeLeitura | "cifra_indisponivel" };

/**
 * O intervalo do gasto que se LÊ: nunca inclui o dia de hoje. A plataforma ainda reprocessa a atribuição do dia corrente por
 * horas, e incluí-lo faria o ROAS de hoje parecer pior de manhã e melhorar sozinho à tarde (a tela Meta Ads, que também
 * termina em ontem, evita isso pelo mesmo motivo). Período que chega a hoje é cortado em ontem; `sem_hoje` avisa a tela.
 * `hoje` é o dia civil da organização. Se `ate` < `de` o intervalo é vazio (período "Hoje").
 */
export function intervaloDeGastoLido(desde: string, ate: string, hoje: string): { de: string; ate: string; sem_hoje: boolean } {
  const semHoje = ate >= hoje;
  return { de: desde, ate: semHoje ? somarDias(hoje, -1) : ate, sem_hoje: semHoje };
}

/** Soma da série diária do painel até `ate` (inclusive): o faturamento e as vendas do MESMO intervalo em que o gasto foi lido. */
export function somarSerieAte(serie: ReadonlyArray<{ dia: string; total_cents: number; vendas: number }>, ate: string): { total_cents: number; vendas: number } {
  let total = 0;
  let vendas = 0;
  for (const p of serie) {
    if (p.dia > ate) continue;
    total += p.total_cents;
    vendas += p.vendas;
  }
  return { total_cents: total, vendas };
}

export interface FonteDeGasto {
  plataforma: PlataformaDeAnuncio;
  lerGasto(pedido: PedidoDeGasto): Promise<LeituraDeGasto>;
}

/** Pergunta a todas as fontes em paralelo. Uma que lança vira "indisponível", não derruba as outras. */
export async function lerGastoDasFontes(fontes: ReadonlyArray<FonteDeGasto>, pedido: PedidoDeGasto): Promise<LeituraDeGasto[]> {
  return Promise.all(
    fontes.map(async (f): Promise<LeituraDeGasto> => {
      try {
        return await f.lerGasto(pedido);
      } catch {
        return { estado: "indisponivel", plataforma: f.plataforma, motivo: "transitorio" };
      }
    }),
  );
}

export interface ResumoDeAnuncios {
  /** `false` = nenhuma fonte conectada: o painel esconde os cartões de anúncio por inteiro. */
  visivel: boolean;
  leituras: LeituraDeGasto[];
  /** Soma das fontes conectadas e na moeda certa; `null` sem nenhuma. */
  gasto_cents: number | null;
  /** Faturamento ÷ gasto, duas casas; `null` sem gasto. */
  roas: number | null;
  /** Gasto ÷ número de vendas; `null` sem gasto ou sem venda. */
  custo_por_venda_cents: number | null;
  /** Quantas fontes responderam com gasto. */
  fontes_lidas: number;
  /** Até que dia o gasto foi lido (AAAA-MM-DD); `null` sem intervalo informado. */
  ate_lido: string | null;
  /** O período chegava a hoje e o gasto foi cortado em ontem. */
  sem_hoje: boolean;
}

/** Cruza o gasto com o faturamento e as vendas do MESMO intervalo (o chamador soma a série até `intervalo.ate`). */
export function resumirAnuncios(
  leituras: ReadonlyArray<LeituraDeGasto>,
  faturamento: { total_cents: number; vendas: number },
  intervalo?: { ate: string; sem_hoje: boolean },
): ResumoDeAnuncios {
  const lidas = leituras.filter((l): l is Extract<LeituraDeGasto, { estado: "conectada" }> => l.estado === "conectada");
  const gasto = lidas.length > 0 ? lidas.reduce((s, l) => s + l.gasto_cents, 0) : null;
  return {
    visivel: leituras.some((l) => l.estado !== "nao_conectada"),
    leituras: [...leituras],
    gasto_cents: gasto,
    roas: gasto !== null && gasto > 0 ? Math.round((faturamento.total_cents / gasto) * 100) / 100 : null,
    custo_por_venda_cents: gasto !== null && faturamento.vendas > 0 ? Math.round(gasto / faturamento.vendas) : null,
    fontes_lidas: lidas.length,
    ate_lido: intervalo?.ate ?? null,
    sem_hoje: intervalo?.sem_hoje ?? false,
  };
}
