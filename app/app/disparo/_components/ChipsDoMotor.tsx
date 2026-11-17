"use client";

import { Badge } from "@/components/ui/badge";
import { useChipsDoMotor } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import type { ChipDaTela } from "@/lib/disparo-painel/esquemas";
import { cn } from "@/lib/utils";

import { EstadoCarregando, EstadoComErro, EstadoVazio, useQuando } from "./apoio";
import { SaudeDoDia } from "./SaudeDoDia";

export function ChipsDoMotor({ ativa }: { ativa: boolean }) {
  const t = useT();
  const { data, distancia } = useQuando();
  const chips = useChipsDoMotor(ativa);

  const estado = (e: ChipDaTela["estado"]) =>
    ({
      rampa: { texto: t("Em rampa"), variante: "info" as const },
      ativo: { texto: t("Ativo"), variante: "success" as const },
      pausado: { texto: t("Pausado"), variante: "warning" as const },
      desligado: { texto: t("Desligado"), variante: "neutral" as const },
    })[e];
  const saude = (s: ChipDaTela["saude"]) =>
    ({
      verde: { texto: t("Saúde boa"), cor: "bg-success-fg" },
      amarelo: { texto: t("Saúde em atenção"), cor: "bg-warning-fg" },
      vermelho: { texto: t("Saúde ruim"), cor: "bg-error-fg" },
    })[s];

  if (chips.isLoading) return <EstadoCarregando linhas={3} />;
  if (chips.isError) return <EstadoComErro onTentar={() => void chips.refetch()} />;
  const itens = chips.data?.itens ?? [];
  if (itens.length === 0) {
    return (
      <EstadoVazio
        titulo={t("Nenhum chip no motor")}
        texto={t("Os chips são os números que mandam as mensagens. Quando houver um, o estado, a saúde e o dia da rampa aparecem aqui.")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <SaudeDoDia chips={itens} />
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="disparo-chips">
      {itens.map((c) => {
        const e = estado(c.estado);
        const s = saude(c.saude);
        const parte = c.teto_hoje > 0 ? Math.min(100, Math.round((c.envios_hoje / c.teto_hoje) * 100)) : 0;
        return (
          <li key={c.id} className="min-w-0 rounded-lg border border-border bg-surface-elevated px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 break-words text-sm font-semibold text-text">{c.nome}</h3>
              <Badge variant={e.variante}>{e.texto}</Badge>
            </div>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
              <span aria-hidden className={cn("size-2 rounded-full", s.cor)} />
              {s.texto}
              <span aria-hidden>·</span>
              {t("Dia")} {c.dia_rampa} {t("da rampa")}
            </p>
            <div className="mt-3">
              <div className="flex items-baseline justify-between text-xs text-text-muted">
                <span>{t("Saídas hoje")}</span>
                <span className="font-medium text-text">
                  {c.envios_hoje} / {c.teto_hoje}
                </span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-border"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={c.teto_hoje}
                aria-valuenow={c.envios_hoje}
                aria-label={t("Saídas hoje")}
              >
                <div className="h-full rounded-full bg-accent" style={{ width: `${parte}%` }} />
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="min-w-0">
                <dt className="text-text-muted">{t("Última vez")}</dt>
                <dd className="font-medium text-text">{c.ultimo_envio_em ? data(c.ultimo_envio_em) : "—"}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-text-muted">{t("Próxima vez")}</dt>
                <dd className="font-medium text-text">
                  {c.proximo_envio_em ? distancia(c.proximo_envio_em) : "—"}
                </dd>
              </div>
            </dl>
            {c.saude !== "verde" && c.saude_motivo ? (
              <p className="mt-2 break-words text-xs text-text-muted">{c.saude_motivo}</p>
            ) : null}
            <p className="mt-2 text-xs text-text-muted">
              {c.pausado_ate && new Date(c.pausado_ate) > new Date()
                ? `${t("Em pausa longa até")} ${data(c.pausado_ate)}. `
                : ""}
              {c.tem_canal ? t("Canal conectado.") : t("Sem canal conectado: só simula.")}
            </p>
          </li>
        );
      })}
    </ul>
    </div>
  );
}
