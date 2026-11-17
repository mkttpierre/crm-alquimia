import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { formatCents } from "@/lib/money";
import type { PainelDeVendas } from "@/lib/negocio/painel-vendas";

import { Cartao } from "../Cartao";
import { MetaDoMesForm } from "./MetaDoMesForm";

/**
 * A meta do mês corrente: barra de progresso, quanto falta e o ritmo por dia. É do MÊS DE HOJE, seja qual for o período
 * escolhido no painel. Só o admin vê o formulário; os demais gestores veem o progresso (ou o aviso de que não há meta).
 */
export function MetaDoMes({ painel, idioma, admin }: { painel: PainelDeVendas; idioma: Idioma; admin: boolean }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const tag = tagDeIdioma(idioma);
  const n = (v: number) => new Intl.NumberFormat(tag).format(v);
  const meta = painel.meta;
  const titulo = t("Meta do mês");

  if (!meta) {
    return (
      <Cartao titulo={titulo}>
        <p className="mt-2 text-[13px] text-muted-foreground">
          {admin
            ? t("Defina quanto a empresa quer faturar por mês e acompanhe aqui o progresso, quanto falta e o ritmo por dia.")
            : t("A meta mensal ainda não foi definida. Quem administra a empresa define aqui.")}
        </p>
        {admin && <MetaDoMesForm metaAtualTexto="" moeda={painel.moeda} temMeta={false} />}
      </Cartao>
    );
  }

  const largura = Math.min(100, Math.max(0, meta.percentual));
  const pct = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(meta.percentual);

  return (
    <Cartao titulo={titulo} subtitulo={`${formatCents(meta.realizado_cents, painel.moeda)} ${t("de")} ${formatCents(meta.meta_cents, painel.moeda)}`}>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <p className="text-[28px] leading-none font-semibold tabular-nums">{`${pct}%`}</p>
        <p className="text-[12px] text-muted-foreground">{meta.atingida ? t("Meta batida") : t(meta.no_ritmo ? "No ritmo de bater a meta" : "Abaixo do ritmo da meta")}</p>
      </div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={titulo}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(largura)}
      >
        <div className="h-full rounded-full bg-foreground" style={{ width: `${largura}%` }} />
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-3 text-[13px] min-[521px]:grid-cols-3">
        <div>
          <dt className="text-[12px] text-muted-foreground">{meta.atingida ? t("Passou da meta em") : t("Falta")}</dt>
          <dd className="font-medium tabular-nums">
            {formatCents(meta.atingida ? meta.realizado_cents - meta.meta_cents : meta.falta_cents, painel.moeda)}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted-foreground">{t("Ritmo necessário por dia")}</dt>
          <dd className="font-medium tabular-nums">
            {meta.atingida ? "—" : `${formatCents(meta.ritmo_necessario_cents, painel.moeda)} ${t("por dia")}`}
          </dd>
          {!meta.atingida && <dd className="text-[12px] text-muted-foreground">{`${n(meta.dias_restantes)} ${meta.dias_restantes === 1 ? t("dia restante") : t("dias restantes")}`}</dd>}
        </div>
        <div>
          <dt className="text-[12px] text-muted-foreground">{t("Ritmo atual")}</dt>
          <dd className="font-medium tabular-nums">{`${formatCents(meta.ritmo_atual_cents, painel.moeda)} ${t("por dia")}`}</dd>
          <dd className="text-[12px] text-muted-foreground">{`${t("Projeção do mês")}: ${formatCents(meta.projecao_cents, painel.moeda)}`}</dd>
        </div>
      </dl>
      {admin && <MetaDoMesForm metaAtualTexto={textoDaMeta(meta.meta_cents)} moeda={painel.moeda} temMeta />}
    </Cartao>
  );
}

/** A meta atual como o admin a digitaria: "50000" ou "50000,50", sem símbolo. */
function textoDaMeta(cents: number): string {
  const inteiro = Math.floor(cents / 100);
  const resto = cents % 100;
  return resto === 0 ? String(inteiro) : `${inteiro},${String(resto).padStart(2, "0")}`;
}
