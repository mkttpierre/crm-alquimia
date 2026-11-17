"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { PERFIS, PERFIS_DE_RITMO, type PerfilDeRitmo } from "@/lib/disparo/perfis";
import { cn } from "@/lib/utils";

const PARA_QUEM: Record<PerfilDeRitmo, string> = {
  conservador: "Chip novo ou que já tomou bloqueio",
  recomendado: "O que roda hoje em operação real",
  acelerado: "Chip maduro com boa resposta",
};
const NOME: Record<PerfilDeRitmo, string> = { conservador: "Conservador", recomendado: "Recomendado", acelerado: "Acelerado" };
const NOTA: Record<PerfilDeRitmo, string> = { conservador: "mais devagar", recomendado: "o padrão do motor", acelerado: "mais risco" };

/**
 * ESCOLHA O RITMO — os três perfis (`lib/disparo/perfis.ts`). Os números de cada card saem de `PERFIS_DE_RITMO`.
 * Clicar num card só PRÉ-VISUALIZA (a simulação abaixo muda); aplicar é o botão "Usar este perfil".
 */
export function PerfisDeRitmo({
  atual,
  previa,
  onPrevia,
  onAplicar,
  aplicando,
  podeEditar,
}: {
  atual: PerfilDeRitmo | "personalizado";
  previa: PerfilDeRitmo | null;
  onPrevia: (p: PerfilDeRitmo | null) => void;
  onAplicar: (p: PerfilDeRitmo) => void;
  aplicando: boolean;
  podeEditar: boolean;
}) {
  const t = useT();
  const selecionado = previa ?? (atual === "personalizado" ? null : atual);
  // Sobre números personalizados, aplicar um perfil troca o trabalho de alguém: pede um segundo clique.
  const [confirmando, setConfirmando] = useState(false);

  return (
    <section aria-labelledby="titulo-perfis" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="titulo-perfis" className="text-[20px] font-semibold">
              {t("Escolha o ritmo")}
            </h2>
            {atual === "personalizado" ? (
              <span className="rounded-full border border-border px-2 py-1 text-[11px] leading-none font-medium">{t("Personalizado")}</span>
            ) : null}
          </div>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
            {t("Um perfil ajusta intervalos, rampa e pausas de uma vez. Dá para personalizar qualquer número depois.")}
          </p>
        </div>
        {previa && previa !== atual && podeEditar ? (
          <div className="flex flex-wrap items-center gap-2">
            {confirmando ? <span className="text-[12px] text-muted-foreground">{t("Isso troca seus números personalizados.")}</span> : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmando(false);
                onPrevia(null);
              }}
            >
              {t("Cancelar")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={aplicando}
              onClick={() => {
                if (atual === "personalizado" && !confirmando) return setConfirmando(true);
                setConfirmando(false);
                onAplicar(previa);
              }}
            >
              {aplicando ? t("Aplicando…") : confirmando ? t("Trocar mesmo") : t("Usar este perfil")}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 min-[861px]:grid-cols-3">
        {PERFIS.map((p) => {
          const r = PERFIS_DE_RITMO[p];
          const marcado = selecionado === p;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={marcado}
              onClick={() => onPrevia(p === atual ? null : p)}
              className={cn(
                "flex min-w-0 flex-col gap-2.5 rounded-[12px] border border-border bg-card p-[18px] text-left text-card-foreground transition-colors hover:border-muted-foreground",
                marcado && "border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]",
              )}
            >
              <span className={cn("font-mono text-[11px] leading-none font-semibold tracking-[0.08em] uppercase", marcado ? "text-foreground" : "text-muted-foreground")}>
                {t(NOME[p])}
              </span>
              <b className="text-[15px] font-semibold">{t(PARA_QUEM[p])}</b>
              <ul className="flex list-disc flex-col gap-1 pl-[18px] text-[13px] text-muted-foreground">
                <li>
                  {t("Rampa de")} {r.rampa![0]} {t("até")} {r.rampa!.at(-1)} {t("por dia")}
                </li>
                <li>
                  {r.intervaloNova!.min}–{r.intervaloNova!.max} {t("min entre conversas")}
                </li>
                <li>
                  {t("Pausa a cada")} {r.pausaACada!.min}–{r.pausaACada!.max}
                </li>
              </ul>
              <em className={cn("mt-auto text-[12px] not-italic", marcado ? "text-foreground" : "text-muted-foreground")}>
                {atual === p ? t("em uso") : t(NOTA[p])}
              </em>
            </button>
          );
        })}
      </div>
    </section>
  );
}
