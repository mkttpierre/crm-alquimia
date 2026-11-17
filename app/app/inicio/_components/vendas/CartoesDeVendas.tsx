import type { ReactNode } from "react";

import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { formatCents } from "@/lib/money";
import { duracaoLegivel } from "@/lib/negocio/duracao";
import type { NumeroComparado, NumeroOpcional, PainelDeVendas } from "@/lib/negocio/painel-vendas";
import { ChartLineUp, Clock, Receipt } from "@/lib/ui/icons";

/**
 * Quanto o número mudou contra o período de comparação; sem base, diz isso em vez de inventar %.
 *
 * `menorEhMelhor`: para métrica em que cair é bom (tempo até a venda), a cor inverte — subir é vermelho, cair é verde.
 * A seta continua mostrando a direção do número; só o julgamento (cor) muda.
 */
export function Variacao({ variacao, idioma, menorEhMelhor = false }: { variacao: number | null; idioma: Idioma; menorEhMelhor?: boolean }) {
  const t = (texto: string) => traduzir(texto, idioma);
  if (variacao === null) return <p className="text-[12px] text-muted-foreground">{t("sem base de comparação")}</p>;
  const texto = new Intl.NumberFormat(tagDeIdioma(idioma), { maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(variacao);
  const bom = menorEhMelhor ? variacao < 0 : variacao > 0;
  const ruim = menorEhMelhor ? variacao > 0 : variacao < 0;
  const cor = bom ? "text-success-fg" : ruim ? "text-error-fg" : "text-muted-foreground";
  return (
    <p className={`text-[12px] ${cor}`} data-testid="variacao">
      <span aria-hidden>{variacao > 0 ? "▲" : variacao < 0 ? "▼" : "•"} </span>
      {texto}% <span className="text-muted-foreground">{t("contra o período anterior")}</span>
    </p>
  );
}

/** A diferença de uma taxa (conversão, recompra), em pontos percentuais: "+2,1 p.p." — percentual de percentual confunde. */
function DiferencaEmPontos({ n, idioma }: { n: NumeroOpcional; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  if (n.atual === null || n.anterior === null) return <p className="text-[12px] text-muted-foreground">{t("sem base de comparação")}</p>;
  const pontos = Math.round((n.atual - n.anterior) * 1000) / 10;
  const texto = new Intl.NumberFormat(tagDeIdioma(idioma), { maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(pontos);
  const cor = pontos > 0 ? "text-success-fg" : pontos < 0 ? "text-error-fg" : "text-muted-foreground";
  return (
    <p className={`text-[12px] ${cor}`} data-testid="variacao">
      <span aria-hidden>{pontos > 0 ? "▲" : pontos < 0 ? "▼" : "•"} </span>
      {texto} {t("p.p.")} <span className="text-muted-foreground">{t("contra o período anterior")}</span>
    </p>
  );
}

function Numero({ titulo, icone, valor, children }: { titulo: string; icone: ReactNode; valor: string; children?: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-[10px] rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <div className="flex items-center justify-between text-[13px] font-medium">
        <h2>{titulo}</h2>
        <span className="shrink-0 text-muted-foreground" aria-hidden>
          {icone}
        </span>
      </div>
      <p className="truncate text-[28px] leading-none font-semibold tracking-[-0.01em] tabular-nums">{valor}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

const SEM_VALOR = "—";

/** Faturamento, número de vendas e ticket médio, cada um com a variação contra o período anterior. */
export function CartoesDeFaturamento({ painel, idioma }: { painel: PainelDeVendas; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const n = (v: number) => new Intl.NumberFormat(tagDeIdioma(idioma)).format(v);
  const fat: NumeroComparado = painel.faturamento;
  return (
    <div className="grid grid-cols-1 gap-4 min-[521px]:grid-cols-2 min-[1101px]:grid-cols-3">
      <Numero titulo={t("Faturamento")} icone={<ChartLineUp size={18} />} valor={formatCents(fat.atual, painel.moeda)}>
        <Variacao variacao={fat.variacao} idioma={idioma} />
      </Numero>
      <Numero titulo={t("Vendas")} icone={<Receipt size={18} />} valor={n(painel.vendas.atual)}>
        <Variacao variacao={painel.vendas.variacao} idioma={idioma} />
      </Numero>
      <Numero
        titulo={t("Ticket médio")}
        icone={<Receipt size={18} />}
        valor={painel.ticket_medio.atual === null ? SEM_VALOR : formatCents(painel.ticket_medio.atual, painel.moeda)}
      >
        <Variacao variacao={painel.ticket_medio.variacao} idioma={idioma} />
      </Numero>
    </div>
  );
}

function textoDaDuracao(ms: number | null, idioma: Idioma): string {
  const t = (texto: string) => traduzir(texto, idioma);
  if (ms === null) return SEM_VALOR;
  const d = duracaoLegivel(ms);
  const n = (v: number) => new Intl.NumberFormat(tagDeIdioma(idioma), { maximumFractionDigits: 1 }).format(v);
  if (d.tipo === "menos_de_uma_hora") return t("menos de 1 hora");
  return d.tipo === "horas" ? `${n(d.valor)} ${t("horas")}` : `${n(d.valor)} ${t("dias")}`;
}

/** Conversão lead → venda, tempo médio até a venda e recompra. */
export function CartoesDeRelacionamento({ painel, idioma }: { painel: PainelDeVendas; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const tag = tagDeIdioma(idioma);
  const n = (v: number) => new Intl.NumberFormat(tag).format(v);
  const pct = (v: number | null) => (v === null ? SEM_VALOR : new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 1 }).format(v));
  const { conversao, recompra, tempo_ate_a_venda_ms: tempo } = painel;

  return (
    <div className="grid grid-cols-1 gap-4 min-[521px]:grid-cols-2 min-[1101px]:grid-cols-3">
      <Numero titulo={t("Conversão de leads em venda")} icone={<ChartLineUp size={18} />} valor={pct(conversao.taxa.atual)}>
        <p className="text-[12px] text-muted-foreground">
          {conversao.leads === 0
            ? t("nenhum lead novo no período")
            : `${n(conversao.ganhos)} ${t("de")} ${n(conversao.leads)} ${t("leads novos viraram venda")}`}
        </p>
        <DiferencaEmPontos n={conversao.taxa} idioma={idioma} />
      </Numero>
      <Numero titulo={t("Tempo médio até a venda")} icone={<Clock size={18} />} valor={textoDaDuracao(tempo.atual, idioma)}>
        <p className="text-[12px] text-muted-foreground">{t("do nascimento do lead até fechar")}</p>
        {tempo.atual !== null && tempo.anterior !== null ? (
          <Variacao variacao={tempo.variacao} idioma={idioma} menorEhMelhor />
        ) : (
          <p className="text-[12px] text-muted-foreground">{t("sem base de comparação")}</p>
        )}
      </Numero>
      <Numero titulo={t("Clientes que compraram de novo")} icone={<Receipt size={18} />} valor={pct(recompra.taxa.atual)}>
        <p className="text-[12px] text-muted-foreground">
          {recompra.clientes === 0
            ? t("nenhum cliente com cadastro comprou no período")
            : `${n(recompra.recompradores)} ${t("de")} ${n(recompra.clientes)} ${t("clientes do período")}`}
        </p>
        <DiferencaEmPontos n={recompra.taxa} idioma={idioma} />
      </Numero>
    </div>
  );
}
