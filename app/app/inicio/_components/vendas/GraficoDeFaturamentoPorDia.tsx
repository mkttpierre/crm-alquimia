import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { formatCents } from "@/lib/money";
import type { PainelDeVendas } from "@/lib/negocio/painel-vendas";

import { Cartao, SemDado } from "../Cartao";

// Mesma geometria do gráfico de conversas do Início: o SVG estica na largura e os TEXTOS ficam fora dele, em HTML.
const W = 900;
const H = 212;

/** Teto "redondo" da escala: 4 divisões que cobrem o maior valor (em centavos). */
function tetoDaEscala(maximo: number): number {
  if (maximo <= 0) return 400;
  const bruto = maximo / 4;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * potencia).find((p) => p >= bruto) ?? bruto;
  return Math.ceil(passo) * 4;
}

/** "2026-11-05" → "05/11" (ou o formato do idioma), sem passar pelo fuso do navegador. */
function curto(ymd: string, idioma: Idioma): string {
  return new Intl.DateTimeFormat(tagDeIdioma(idioma), { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));
}

export function GraficoDeFaturamentoPorDia({ painel, idioma }: { painel: PainelDeVendas; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const titulo = t("Faturamento por dia");
  const subtitulo = t("A linha cheia é o período escolhido; a tracejada, o período de comparação.");
  const { serie, moeda } = painel;

  if (serie.length < 2) {
    return (
      <Cartao titulo={titulo}>
        <SemDado texto={t("O gráfico aparece a partir de dois dias de período. Escolha 7 dias, o mês ou 90 dias.")} />
      </Cartao>
    );
  }

  const maximo = Math.max(...serie.map((p) => Math.max(p.total_cents, p.anterior_cents ?? 0)));
  const teto = tetoDaEscala(maximo);
  const x = (i: number) => (i * W) / (serie.length - 1);
  const y = (v: number) => H * (1 - v / teto);
  // O período de comparação pode ser mais curto (mês de 30 dias contra 31): a linha dele para onde os dados acabam, sem zero falso.
  const linha = (vs: Array<number | null>) =>
    vs
      .flatMap((v, i) => (v === null ? [] : [{ v, i }]))
      .map(({ v, i }, k) => `${k ? "L" : "M"}${x(i)},${y(v)}`)
      .join(" ");
  const compacto = (v: number) => {
    try {
      return new Intl.NumberFormat(tagDeIdioma(idioma), { style: "currency", currency: moeda, notation: "compact", maximumFractionDigits: 1 }).format(v / 100);
    } catch {
      return formatCents(v, moeda);
    }
  };
  const ultima = serie.length - 1;

  return (
    <Cartao titulo={titulo} subtitulo={subtitulo}>
      <div className="relative mt-[14px] h-[240px] pb-7 pl-14" aria-hidden>
        {[0, 1, 2, 3, 4].map((k) => (
          <span
            key={k}
            className="absolute left-0 w-12 -translate-y-1/2 text-right font-mono text-[11px] text-muted-foreground tabular-nums"
            style={{ top: `${(1 - k / 4) * H}px` }}
          >
            {compacto((teto * k) / 4)}
          </span>
        ))}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[212px] w-full overflow-visible text-foreground">
          {[0, 1, 2, 3, 4].map((k) => (
            <line
              key={k}
              x1={0}
              x2={W}
              y1={(1 - k / 4) * H}
              y2={(1 - k / 4) * H}
              stroke="var(--color-border)"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path
            d={linha(serie.map((p) => p.anterior_cents))}
            fill="none"
            stroke="var(--color-text-subtle)"
            strokeWidth={2}
            strokeDasharray="5 5"
            vectorEffect="non-scaling-stroke"
          />
          <path d={linha(serie.map((p) => p.total_cents))} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="absolute right-0 bottom-0 left-14 flex justify-between text-[11px] text-muted-foreground">
          <span>{curto(serie[0]!.dia, idioma)}</span>
          <span>{curto(serie[ultima]!.dia, idioma)}</span>
        </div>
      </div>
      <div className="mt-1.5 flex justify-center gap-[18px] text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[9px] w-[9px] rounded-[2px] bg-foreground" />
          {t("Período escolhido")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[9px] w-[9px] rounded-[2px] bg-[var(--color-text-subtle)]" />
          {t("Período anterior")}
        </span>
      </div>
      {/* Os mesmos números para leitor de tela: o desenho acima é `aria-hidden`. */}
      <table className="sr-only">
        <caption>{titulo}</caption>
        <thead>
          <tr>
            <th scope="col">{t("Dia")}</th>
            <th scope="col">{t("Período escolhido")}</th>
            <th scope="col">{t("Período anterior")}</th>
          </tr>
        </thead>
        <tbody>
          {serie.map((p) => (
            <tr key={p.dia}>
              <th scope="row">{curto(p.dia, idioma)}</th>
              <td>{formatCents(p.total_cents, moeda)}</td>
              <td>{p.anterior_cents === null ? "—" : formatCents(p.anterior_cents, moeda)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Cartao>
  );
}
