import Link from "next/link";

import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { PERIODOS_DO_PAINEL, type ChaveDePeriodo } from "@/lib/negocio/periodos-do-painel";
import { cn } from "@/lib/utils";

const ROTULOS: Record<ChaveDePeriodo, string> = {
  hoje: "Hoje",
  "7d": "7 dias",
  mes: "Este mês",
  "mes-passado": "Mês passado",
  "90d": "90 dias",
};

/** O período do painel de vendas, na URL (`?periodo=`): link comum, sem JavaScript, e a página já nasce com o período certo. */
export function SeletorDePeriodo({ periodo, idioma }: { periodo: ChaveDePeriodo; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <nav aria-label={t("Período do painel")} className="flex max-w-full flex-wrap gap-1">
      {PERIODOS_DO_PAINEL.map((chave) => {
        const ativo = chave === periodo;
        return (
          <Link
            key={chave}
            href={`/app/inicio?periodo=${chave}`}
            prefetch={false}
            aria-current={ativo ? "true" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center rounded-[8px] border px-3 text-[13px] font-medium transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
              ativo ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {t(ROTULOS[chave])}
          </Link>
        );
      })}
    </nav>
  );
}
