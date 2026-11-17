import type { Icon } from "@phosphor-icons/react";

import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { ResumoDoInicio } from "@/lib/inicio/resumo";
import { ChartBar, ChatCircle, PaperPlaneTilt, UserPlus } from "@/lib/ui/icons";

/** Os quatro números do topo da Início, na ordem do protótipo A. */
export function NumerosDoDia({ resumo, idioma }: { resumo: ResumoDoInicio; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const tag = tagDeIdioma(idioma);
  const n = (v: number) => new Intl.NumberFormat(tag).format(v);
  const pct = (v: number) =>
    new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 1 }).format(v);

  const diferenca = resumo.leads.hoje - resumo.leads.ontem;
  const comparacao =
    diferenca === 0
      ? t("igual a ontem")
      : `${diferenca > 0 ? "+" : "−"}${n(Math.abs(diferenca))} ${t("que ontem")}`;

  // Sem `motor` (quem olha não é gestor), os dois cartões dele não aparecem —
  // a mesma régua da tela Disparo (`manager+`).
  const { motor } = resumo;
  const emChips = !motor
    ? ""
    : motor.chipsHoje === 0
      ? t("hoje")
      : `${t("hoje, em")} ${n(motor.chipsHoje)} ${motor.chipsHoje === 1 ? t("chip") : t("chips")}`;

  return (
    <div
      className={
        motor
          ? "grid grid-cols-1 gap-4 min-[521px]:grid-cols-2 min-[1101px]:grid-cols-4"
          : "grid grid-cols-1 gap-4 min-[521px]:grid-cols-2"
      }
    >
      <Numero
        titulo={t("Conversas abertas")}
        icone={ChatCircle}
        valor={n(resumo.conversas.abertas)}
        detalhe={`${n(resumo.conversas.esperandoResposta)} ${t("esperando resposta")}`}
      />
      <Numero
        titulo={t("Leads novos hoje")}
        icone={UserPlus}
        valor={n(resumo.leads.hoje)}
        detalhe={comparacao}
      />
      {motor && (
        <>
          <Numero
            titulo={t("Enviados pelo motor")}
            icone={PaperPlaneTilt}
            valor={n(motor.enviadosHoje)}
            detalhe={emChips}
          />
          <Numero
            titulo={t("Taxa de resposta")}
            icone={ChartBar}
            valor={motor.taxaDeResposta === null ? "—" : pct(motor.taxaDeResposta)}
            detalhe={
              motor.taxaDeResposta === null
                ? t("sem aberturas do motor nos últimos 7 dias")
                : `${t("últimos 7 dias")} · ${n(motor.respondidas7d)}/${n(motor.aberturas7d)}`
            }
          />
        </>
      )}
    </div>
  );
}

function Numero({
  titulo,
  icone: Icone,
  valor,
  detalhe,
}: {
  titulo: string;
  icone: Icon;
  valor: string;
  detalhe: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-[14px] rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <div className="flex items-center justify-between text-[13px] font-medium">
        <h2>{titulo}</h2>
        <Icone size={18} className="shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <p className="text-[28px] leading-none font-semibold tracking-[-0.01em] tabular-nums">
        {valor}
      </p>
      <p className="-mt-1 text-[12px] text-muted-foreground">{detalhe}</p>
    </section>
  );
}
