import Link from "next/link";

import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { formatCents } from "@/lib/money";
import {
  fontesDeGasto,
  intervaloDeGastoLido,
  lerGastoDasFontes,
  resumirAnuncios,
  somarSerieAte,
  type FonteDeGasto,
  type LeituraDeGasto,
  type ResumoDeAnuncios,
} from "@/lib/plataformas-de-anuncio/gasto";
import { createAdminClient } from "@/lib/supabase/admin";
import { Megaphone } from "@/lib/ui/icons";

import { Cartao } from "../Cartao";

const NOME_DA_PLATAFORMA: Record<string, string> = { meta_ads: "Meta Ads", google_ads: "Google Ads" };

function Numero({ titulo, valor, apoio }: { titulo: string; valor: string; apoio?: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-[10px] rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <div className="flex items-center justify-between text-[13px] font-medium">
        <h2>{titulo}</h2>
        <Megaphone size={18} className="shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <p className="truncate text-[28px] leading-none font-semibold tracking-[-0.01em] tabular-nums">{valor}</p>
      {apoio && <p className="text-[12px] text-muted-foreground">{apoio}</p>}
    </section>
  );
}

/** A linha de uma plataforma na lista de fontes: o gasto, ou o porquê de não haver. */
function LinhaDaFonte({ leitura, moeda, idioma }: { leitura: LeituraDeGasto; moeda: string; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const nome = NOME_DA_PLATAFORMA[leitura.plataforma] ?? leitura.plataforma;
  let texto: string;
  switch (leitura.estado) {
    case "conectada":
      texto = formatCents(leitura.gasto_cents, moeda);
      break;
    case "nao_conectada":
      texto = t("não conectado");
      break;
    case "sem_conta":
      texto = t("conectado, mas sem conta de anúncios padrão");
      break;
    case "dia_incompleto":
      texto = t("hoje ainda não fechou na plataforma");
      break;
    case "moeda_diferente":
      texto = `${t("a conta usa outra moeda")} (${leitura.moeda_da_conta}); ${t("não entra na soma")}`;
      break;
    default:
      texto = t("não consegui ler agora");
  }
  return (
    <li className="flex flex-wrap justify-between gap-x-3 text-[13px]">
      <span className="font-medium">{nome}</span>
      <span className="text-muted-foreground tabular-nums">{texto}</span>
    </li>
  );
}

/**
 * Os cartões de anúncios: gasto, ROAS (faturamento ÷ gasto) e custo por venda. A vista é pura (recebe o resumo já pronto);
 * `AnunciosDoPeriodo` é quem o busca. Sem nenhuma plataforma conectada, NADA é desenhado.
 */
export function AnunciosDoPeriodoVista({ resumo, moeda, idioma }: { resumo: ResumoDeAnuncios; moeda: string; idioma: Idioma }) {
  if (!resumo.visivel) return null;
  const t = (texto: string) => traduzir(texto, idioma);
  const roas = resumo.roas === null ? null : `${new Intl.NumberFormat(tagDeIdioma(idioma), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(resumo.roas)}×`;
  const precisaConta = resumo.leituras.some((l) => l.estado === "sem_conta");
  const soHoje = resumo.leituras.some((l) => l.estado === "dia_incompleto");
  const ateLido = resumo.ate_lido
    ? new Intl.DateTimeFormat(tagDeIdioma(idioma), { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${resumo.ate_lido}T12:00:00Z`))
    : null;

  return (
    <div className="flex flex-col gap-4" data-testid="anuncios-do-periodo">
      <div className="grid grid-cols-1 gap-4 min-[521px]:grid-cols-2 min-[1101px]:grid-cols-3">
        <Numero
          titulo={t("Gasto em anúncios")}
          valor={resumo.gasto_cents === null ? "—" : formatCents(resumo.gasto_cents, moeda)}
          apoio={soHoje ? t("O gasto de hoje só fica completo amanhã") : resumo.gasto_cents === null ? t("nenhuma plataforma com gasto lido") : undefined}
        />
        <Numero
          titulo={t("Retorno sobre o gasto (ROAS)")}
          valor={roas ?? "—"}
          apoio={soHoje ? t("O gasto de hoje só fica completo amanhã") : roas === null ? t("precisa de gasto no período") : t("faturamento dividido pelo gasto")}
        />
        <Numero
          titulo={t("Custo por venda")}
          valor={resumo.custo_por_venda_cents === null ? "—" : formatCents(resumo.custo_por_venda_cents, moeda)}
          apoio={
            soHoje
              ? t("O gasto de hoje só fica completo amanhã")
              : resumo.custo_por_venda_cents === null
                ? t("precisa de gasto e de pelo menos uma venda")
                : t("gasto dividido pelas vendas")
          }
        />
      </div>
      {resumo.sem_hoje && !soHoje && ateLido && (
        <p className="text-[12px] text-muted-foreground">
          {`${t("O gasto não inclui hoje, porque a plataforma ainda fecha o dia. ROAS e custo por venda usam o mesmo intervalo, até")} ${ateLido}.`}
        </p>
      )}
      <Cartao titulo={t("Gasto por plataforma")}>
        <ul className="mt-3 flex flex-col gap-2">
          {resumo.leituras.map((l) => (
            <LinhaDaFonte key={l.plataforma} leitura={l} moeda={moeda} idioma={idioma} />
          ))}
        </ul>
        {precisaConta && (
          <p className="mt-3 text-[12px] text-muted-foreground">
            <Link href="/app/settings/meta-ads" prefetch={false} className="font-medium text-foreground underline underline-offset-4">
              {t("Escolher a conta de anúncios padrão")}
            </Link>
          </p>
        )}
      </Cartao>
    </div>
  );
}

/** Busca o gasto de todas as fontes no período e cruza com o faturamento DO MESMO período. Só leitura. */
export async function AnunciosDoPeriodo({
  organizationId,
  desde,
  ate,
  hoje,
  moeda,
  serie,
  idioma,
  fontes,
}: {
  organizationId: string;
  desde: string;
  ate: string;
  /** Hoje no fuso da organização: o gasto é lido até ontem e o faturamento do ROAS é somado no mesmo intervalo. */
  hoje: string;
  moeda: string;
  /** A série diária do painel (a mesma conta do faturamento). */
  serie: ReadonlyArray<{ dia: string; total_cents: number; vendas: number }>;
  idioma: Idioma;
  /** Para teste: sem isto, as fontes reais (Meta Ads e Google Ads). */
  fontes?: ReadonlyArray<FonteDeGasto>;
}) {
  const lido = intervaloDeGastoLido(desde, ate, hoje);
  const leituras = await lerGastoDasFontes(fontes ?? fontesDeGasto(createAdminClient()), { organizationId, de: lido.de, ate: lido.ate, moeda });
  const resumo = resumirAnuncios(leituras, somarSerieAte(serie, lido.ate), { ate: lido.ate, sem_hoje: lido.sem_hoje });
  return <AnunciosDoPeriodoVista resumo={resumo} moeda={moeda} idioma={idioma} />;
}
