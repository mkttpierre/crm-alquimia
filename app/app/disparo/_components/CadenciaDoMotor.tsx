"use client";

import { Button } from "@/components/ui/button";
import { useAjusteDoMotor } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import { CADENCIAS } from "@/lib/disparo/cadencia";
import { cn } from "@/lib/utils";

/** Nome e explicação de cada cadência na tela (o motor só conhece o id). */
export const NOME_DA_CADENCIA: Record<string, { nome: string; texto: string }> = {
  reativacao_3_toques: { nome: "Reativação em 3 toques", texto: "Abertura, um toque 2 dias depois e o último 5 dias depois (dias de envio)." },
  prospeccao_14_dias: { nome: "Prospecção em 14 dias", texto: "Mensagens nos dias 1, 2, 7 e 14; áudio no dia 4 e ligação no dia 10 viram tarefa." },
};

/**
 * CADÊNCIA — quais toques o lead recebe depois da abertura, e quando. O desenho mostra os dias; passo que não sai
 * pelo motor (áudio, ligação) aparece tracejado: vira tarefa para o operador, nunca é enviado.
 */
export function CadenciaDoMotor({ atual, podeEditar }: { atual: string; podeEditar: boolean }) {
  const t = useT();
  const ajuste = useAjusteDoMotor();

  return (
    <section id="cadencia" aria-labelledby="titulo-cadencia" className="min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <h2 id="titulo-cadencia" className="text-[15px] font-semibold">
        {t("Cadência")}
      </h2>
      <p className="mt-[3px] text-[13px] text-muted-foreground">{t("O que o lead recebe depois da primeira mensagem.")}</p>
      <div className="mt-3 flex flex-col gap-3">
        {Object.values(CADENCIAS).map((c) => {
          const marcada = c.id === atual;
          const nome = NOME_DA_CADENCIA[c.id];
          return (
            <div key={c.id} className={cn("rounded-[10px] border border-border p-3", marcada && "border-foreground")}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{nome ? t(nome.nome) : c.id}</p>
                  {nome ? <p className="text-[12px] text-muted-foreground">{t(nome.texto)}</p> : null}
                </div>
                {marcada ? (
                  <span className="rounded-full border border-border px-2 py-1 text-[11px] leading-none">{t("em uso")}</span>
                ) : podeEditar ? (
                  <Button type="button" variant="outline" size="sm" disabled={ajuste.isPending} onClick={() => ajuste.mutate({ cadencia: c.id })}>
                    {t("Usar esta cadência")}
                  </Button>
                ) : null}
              </div>
              <ol className="mt-3 flex flex-wrap gap-1.5" aria-label={t("Dias da cadência")}>
                {c.passos.map((p) => (
                  <li
                    key={p.tipo}
                    title={p.automatico ? t("enviado pelo motor") : t("vira tarefa, não é enviado")}
                    className={cn(
                      "rounded-[6px] border px-2 py-1.5 font-mono text-[11px] leading-none",
                      p.automatico ? "border-border" : "border-dashed border-muted-foreground text-muted-foreground",
                    )}
                  >
                    {t("Dia")} {p.dia}
                    {p.automatico ? "" : ` · ${p.lembrete === "audio" ? t("áudio") : t("ligação")}`}
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
      {ajuste.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-error-fg">
          {t(ajuste.error.message)}
        </p>
      ) : null}
    </section>
  );
}
