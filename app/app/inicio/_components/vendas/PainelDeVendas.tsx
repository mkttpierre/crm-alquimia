import type { ReactNode } from "react";

import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { PainelCarregado } from "@/lib/negocio/carregar-painel-vendas";

import { Cartao, SemDado } from "../Cartao";
import { CartoesDeFaturamento, CartoesDeRelacionamento } from "./CartoesDeVendas";
import { GraficoDeFaturamentoPorDia } from "./GraficoDeFaturamentoPorDia";
import { MetaDoMes } from "./MetaDoMes";
import { ProdutosMaisVendidos, VendasPorOrigem } from "./ProdutosEOrigem";
import { SeletorDePeriodo } from "./SeletorDePeriodo";

/** "2026-11-05" → "05/11/2026" (ou o formato do idioma), sem passar pelo fuso do navegador. */
function dia(ymd: string, idioma: Idioma): string {
  return new Intl.DateTimeFormat(tagDeIdioma(idioma), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));
}

/**
 * O painel "Vendas e faturamento" do Início. Só é desenhado para `manager`+ (a página decide); os números vêm de
 * `carregarPainelDeVendas`, que usa a mesma fonte da tela Faturamento. Tela de leitura: não envia nem muda nada.
 *
 * `anuncios` entra de fora (a página o monta dentro de um `Suspense`): a leitura do gasto fala com a plataforma de anúncios,
 * e o painel não pode esperar por ela.
 */
export function PainelDeVendas({ carregado, idioma, admin, anuncios }: { carregado: PainelCarregado; idioma: Idioma; admin: boolean; anuncios?: ReactNode }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const { painel, periodo } = carregado;
  const semVendas = painel.vendas.atual === 0 && painel.vendas.anterior === 0 && painel.mes_corrente_cents === 0;

  return (
    <div className="flex flex-col gap-5" data-testid="painel-de-vendas">
      <div className="flex flex-col gap-2">
        <SeletorDePeriodo periodo={periodo.chave} idioma={idioma} />
        <p className="text-[12px] text-muted-foreground">
          {`${dia(painel.desde, idioma)} – ${dia(painel.ate, idioma)} · ${t("comparado com")} ${dia(painel.anterior.desde, idioma)} – ${dia(painel.anterior.ate, idioma)}`}
        </p>
      </div>

      {carregado.truncado && (
        <p role="status" className="rounded-[10px] border border-border bg-card p-3 text-[13px] text-muted-foreground">
          {t("Há mais vendas do que o painel consegue ler de uma vez: os números podem estar incompletos. Escolha um período menor.")}
        </p>
      )}

      {semVendas ? (
        <Cartao titulo={t("Vendas e faturamento")}>
          <SemDado texto={t("Ainda não há vendas registradas. Quando um negócio for ganho ou um pedido for pago, o faturamento, o ticket médio e os produtos mais vendidos aparecem aqui.")} />
        </Cartao>
      ) : (
        <>
          <CartoesDeFaturamento painel={painel} idioma={idioma} />
          <GraficoDeFaturamentoPorDia painel={painel} idioma={idioma} />
          <div className="grid gap-5 min-[861px]:grid-cols-2">
            <ProdutosMaisVendidos painel={painel} idioma={idioma} />
            <VendasPorOrigem painel={painel} idioma={idioma} />
          </div>
          <CartoesDeRelacionamento painel={painel} idioma={idioma} />
          {painel.somente_negocios && (
            <p className="text-[12px] text-muted-foreground">{t("Nesta empresa, só os negócios ganhos entram no total; pedidos da loja ficam de fora.")}</p>
          )}
          {painel.ignorados_outra_moeda > 0 && (
            <p className="text-[12px] text-muted-foreground">{t("Vendas em outra moeda não entram nos totais.")}</p>
          )}
        </>
      )}

      <MetaDoMes painel={painel} idioma={idioma} admin={admin} />
      {anuncios}
    </div>
  );
}
