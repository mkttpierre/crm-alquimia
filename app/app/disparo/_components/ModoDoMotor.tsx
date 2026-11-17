"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAjusteDoMotor } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import type { EstadoDoMotor } from "@/lib/disparo-painel/esquemas";
import { cn } from "@/lib/utils";

/** A frase que o admin digita para ligar o envio real. Não se traduz: é uma senha de intenção, igual em toda tela. */
export const FRASE_DO_ENVIO_REAL = "ENVIAR DE VERDADE";
/** A segunda chave, fora do banco: a linha exata do `.env` do servidor. */
export const LINHA_DO_ENV = "DISPARO_REAL_LIBERADO=sim";

/**
 * MODO — Simulado (o padrão: nada sai, a fila só se desenha) ou Real. Só o admin troca, e o Real pede a frase.
 * Mesmo com o Real escolhido, nada sai sem a segunda chave no servidor; faltando ela, a tela diz a linha do `.env`.
 */
export function ModoDoMotor({
  modo,
  chaveDoServidor,
  podeTrocar,
  estado = null,
}: {
  modo: "simulado" | "real";
  /** Segunda chave no servidor; null = o `/estado` não respondeu, então a tela não afirma nada sobre ela. */
  chaveDoServidor: boolean | null;
  podeTrocar: boolean;
  /** O `/estado` do motor, para explicar a trava dupla, a lista de destinos e os chips sem canal. */
  estado?: EstadoDoMotor | null;
}) {
  const t = useT();
  const ajuste = useAjusteDoMotor();
  const [pedindoReal, setPedindoReal] = useState(false);
  const [frase, setFrase] = useState("");

  return (
    <section id="modo" aria-labelledby="titulo-modo" className="min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <h2 id="titulo-modo" className="text-[15px] font-semibold">
        {t("Modo")}
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-2 min-[521px]:grid-cols-2">
        <OpcaoDeModo marcada={modo === "simulado"} titulo={t("Simulado")} texto={t("Nada sai. O motor monta a fila como se enviasse, para você conferir.")} />
        <OpcaoDeModo marcada={modo === "real"} titulo={t("Real")} texto={t("As mensagens saem pelos chips, no ritmo escolhido.")} />
      </div>

      {estado?.modo_efetivo === "real" ? (
        <div role="status" className="mt-3 flex flex-col gap-1 rounded-[10px] border border-border p-3 text-[13px]">
          <p>{t("Envio real valendo: as duas chaves estão ligadas (o modo Real aqui e a liberação no servidor), e as mensagens saem de verdade.")}</p>
          {estado.destinos_permitidos !== null ? (
            <p className="text-muted-foreground">
              {t("O servidor só deixa sair para")} {estado.destinos_permitidos} {estado.destinos_permitidos === 1 ? t("número") : t("números")} {t("(lista de teste do servidor); o resto fica simulado.")}
            </p>
          ) : null}
          {estado.chips.sem_canal > 0 ? (
            <p className="text-muted-foreground">
              {estado.chips.sem_canal} {estado.chips.sem_canal === 1 ? t("chip sem conexão só simula.") : t("chips sem conexão só simulam.")}
            </p>
          ) : null}
        </div>
      ) : null}

      {modo === "real" && chaveDoServidor === false ? (
        <div role="status" className="mt-3 rounded-[10px] border border-border p-3 text-[13px]">
          <p>{t("O modo real está escolhido, mas o servidor ainda não libera o envio. Ponha esta linha no .env do servidor e reinicie o app:")}</p>
          <code className="mt-2 block w-fit rounded-[6px] border border-border px-2 py-1 font-mono text-[12px]">{LINHA_DO_ENV}</code>
        </div>
      ) : null}

      {!podeTrocar ? (
        <p className="mt-3 text-[12px] text-muted-foreground">{t("Só quem administra a organização troca o modo.")}</p>
      ) : modo === "real" ? (
        <Button type="button" variant="outline" size="sm" className="mt-3" disabled={ajuste.isPending} onClick={() => ajuste.mutate({ modo: "simulado" })}>
          {t("Voltar ao simulado")}
        </Button>
      ) : pedindoReal ? (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor="frase-envio-real" className="text-[13px]">
            {t("Para ligar o envio real, digite")} <b className="font-mono">{FRASE_DO_ENVIO_REAL}</b>
          </label>
          <Input id="frase-envio-real" className="h-9 max-w-xs font-mono" value={frase} autoComplete="off" onChange={(e) => setFrase(e.target.value)} />
          {chaveDoServidor === false ? (
            <p className="text-[12px] text-muted-foreground">
              {t("O servidor também precisa desta linha no .env:")} <code className="font-mono">{LINHA_DO_ENV}</code>
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => (setPedindoReal(false), setFrase(""))}>
              {t("Cancelar")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={frase !== FRASE_DO_ENVIO_REAL || ajuste.isPending}
              onClick={() => ajuste.mutate({ modo: "real" }, { onSuccess: () => (setPedindoReal(false), setFrase("")) })}
            >
              {t("Ligar o envio real")}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setPedindoReal(true)}>
          {t("Mudar para o envio real")}
        </Button>
      )}
      {ajuste.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-error-fg">
          {t(ajuste.error.message)}
        </p>
      ) : null}
    </section>
  );
}

function OpcaoDeModo({ marcada, titulo, texto }: { marcada: boolean; titulo: string; texto: string }) {
  return (
    <div aria-current={marcada ? "true" : undefined} className={cn("rounded-[10px] border border-border p-3", marcada && "border-foreground")}>
      <p className="text-[13px] font-medium">{titulo}</p>
      <p className="text-[12px] text-muted-foreground">{texto}</p>
    </div>
  );
}
