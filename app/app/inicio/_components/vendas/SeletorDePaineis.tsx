import { escolherPainelDoInicio } from "@/app/actions/inicio/escolherPainel";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { PainelDoInicio } from "@/lib/inicio/painel";
import { cn } from "@/lib/utils";

const OPCOES: ReadonlyArray<{ painel: PainelDoInicio; rotulo: string }> = [
  { painel: "atendimento", rotulo: "Atendimento e envios" },
  { painel: "vendas", rotulo: "Vendas e faturamento" },
];

/**
 * O seletor de painéis do topo do Início. Só aparece para `manager`+ (quem decide é a página).
 *
 * Cada opção é um botão de formulário que chama a Server Action `escolherPainelDoInicio`: funciona sem JavaScript, e a página
 * já volta desenhada com o painel escolhido (o cookie é lido no servidor, então nada troca depois da hidratação).
 */
export function SeletorDePaineis({ painel, idioma }: { painel: PainelDoInicio; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <form action={escolherPainelDoInicio} aria-label={t("Escolher o painel do Início")}>
      <div role="group" className="inline-flex max-w-full flex-wrap gap-1 rounded-[10px] border border-border bg-card p-1">
        {OPCOES.map((o) => {
          const ativo = o.painel === painel;
          return (
            <button
              key={o.painel}
              type="submit"
              name="painel"
              value={o.painel}
              aria-pressed={ativo}
              className={cn(
                "min-h-9 rounded-[8px] px-3 text-[13px] font-medium transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
                ativo ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(o.rotulo)}
            </button>
          );
        })}
      </div>
    </form>
  );
}
