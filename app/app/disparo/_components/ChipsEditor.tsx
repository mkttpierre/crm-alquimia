"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { channelLabel, type ChannelSession } from "@/hooks/channels/useChannelSessions";
import { useAcaoNoChip, useRegistrarChip } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import type { ChipDaTela } from "@/lib/disparo-painel/esquemas";

/** Conexão pronta para mandar (o WhatsApp está de pé). */
export const conexaoConectada = (s: Pick<ChannelSession, "status">) => s.status === "WORKING";

const SAUDE: Record<ChipDaTela["saude"], string> = { verde: "Saúde boa", amarelo: "Atenção", vermelho: "Parado pela saúde" };
const ESTADO: Record<ChipDaTela["estado"], string> = { rampa: "Em rampa", ativo: "Maduro", pausado: "Pausado", desligado: "Fora do motor" };

/**
 * CHIPS — quais conexões o motor usa. Conexão conectada que ainda não está no motor ganha "Usar no motor"
 * (`POST /chips`; a de um chip retirado volta à mesma linha, no dia 1). Cada chip pode ser pausado, retomado
 * (`PATCH /chips/[id]`) ou retirado (`DELETE /chips/[id]`, que cancela a fila dele e não apaga a conexão).
 */
export function ChipsEditor({
  chips,
  conexoes,
  podeEditar,
  carregando = false,
  erro = false,
  onTentar,
}: {
  chips: ChipDaTela[];
  conexoes: ChannelSession[];
  podeEditar: boolean;
  /** Chips ou conexões ainda chegando: nada de "nenhum WhatsApp" antes da hora. */
  carregando?: boolean;
  erro?: boolean;
  onTentar?: () => void;
}) {
  const t = useT();
  const registrar = useRegistrarChip();
  const acao = useAcaoNoChip();
  const [confirmarRetirada, setConfirmarRetirada] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const noMotor = chips.filter((c) => c.estado !== "desligado");
  const usadas = new Set(noMotor.map((c) => c.channel_session_id).filter(Boolean));
  const livres = conexoes.filter((s) => conexaoConectada(s) && !usadas.has(s.id));

  async function executar(id: string, qual: "pausar" | "retomar" | "retirar") {
    setAviso(null);
    try {
      const r = await acao.mutateAsync({ id, acao: qual });
      if ("aviso" in r && r.aviso) setAviso(r.aviso);
      if (qual === "retirar" && "cancelados" in r) setAviso(`${t("Chip fora do motor.")} ${r.cancelados} ${t("envios pendentes cancelados.")}`);
    } catch (e) {
      setAviso(t(e instanceof Error ? e.message : "Não foi possível mudar o chip."));
    } finally {
      setConfirmarRetirada(null);
    }
  }

  return (
    <section id="chips" aria-labelledby="titulo-chips" className="min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <h2 id="titulo-chips" className="text-[15px] font-semibold">
        {t("Chips")}
      </h2>
      <p className="mt-[3px] text-[13px] text-muted-foreground">{t("Os WhatsApps que o motor usa para abrir conversa.")}</p>

      {aviso ? (
        <p role="status" className="mt-3 rounded-[8px] border border-border px-3 py-2 text-[12px]">
          {aviso}
        </p>
      ) : null}

      {carregando ? (
        <div className="mt-3 flex flex-col gap-2" aria-busy="true" role="status">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : erro ? (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
          <span className="text-error-fg">{t("Não foi possível ler os chips.")}</span>
          {onTentar ? (
            <Button type="button" variant="outline" size="sm" onClick={onTentar}>
              {t("Tentar de novo")}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
      <ul className="mt-3 flex flex-col divide-y divide-border">
        {noMotor.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" aria-label={c.nome}>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium">{c.nome}</p>
              <p className="text-[12px] text-muted-foreground">
                {t(ESTADO[c.estado])} · {t("dia")} {c.dia_rampa} {t("da rampa")} · {t(SAUDE[c.saude])}
              </p>
            </div>
            {podeEditar ? (
              <div className="flex flex-wrap gap-1.5">
                {c.estado === "pausado" ? (
                  <Button type="button" variant="outline" size="sm" disabled={acao.isPending} onClick={() => void executar(c.id, "retomar")}>
                    {t("Retomar")}
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" disabled={acao.isPending} onClick={() => void executar(c.id, "pausar")}>
                    {t("Pausar")}
                  </Button>
                )}
                {confirmarRetirada === c.id ? (
                  <Button type="button" variant="destructive" size="sm" disabled={acao.isPending} onClick={() => void executar(c.id, "retirar")}>
                    {t("Confirmar: tirar do motor")}
                  </Button>
                ) : (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmarRetirada(c.id)}>
                    {t("Retirar")}
                  </Button>
                )}
              </div>
            ) : null}
          </li>
        ))}
        {livres.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium">{channelLabel(s, t)}</p>
              <p className="text-[12px] text-muted-foreground">{t("Conectado, fora do motor")}</p>
            </div>
            {podeEditar ? (
              <Button type="button" size="sm" disabled={registrar.isPending} onClick={() => registrar.mutate(s.id)}>
                {t("Usar no motor")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {noMotor.length === 0 && livres.length === 0 ? (
        <p className="mt-3 rounded-[10px] border border-dashed border-border p-4 text-[13px] text-muted-foreground">
          {t("Nenhum WhatsApp conectado. Conecte um número e ele aparece aqui:")}{" "}
          <Link href="/app/connections" className="font-medium text-foreground underline underline-offset-4">
            {t("Conexões")}
          </Link>
        </p>
      ) : null}
        </>
      )}
      {registrar.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-error-fg">
          {t(registrar.error.message)}
        </p>
      ) : null}
    </section>
  );
}
