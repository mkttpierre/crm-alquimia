import Link from "next/link";

import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { FunilDoInicio } from "@/lib/inicio/resumo";

import { Cartao, SemDado } from "./Cartao";

/**
 * Cada funil com quantos leads tem, quantas etapas, se o motor puxa leads dele
 * e a fatia que já saiu da primeira etapa. Sem selo quando o motor não usa o
 * funil: "Manual" (o texto do protótipo) afirmaria algo que o banco não diz —
 * a IA pode estar atendendo ali.
 */
export function CardDeFunis({ funis, idioma }: { funis: FunilDoInicio[]; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const tag = tagDeIdioma(idioma);
  const n = (v: number) => new Intl.NumberFormat(tag).format(v);
  const pct = (v: number) =>
    new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 }).format(v);

  return (
    <Cartao titulo={t("Funis")} subtitulo={t("Quantos leads já passaram da primeira etapa")}>
      {funis.length === 0 ? (
        <SemDado
          texto={t(
            "Cada funil aparece aqui com seus leads e quantos já andaram. Comece criando o primeiro funil.",
          )}
          acao={
            <Link
              href="/app/kanban"
              prefetch={false}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {t("Abrir Funis")}
            </Link>
          }
        />
      ) : (
        <ul className="mt-[18px] flex flex-col gap-[18px]">
          {funis.map((f) => (
            <li key={f.id}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="min-w-0 truncate text-[14px] font-medium">
                  <Link
                    href={`/app/pipelines/${f.id}`}
                    prefetch={false}
                    className="underline-offset-4 hover:underline"
                  >
                    {f.nome}
                  </Link>
                </h3>
                {f.motorLigado && (
                  <span className="shrink-0 rounded-full border border-foreground bg-foreground px-[9px] py-[5px] text-[11px] leading-none font-medium text-background">
                    {t("Motor ligado")}
                  </span>
                )}
              </div>
              <p className="mt-1 mb-2 text-[12px] text-muted-foreground">
                {n(f.leads)} {f.leads === 1 ? t("lead") : t("leads")} · {n(f.etapas)}{" "}
                {f.etapas === 1 ? t("etapa") : t("etapas")}
              </p>
              <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
                <div
                  className="h-[7px] flex-1 overflow-hidden rounded-full bg-border"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(f.alemDaPrimeira * 100)}
                  aria-label={`${f.nome}: ${t("além da primeira etapa")}`}
                >
                  <div
                    className="h-full rounded-full bg-foreground"
                    style={{ width: `${f.alemDaPrimeira * 100}%` }}
                  />
                </div>
                <span className="tabular-nums">{pct(f.alemDaPrimeira)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Cartao>
  );
}
