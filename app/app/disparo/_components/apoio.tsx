"use client";

import { format, formatDistanceToNowStrict } from "date-fns";
import { useCallback } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { EstadoDaFila } from "@/lib/disparo-painel/esquemas";
import { minutosParaHora } from "@/lib/disparo-painel/estado";
import { Warning } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";

/** Datas e "daqui a pouco" no idioma da sessão. Texto vindo do servidor já é ISO. */
export function useQuando() {
  const locale = useLocaleDeData();
  const data = useCallback(
    (iso: string | null | undefined) => (iso ? format(new Date(iso), "dd/MM HH:mm", { locale }) : "—"),
    [locale],
  );
  const hora = useCallback(
    (iso: string | null | undefined) => (iso ? format(new Date(iso), "HH:mm", { locale }) : "—"),
    [locale],
  );
  const distancia = useCallback(
    (iso: string | null | undefined) =>
      iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale }) : "—",
    [locale],
  );
  return { data, hora, distancia };
}

/** "08:00–12:00 · 13:00–16:00" ou o traço, para dia sem envio. */
export function textoDaJanela(blocos: { inicio: number; fim: number }[]): string {
  return blocos.length === 0
    ? "—"
    : blocos.map((b) => `${minutosParaHora(b.inicio)}–${minutosParaHora(b.fim)}`).join(" · ");
}

export function useRotulos() {
  const t = useT();
  const estadoDoEnvio = (e: EstadoDaFila): { texto: string; variante: "neutral" | "info" | "success" | "warning" | "error" } => {
    switch (e) {
      case "pendente":
        return { texto: t("Pendente"), variante: "warning" };
      case "enviando":
        return { texto: t("Enviando"), variante: "info" };
      case "simulado":
        return { texto: t("Simulado"), variante: "info" };
      case "enviado":
        return { texto: t("Enviado"), variante: "success" };
      case "cancelado":
        return { texto: t("Cancelado"), variante: "neutral" };
      case "falhou":
        return { texto: t("Falhou"), variante: "error" };
    }
  };
  /** Nome do passo da cadência. `tipo:grupo` mostra só o passo. */
  const passo = (tipo: string): string => {
    const base = tipo.split(":")[0] ?? tipo;
    switch (base) {
      case "abertura":
        return t("Abertura");
      case "toque_2":
        return t("Toque 2");
      case "toque_3":
        return t("Toque 3");
      case "d2":
        return t("Dia 2");
      case "d4":
        return t("Dia 4 · lembrete de áudio");
      case "d7":
        return t("Dia 7");
      case "d10":
        return t("Dia 10 · lembrete de ligação");
      case "d14":
        return t("Dia 14");
      case "resposta":
        return t("Resposta");
      default:
        return base;
    }
  };
  const origem = (o: string): string => {
    switch (o) {
      case "motor":
        return t("Cadência");
      case "auto":
        return t("Resposta automática");
      case "operador":
        return t("Operador");
      case "lembrete":
        return t("Lembrete ao operador");
      default:
        return o;
    }
  };
  const etapa = (e: string): string => {
    switch (e) {
      case "respondeu":
        return t("Respondeu");
      case "qualificando":
        return t("Qualificando");
      case "pronto_fechar":
        return t("Pronto para fechar");
      case "fechado":
        return t("Fechado");
      case "perdido":
        return t("Perdido");
      case "nao_contatar":
        return t("Não contatar");
      default:
        return e;
    }
  };
  return { estadoDoEnvio, passo, origem, etapa };
}

export function EstadoCarregando({ linhas = 4 }: { linhas?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" role="status">
      {Array.from({ length: linhas }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function EstadoVazio({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center">
      <p className="text-sm font-medium text-text">{titulo}</p>
      <p className="max-w-md text-sm text-text-muted">{texto}</p>
    </div>
  );
}

export function EstadoComErro({ onTentar }: { onTentar: () => void }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-border bg-error-bg px-4 py-8 text-center"
    >
      <Warning size={22} className="text-error-fg" aria-hidden />
      <p className="text-sm text-error-fg">{t("Não foi possível carregar esta parte do painel.")}</p>
      <Button size="sm" variant="outline" onClick={onTentar}>
        {t("Tentar de novo")}
      </Button>
    </div>
  );
}

