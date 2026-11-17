"use client";

/**
 * A personalização que a barra lateral desenha, com ESTADO OTIMISTA.
 *
 * `base` é o que o servidor entregou (`activeOrg.barra`). Ao "Concluir" o modo
 * personalização, a barra já passa a mostrar o que a pessoa montou (`otimista`),
 * sem esperar a gravação, e as Server Actions rodam em seguida. Cada parte volta
 * atrás sozinha se a sua action falhar (a ordem e os ocultos pela
 * `updateMinhaBarra`, os nomes pela `updateNomesDaBarra`) e a recusa aparece num
 * aviso. Se alguma gravou, `router.refresh()` traz a barra nova do servidor; o
 * otimista só vale enquanto `base` é o mesmo de quando foi montado (a assinatura de
 * `base` vai junto com ele, então não precisa de efeito para descartá-lo).
 */
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { updateMinhaBarra } from "@/app/actions/settings/updateMinhaBarra";
import { updateNomesDaBarra } from "@/app/actions/settings/updateNomesDaBarra";
import { useT } from "@/hooks/i18n/useT";
import type {
  NomesDaBarra,
  PersonalizacaoDaBarra,
  PreferenciasDaBarra,
} from "@/lib/navigation/personalizar";
import {
  ERRO_DA_BARRA_PESSOAL,
  ERRO_DOS_NOMES,
  ERRO_GENERICO,
} from "@/lib/navigation/personalizar-edicao";

/** O que o modo personalização mudou. Parte ausente = não mudou, e a action dela não roda. */
export interface PartesDaBarra {
  preferencias?: PreferenciasDaBarra;
  nomes?: NomesDaBarra;
}

export function usePersonalizacaoDaBarra(base: PersonalizacaoDaBarra | undefined) {
  const t = useT();
  const router = useRouter();
  const [otimista, setOtimista] = useState<{ sobre: string; partes: PartesDaBarra } | null>(null);

  // Chegou barra nova do servidor (o `router.refresh()` de baixo, ou uma gravação
  // pela tela de Personalizar): a assinatura muda e o otimista cumpriu o papel dele.
  const assinatura = JSON.stringify(base ?? null);
  const vigente = otimista?.sobre === assinatura ? otimista.partes : null;

  const personalizacao: PersonalizacaoDaBarra = {
    preferencias: vigente?.preferencias ?? base?.preferencias,
    nomes: vigente?.nomes ?? base?.nomes,
  };

  const salvar = useCallback(
    async (mudou: PartesDaBarra) => {
      if (!mudou.preferencias && !mudou.nomes) return;
      setOtimista({ sobre: assinatura, partes: mudou });
      let algumaGravou = false;

      async function uma(
        parte: keyof PartesDaBarra,
        enviar: () => Promise<{ ok: true } | { ok: false; error: string }>,
        erros: Record<string, string>,
        sucesso: string,
      ) {
        try {
          const r = await enviar();
          if (r.ok) {
            algumaGravou = true;
            toast.success(t(sucesso));
            return;
          }
          toast.error(t(erros[r.error] ?? ERRO_GENERICO));
        } catch {
          toast.error(t(ERRO_GENERICO));
        }
        // Falhou: só esta parte volta ao que o servidor tem.
        setOtimista((atual) =>
          atual ? { ...atual, partes: { ...atual.partes, [parte]: undefined } } : atual,
        );
      }

      if (mudou.preferencias) {
        const p = mudou.preferencias;
        await uma(
          "preferencias",
          () => updateMinhaBarra(p),
          ERRO_DA_BARRA_PESSOAL,
          "Sua barra foi salva.",
        );
      }
      if (mudou.nomes) {
        const n = mudou.nomes;
        await uma("nomes", () => updateNomesDaBarra(n), ERRO_DOS_NOMES, "Os nomes foram salvos.");
      }
      if (algumaGravou) router.refresh();
    },
    [assinatura, router, t],
  );

  return { personalizacao, salvar };
}
