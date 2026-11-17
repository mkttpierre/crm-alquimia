/**
 * A meta mensal de faturamento do painel "Vendas e faturamento" (migration 0262).
 *
 * Duas coisas puras: o cálculo do progresso (quanto falta e o ritmo por dia), e a leitura do que o admin digita. O banco
 * guarda só `organizations.meta_mensal_cents` (centavos, na moeda da organização); NULL = sem meta.
 */
import { z } from "zod";

import { diasDoMes } from "./periodos-do-painel";

/** O mesmo teto do CHECK `organizations_meta_mensal_cents_faixa`. */
export const META_MAXIMA_CENTS = 100_000_000_000_000;

export const metaMensalSchema = z
  .object({
    /** `null` apaga a meta. Centavos inteiros, de 1 até o teto. */
    metaCents: z.number().int().positive().max(META_MAXIMA_CENTS).nullable(),
  })
  .strict();
export type EntradaDaMeta = z.infer<typeof metaMensalSchema>;

export interface ProgressoDaMeta {
  meta_cents: number;
  realizado_cents: number;
  /** Realizado ÷ meta, em %, uma casa. Passa de 100 quando a meta foi batida. */
  percentual: number;
  falta_cents: number;
  atingida: boolean;
  /** Dias que ainda podem vender neste mês, HOJE INCLUÍDO. */
  dias_restantes: number;
  dias_no_mes: number;
  /** O que precisa entrar por dia, daqui até o fim do mês, para fechar a meta. 0 com a meta batida. */
  ritmo_necessario_cents: number;
  /** A média por dia do mês até hoje (hoje incluído). */
  ritmo_atual_cents: number;
  /** Onde o mês fecha se o ritmo atual se mantiver. */
  projecao_cents: number;
  /** A projeção alcança a meta. */
  no_ritmo: boolean;
}

/**
 * Progresso da meta no mês de `hoje` (dia civil no fuso da organização).
 * `realizadoCents` é o faturamento do mês corrente, da MESMA conta do painel (não uma segunda soma).
 */
export function calcularProgressoDaMeta(entrada: { metaCents: number | null; realizadoCents: number; hoje: string }): ProgressoDaMeta | null {
  const { metaCents, realizadoCents, hoje } = entrada;
  if (metaCents === null || !Number.isFinite(metaCents) || metaCents <= 0) return null;

  const diasNoMes = diasDoMes(hoje);
  const diaDoMes = Number(hoje.slice(8, 10));
  const diasRestantes = Math.max(1, diasNoMes - diaDoMes + 1);
  const falta = Math.max(0, metaCents - realizadoCents);
  const ritmoAtual = Math.round(realizadoCents / diaDoMes);
  const projecao = ritmoAtual * diasNoMes;

  return {
    meta_cents: metaCents,
    realizado_cents: realizadoCents,
    percentual: Math.round((realizadoCents / metaCents) * 1000) / 10,
    falta_cents: falta,
    atingida: realizadoCents >= metaCents,
    dias_restantes: diasRestantes,
    dias_no_mes: diasNoMes,
    ritmo_necessario_cents: falta === 0 ? 0 : Math.ceil(falta / diasRestantes),
    ritmo_atual_cents: ritmoAtual,
    projecao_cents: projecao,
    no_ritmo: projecao >= metaCents,
  };
}

export type LeituraDoValor = { ok: true; cents: number | null } | { ok: false };

/**
 * Lê o valor que o admin digitou ("10000", "10.000", "10.000,50", "10,000.50") em centavos.
 * Vazio = apagar a meta (`cents: null`). Zero, negativo, texto solto e acima do teto são recusados.
 *
 * Com UM só tipo de separador, três dígitos depois dele são milhar ("10.000"); um ou dois são centavos ("10,5", "10.50").
 * Com os dois, o último é o decimal.
 */
export function lerValorEmCents(texto: string): LeituraDoValor {
  const limpo = texto.replace(/\s|R\$|\$/gi, "");
  if (limpo === "") return { ok: true, cents: null };
  if (!/^\d[\d.,]*$/.test(limpo)) return { ok: false };

  const ultimoPonto = limpo.lastIndexOf(".");
  const ultimaVirgula = limpo.lastIndexOf(",");
  let inteiro: string;
  let decimais = "";

  if (ultimoPonto >= 0 && ultimaVirgula >= 0) {
    const decimal = Math.max(ultimoPonto, ultimaVirgula);
    inteiro = limpo.slice(0, decimal).replace(/[.,]/g, "");
    decimais = limpo.slice(decimal + 1);
  } else if (ultimoPonto >= 0 || ultimaVirgula >= 0) {
    const sep = ultimoPonto >= 0 ? "." : ",";
    const partes = limpo.split(sep);
    const ultima = partes[partes.length - 1]!;
    // "1.000.000" (vários separadores) ou "10.000" (três dígitos) é milhar; "10,5" e "10.50" são centavos.
    if (partes.length > 2 || ultima.length === 3) {
      inteiro = partes.join("");
    } else {
      inteiro = partes[0]!;
      decimais = ultima;
    }
  } else {
    inteiro = limpo;
  }

  if (!/^\d+$/.test(inteiro) || (decimais !== "" && !/^\d{1,2}$/.test(decimais))) return { ok: false };
  const cents = Number(inteiro) * 100 + Number(decimais.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > META_MAXIMA_CENTS) return { ok: false };
  return { ok: true, cents };
}
