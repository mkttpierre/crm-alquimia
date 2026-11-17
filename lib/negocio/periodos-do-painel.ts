/**
 * Os períodos do painel "Vendas e faturamento" do Início, em dias civis do FUSO da organização.
 *
 * Cinco opções fechadas (decisão do dono do produto): Hoje, 7 dias, Este mês (o padrão), Mês passado e 90 dias. Com que
 * cada uma se compara está em `periodoDeComparacao`: Hoje, 7 dias e 90 dias contra o período de mesmo tamanho na véspera
 * (`periodoAnterior`, de `faturamento.ts`, a régua da tela Faturamento); os dois meses contra o mês anterior.
 *
 * Tudo aqui é puro: recebe o "hoje" já resolvido no fuso (`diaCivil`) e devolve datas AAAA-MM-DD. O texto da URL só entra
 * por `lerPeriodo`, que fecha para o padrão em vez de confiar.
 */
import { periodoAnterior, somarDias } from "./faturamento";

export const PERIODOS_DO_PAINEL = ["hoje", "7d", "mes", "mes-passado", "90d"] as const;
export type ChaveDePeriodo = (typeof PERIODOS_DO_PAINEL)[number];

export const PERIODO_PADRAO_DO_PAINEL: ChaveDePeriodo = "mes";

/** O que veio da URL (`?periodo=`). Qualquer coisa fora das cinco chaves vira o padrão. */
export function lerPeriodo(bruto: string | string[] | null | undefined): ChaveDePeriodo {
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  return (PERIODOS_DO_PAINEL as readonly string[]).includes(valor ?? "") ? (valor as ChaveDePeriodo) : PERIODO_PADRAO_DO_PAINEL;
}

export const primeiroDiaDoMes = (ymd: string): string => `${ymd.slice(0, 7)}-01`;

/** Quantos dias tem o mês do dia dado (fevereiro de ano bissexto inclusive). */
export function diasDoMes(ymd: string): number {
  const ano = Number(ymd.slice(0, 4));
  const mes = Number(ymd.slice(5, 7));
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

export const ultimoDiaDoMes = (ymd: string): string => `${ymd.slice(0, 7)}-${String(diasDoMes(ymd)).padStart(2, "0")}`;

export interface PeriodoDoPainel {
  chave: ChaveDePeriodo;
  desde: string;
  ate: string;
}

/** Resolve a chave em datas, a partir do dia de hoje no fuso da organização. */
export function resolverPeriodo(chave: ChaveDePeriodo, hoje: string): PeriodoDoPainel {
  switch (chave) {
    case "hoje":
      return { chave, desde: hoje, ate: hoje };
    case "7d":
      return { chave, desde: somarDias(hoje, -6), ate: hoje };
    case "90d":
      return { chave, desde: somarDias(hoje, -89), ate: hoje };
    case "mes-passado": {
      const fimDoMesPassado = somarDias(primeiroDiaDoMes(hoje), -1);
      return { chave, desde: primeiroDiaDoMes(fimDoMesPassado), ate: fimDoMesPassado };
    }
    case "mes":
    default:
      return { chave: "mes", desde: primeiroDiaDoMes(hoje), ate: hoje };
  }
}

/**
 * O período contra o qual cada número do painel se compara.
 *
 *  - Hoje, 7 dias e 90 dias: o de mesmo tamanho que termina na véspera (`periodoAnterior`).
 *  - Este mês: os MESMOS dias do mês anterior (01–16/11 contra 01–16/10), cortando no último dia do mês anterior quando ele
 *    é mais curto (31/03 contra 01–28/02). Comparar 01–16/11 com 16–31/10 misturaria duas metades de meses diferentes.
 *  - Mês passado: o mês retrasado INTEIRO.
 */
export function periodoDeComparacao(periodo: PeriodoDoPainel): { desde: string; ate: string } {
  switch (periodo.chave) {
    case "mes": {
      const fimDoMesAnterior = somarDias(primeiroDiaDoMes(periodo.ate), -1);
      const dia = Number(periodo.ate.slice(8, 10));
      const ultimo = diasDoMes(fimDoMesAnterior);
      return {
        desde: primeiroDiaDoMes(fimDoMesAnterior),
        ate: `${fimDoMesAnterior.slice(0, 7)}-${String(Math.min(dia, ultimo)).padStart(2, "0")}`,
      };
    }
    case "mes-passado": {
      const fimDoRetrasado = somarDias(primeiroDiaDoMes(periodo.desde), -1);
      return { desde: primeiroDiaDoMes(fimDoRetrasado), ate: fimDoRetrasado };
    }
    default:
      return periodoAnterior(periodo.desde, periodo.ate);
  }
}

const FUSO_DE_RESERVA = "America/Sao_Paulo";

/** Quanto o fuso está à frente de UTC (em ms) num instante. */
function deslocamentoDoFuso(instanteMs: number, timezone: string): number {
  const formatar = (tz: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instanteMs));
  let partes: Intl.DateTimeFormatPart[];
  try {
    partes = formatar(timezone);
  } catch {
    partes = formatar(FUSO_DE_RESERVA);
  }
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  const comoUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return comoUtc - Math.floor(instanteMs / 1000) * 1000;
}

/** O instante (ISO, UTC) em que o dia civil começa no fuso. Serve para contar linhas por data de criação sem recorte em TS. */
export function inicioDoDia(ymd: string, timezone: string): string {
  const meiaNoiteUtc = Date.parse(`${ymd}T00:00:00.000Z`);
  // Duas passadas: o deslocamento do fuso pode mudar entre a meia-noite UTC e o instante achado (horário de verão).
  const primeiro = meiaNoiteUtc - deslocamentoDoFuso(meiaNoiteUtc, timezone);
  const segundo = meiaNoiteUtc - deslocamentoDoFuso(primeiro, timezone);
  return new Date(segundo).toISOString();
}

/** O intervalo [de, ate) em instantes UTC que cobre os dias civis `desde..ate` inclusive, no fuso. */
export function limitesDoPeriodo(desde: string, ate: string, timezone: string): { de: string; ate: string } {
  return { de: inicioDoDia(desde, timezone), ate: inicioDoDia(somarDias(ate, 1), timezone) };
}
