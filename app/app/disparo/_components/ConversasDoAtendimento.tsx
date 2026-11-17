"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConversasDoMotor } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import { CaretLeft, CaretRight, ChatCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { EstadoCarregando, EstadoComErro, EstadoVazio, useQuando, useRotulos } from "./apoio";

type Filtro = "todas" | "operador" | "quentes";

export function ConversasDoAtendimento({ ativa }: { ativa: boolean }) {
  const t = useT();
  const { data, distancia } = useQuando();
  const { etapa } = useRotulos();
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [pagina, setPagina] = useState(1);
  const conversas = useConversasDoMotor(filtro, pagina, ativa);

  const filtros: { id: Filtro; texto: string }[] = [
    { id: "todas", texto: t("Todas") },
    { id: "operador", texto: t("Precisam de você") },
    { id: "quentes", texto: t("Quentes") },
  ];
  const total = conversas.data?.total ?? 0;
  const tamanho = conversas.data?.tamanho ?? 20;
  const paginas = Math.max(1, Math.ceil(total / tamanho));

  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label={t("Filtrar as conversas")} className="flex flex-wrap gap-1.5">
        {filtros.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filtro === f.id}
            onClick={() => {
              setFiltro(f.id);
              setPagina(1);
            }}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filtro === f.id
                ? "border-transparent bg-accent text-accent-fg"
                : "border-border bg-surface text-text-muted hover:text-text",
            )}
          >
            {f.texto}
          </button>
        ))}
      </div>

      {conversas.isLoading ? (
        <EstadoCarregando />
      ) : conversas.isError ? (
        <EstadoComErro onTentar={() => void conversas.refetch()} />
      ) : (conversas.data?.itens.length ?? 0) === 0 ? (
        <EstadoVazio
          titulo={t("Ninguém respondeu ainda")}
          texto={t("Quando um lead responde a uma mensagem do motor, a conversa aparece aqui com a etapa, a última leitura e o aviso se precisa de você.")}
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="disparo-conversas">
          {conversas.data!.itens.map((c) => (
            <li
              key={c.lead_id}
              className="grid min-w-0 gap-2 rounded-lg border border-border bg-surface-elevated px-3 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,5fr)_minmax(0,2fr)] md:items-start md:gap-4"
            >
              <div className="min-w-0">
                <Link
                  href={`/app/leads/${c.lead_id}`}
                  className="block truncate text-sm font-semibold text-text hover:text-accent hover:underline"
                >
                  {c.lead_nome}
                </Link>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant="neutral">{etapa(c.etapa)}</Badge>
                  {c.quente ? <Badge variant="warning">{t("Quente")}</Badge> : null}
                  {c.precisa_operador ? <Badge variant="error">{t("Precisa de você")}</Badge> : null}
                </div>
              </div>
              <div className="min-w-0">
                {c.ultima_leitura ? (
                  <>
                    <p className="line-clamp-2 break-words text-sm text-text">“{c.ultima_leitura.texto}”</p>
                    <p className="mt-1 break-words text-xs text-text-muted">
                      {t("Última leitura")} {distancia(c.ultima_leitura.em)}
                      {c.ultima_leitura.decisao ? ` · ${c.ultima_leitura.decisao}` : ""}
                      {c.ultima_leitura.irritada ? ` · ${t("irritado")}` : ""}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-text-muted">{t("Sem leitura registrada.")}</p>
                )}
                {c.motivo_operador ? <p className="mt-1 break-words text-xs text-text-muted">{c.motivo_operador}</p> : null}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 md:flex-col md:items-end md:gap-1">
                <p className="text-xs text-text-muted">{data(c.atualizada_em)}</p>
                {c.conversation_id ? (
                  <Link
                    href={`/app/inbox?id=${c.conversation_id}`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                  >
                    <ChatCircle size={14} aria-hidden /> {t("Abrir conversa")}
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {total > tamanho ? (
        <nav aria-label={t("Páginas das conversas")} className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={pagina <= 1 || conversas.isFetching}
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
            disabled={pagina >= paginas || conversas.isFetching}
            onClick={() => setPagina((p) => p + 1)}
          >
            {t("Próxima")} <CaretRight size={14} aria-hidden />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
