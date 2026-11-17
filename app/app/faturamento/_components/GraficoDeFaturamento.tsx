"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { formatCents } from "@/lib/money";

export interface PontoDoGrafico {
  chave: string;
  /** Rótulo legível do período (dia, semana ou mês), já formatado. */
  rotulo: string;
  total_cents: number;
  vendas: number;
}

/**
 * Faturamento por dia, semana ou mês: barras, eixo em reais e dica ao passar o mouse (valor e número de vendas).
 *
 * As cores vêm dos tokens do tema (`--color-*`), então o gráfico acompanha o tema escuro sem um hex sequer. O
 * `ResponsiveContainer` ocupa a largura do cartão e o cartão tem `min-w-0`, para o gráfico nunca empurrar a página para
 * os lados no celular. Abaixo do gráfico há uma lista só para leitor de tela (a mesma série, em texto).
 */
export function GraficoDeFaturamento({ pontos, moeda }: { pontos: ReadonlyArray<PontoDoGrafico>; moeda: string }) {
  const t = useT();
  const tag = useTagDeIdioma();

  const compacto = (v: number): string => {
    try {
      return new Intl.NumberFormat(tag, { style: "currency", currency: moeda, notation: "compact", maximumFractionDigits: 1 }).format(v / 100);
    } catch {
      return formatCents(v, moeda);
    }
  };

  return (
    <div className="min-w-0" data-testid="grafico-faturamento">
      <div role="img" aria-label={t("Gráfico do faturamento por período")} className="h-64 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={pontos as PontoDoGrafico[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis dataKey="rotulo" tick={{ fontSize: 11, fill: "var(--color-text-muted)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "var(--color-text-muted)" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => compacto(v)} width={64} />
            <Tooltip
              cursor={{ fill: "var(--color-accent-soft)" }}
              contentStyle={{ borderRadius: 8, fontSize: 12, border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-text)" }}
              labelStyle={{ color: "var(--color-text-muted)" }}
              formatter={(valor, _nome, item) => {
                const vendas = (item?.payload as PontoDoGrafico | undefined)?.vendas ?? 0;
                return [`${formatCents(Number(valor), moeda)} · ${vendas} ${t(vendas === 1 ? "venda" : "vendas")}`, t("Faturamento")];
              }}
            />
            <Bar dataKey="total_cents" fill="var(--color-accent)" radius={[3, 3, 0, 0]} maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="sr-only">
        {pontos.map((p) => (
          <li key={p.chave}>
            <span>{p.rotulo}</span>: <span>{formatCents(p.total_cents, moeda)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
