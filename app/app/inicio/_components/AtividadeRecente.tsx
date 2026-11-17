import { formatDistanceStrict } from "date-fns";
import Link from "next/link";

import { traduzir } from "@/lib/i18n/dicionario";
import { localeDeData } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { AtividadeDoInicio } from "@/lib/inicio/resumo";
import { iniciaisDe } from "@/components/agenda/paleta";

import { Cartao, SemDado } from "./Cartao";

/** As últimas atividades da organização, com quem fez e "há X min". */
export function AtividadeRecente({
  atividades,
  agora,
  idioma,
}: {
  atividades: AtividadeDoInicio[];
  agora: Date;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const quando = (iso: string) =>
    formatDistanceStrict(new Date(iso), agora, { addSuffix: true, locale: localeDeData(idioma) });

  return (
    <Cartao titulo={t("Atividade recente")} subtitulo={t("O que mudou no CRM por último")}>
      {atividades.length === 0 ? (
        <SemDado
          texto={t(
            "O que a equipe e a IA fizerem nos leads aparece aqui: quem moveu, anotou, agendou ou fechou. Mova um lead no funil para ver a primeira.",
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
          {atividades.map((a) => (
            <li key={a.id} className="flex items-start gap-3">
              <span
                aria-hidden
                className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-foreground text-[10px] font-semibold text-background"
              >
                {a.especie === "ai" ? "IA" : iniciaisDe(t(a.autor))}
              </span>
              <div className="min-w-0">
                <p className="text-[13px]">
                  {t(a.autor)}{" "}
                  <span className="text-muted-foreground">
                    {t(a.rotulo)}
                    {a.lead ? ` · ${a.lead}` : ""}
                  </span>
                </p>
                <time dateTime={a.em} className="text-[12px] text-text-subtle">
                  {quando(a.em)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Cartao>
  );
}
