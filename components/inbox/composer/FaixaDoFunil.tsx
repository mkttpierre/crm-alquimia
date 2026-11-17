"use client";
/** Faixa acima da caixa de conversa enquanto um funil do operador está saindo: "Funil · 2 de 7 · próxima às 14:32". */
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { cancelarFunilDaConversa, useAndamentoDoFunil } from "@/hooks/inbox/useSequenciaComando";
import type { Funil } from "@/lib/inbox/atalhos/tipos";
import { Funnel } from "@/lib/ui/icons";

const horaNoIdioma = (iso: string, tag: string) =>
  new Date(iso).toLocaleTimeString(tag, { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

export function FaixaDoFunil({ conversationId, funis }: { conversationId: string; funis: Funil[] }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { data } = useAndamentoDoFunil(conversationId);
  if (!data?.em_andamento) return null;
  const nome = funis.find((f) => f.atalho.replaceAll("-", "_") === data.tipo)?.nome ?? t("Funil");
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 py-1.5 text-xs text-accent">
      <Funnel size={14} className="shrink-0" />
      <span className="truncate font-medium">{nome}</span>
      <span>
        · {data.enviadas} {t("de")} {data.total}
        {data.proxima_em ? ` · ${t("próxima às")} ${horaNoIdioma(data.proxima_em, tagDoIdioma)}` : ""}
      </span>
      <button type="button" onClick={() => void cancelarFunilDaConversa(conversationId)} className="ml-auto rounded-md px-2 py-0.5 font-medium hover:bg-accent/10">
        {t("Cancelar")}
      </button>
    </div>
  );
}
