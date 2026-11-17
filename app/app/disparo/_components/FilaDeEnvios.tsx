"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFilaDoMotor } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import { FILTROS_DA_FILA, type FiltroDaFila } from "@/lib/disparo-painel/esquemas";
import { CaretLeft, CaretRight, Paperclip } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { EstadoCarregando, EstadoComErro, EstadoVazio, useQuando, useRotulos } from "./apoio";

export function FilaDeEnvios({ ativa }: { ativa: boolean }) {
  const t = useT();
  const { data, distancia } = useQuando();
  const { estadoDoEnvio, passo, origem } = useRotulos();
  const [filtro, setFiltro] = useState<FiltroDaFila>("fila");
  const [pagina, setPagina] = useState(1);
  const fila = useFilaDoMotor(filtro, pagina, ativa);

  const nomeDoFiltro = (f: FiltroDaFila) => (f === "fila" ? t("Pendentes e simulados") : estadoDoEnvio(f).texto);
  const total = fila.data?.total ?? 0;
  const tamanho = fila.data?.tamanho ?? 20;
  const paginas = Math.max(1, Math.ceil(total / tamanho));

  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label={t("Filtrar a fila por estado")} className="flex flex-wrap gap-1.5">
        {FILTROS_DA_FILA.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filtro === f}
            onClick={() => {
              setFiltro(f);
              setPagina(1);
            }}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filtro === f
                ? "border-transparent bg-accent text-accent-fg"
                : "border-border bg-surface text-text-muted hover:text-text",
            )}
          >
            {nomeDoFiltro(f)}
          </button>
        ))}
      </div>

      {fila.isLoading ? (
        <EstadoCarregando />
      ) : fila.isError ? (
        <EstadoComErro onTentar={() => void fila.refetch()} />
      ) : (fila.data?.itens.length ?? 0) === 0 ? (
        <EstadoVazio
          titulo={t("Nada na fila neste filtro")}
          texto={t("Quando o motor planejar uma mensagem, ela aparece aqui com o lead, o passo da cadência e o horário previsto.")}
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="disparo-fila">
          {fila.data!.itens.map((e) => {
            const estado = estadoDoEnvio(e.estado);
            const quando = e.enviado_em ?? e.enviar_apos;
            return (
              <li
                key={e.id}
                className="grid min-w-0 gap-2 rounded-lg border border-border bg-surface-elevated px-3 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,5fr)_minmax(0,2fr)] md:items-start md:gap-4"
              >
                <div className="min-w-0">
                  {e.lead ? (
                    <Link
                      href={`/app/leads/${e.lead.id}`}
                      className="block truncate text-sm font-semibold text-text hover:text-accent hover:underline"
                    >
                      {e.lead.nome}
                    </Link>
                  ) : (
                    <span className="text-sm text-text-muted">—</span>
                  )}
                  <p className="mt-0.5 text-xs text-text-muted">
                    {passo(e.tipo)}
                    {e.passo ? ` · ${e.passo.ordem}/${e.passo.total}` : ""}
                  </p>
                  <p className="text-xs text-text-muted">
                    {origem(e.origem)}
                    {e.chip ? ` · ${e.chip.nome}` : ""}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="line-clamp-3 break-words text-sm text-text">
                    {e.texto || <span className="text-text-muted">{t("Sem texto (passo manual).")}</span>}
                  </p>
                  {e.tem_midia ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-text-muted">
                      <Paperclip size={12} aria-hidden /> {t("Com anexo")}
                    </p>
                  ) : null}
                  {e.motivo ? <p className="mt-1 break-words text-xs text-text-muted">{e.motivo}</p> : null}
                </div>
                <div className="flex min-w-0 items-center gap-2 md:flex-col md:items-end md:gap-1">
                  <Badge variant={estado.variante}>{estado.texto}</Badge>
                  <p className="text-xs text-text-muted md:text-right">
                    {e.enviado_em ? t("Saiu") : t("Previsto")} {data(quando)}
                    <span className="block">{distancia(quando)}</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {total > tamanho ? (
        <nav aria-label={t("Páginas da fila")} className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={pagina <= 1 || fila.isFetching}
            onClick={() => setPagina((p) => Math.max(1, p - 1))}
          >
            <CaretLeft size={14} aria-hidden /> {t("Anterior")}
          </Button>
          <span className="text-xs text-text-muted" aria-live="polite">
            {pagina} / {paginas} · {total} {t("itens")}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={pagina >= paginas || fila.isFetching}
            onClick={() => setPagina((p) => p + 1)}
          >
            {t("Próxima")} <CaretRight size={14} aria-hidden />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
