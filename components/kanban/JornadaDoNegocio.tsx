"use client";
import { useT } from "@/hooks/i18n/useT";

export function JornadaDoNegocio({ stages, stageId }: { stages: Array<{ id: string; name: string }>; stageId: string }) {
  const t = useT();
  const atual = stages.findIndex((stage) => stage.id === stageId);
  return <ol aria-label={t("Jornada do negócio")} className="flex gap-2 overflow-x-auto rounded-lg border border-border bg-surface p-4">
    {stages.map((stage, i) => <li key={stage.id} aria-current={i === atual ? "step" : undefined} className={`flex min-w-24 flex-1 flex-col gap-2 text-xs ${i === atual ? "font-semibold text-accent" : "text-text-muted"}`}>
      <span className={`h-1 rounded-full ${i === atual ? "bg-accent" : "bg-border"}`} />{stage.name}
    </li>)}
  </ol>;
}
