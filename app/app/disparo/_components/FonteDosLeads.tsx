"use client";

import Link from "next/link";

import { useAjusteDoMotor } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import type { EtapaDaTela } from "@/lib/disparo-painel/esquemas";

/**
 * DE ONDE VÊM OS LEADS — a etapa do funil de onde o motor tira quem recebe a abertura (`fonte_stage_id`),
 * com quantos leads há nela e o caminho para importar uma lista.
 */
export function FonteDosLeads({
  etapas,
  etapaAtual,
  etapaArquivada = null,
  leadsNaEtapa,
  podeEditar,
}: {
  etapas: EtapaDaTela[];
  etapaAtual: string | null;
  /** A etapa escolhida que foi arquivada: aparece desabilitada, para ninguém achar que nada está escolhido. */
  etapaArquivada?: { id: string; nome: string } | null;
  leadsNaEtapa: number | null;
  podeEditar: boolean;
}) {
  const t = useT();
  const ajuste = useAjusteDoMotor();
  const funis = [...new Map(etapas.map((e) => [e.funil_id, e.funil])).entries()];

  return (
    <section id="leads" aria-labelledby="titulo-leads" className="min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <h2 id="titulo-leads" className="text-[15px] font-semibold">
        {t("De onde vêm os leads")}
      </h2>
      <p className="mt-[3px] text-[13px] text-muted-foreground">{t("O motor abre conversa com os leads desta etapa.")}</p>

      {etapas.length === 0 && !etapaArquivada ? (
        <p className="mt-4 rounded-[10px] border border-dashed border-border p-4 text-[13px] text-muted-foreground">
          {t("Ainda não há funil com etapas. O motor precisa de uma etapa de onde tirar os leads.")}{" "}
          <Link href="/app/pipelines" className="font-medium text-foreground underline underline-offset-4">
            {t("Criar um funil")}
          </Link>
        </p>
      ) : null}

      <label htmlFor="etapa-de-origem" className="mt-4 block text-[12px] text-muted-foreground">
        {t("Funil e etapa")}
      </label>
      <select
        id="etapa-de-origem"
        className="mt-1 h-10 w-full rounded-[8px] border border-border bg-background px-2 text-[13px] disabled:opacity-60"
        value={etapaAtual ?? ""}
        disabled={!podeEditar || ajuste.isPending}
        onChange={(e) => ajuste.mutate({ fonte_stage_id: e.target.value || null })}
      >
        <option value="">{t("Escolha uma etapa")}</option>
        {etapaArquivada ? (
          <option value={etapaArquivada.id} disabled>
            {etapaArquivada.nome} ({t("arquivada")})
          </option>
        ) : null}
        {funis.map(([id, nome]) => (
          <optgroup key={id} label={nome}>
            {etapas
              .filter((e) => e.funil_id === id)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.nome}
                </option>
              ))}
          </optgroup>
        ))}
      </select>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span className="text-muted-foreground">
          {etapaAtual && leadsNaEtapa !== null ? `${leadsNaEtapa} ${leadsNaEtapa === 1 ? t("lead nesta etapa") : t("leads nesta etapa")}` : t("Nenhuma etapa escolhida.")}
        </span>
        <Link href="/app/kanban" className="font-medium underline underline-offset-4">
          {t("Importar CSV")}
        </Link>
      </div>
      {ajuste.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-error-fg">
          {t(ajuste.error.message)}
        </p>
      ) : null}
    </section>
  );
}
