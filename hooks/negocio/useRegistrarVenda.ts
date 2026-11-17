"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";
import type { VendaRegistrada } from "@/lib/negocio/registrar-venda";
import type { VendaCriarInput } from "@/lib/negocio/venda";

/**
 * Registrar venda: POST /api/v1/sales com `Idempotency-Key`.
 *
 * A chave pertence à INTENÇÃO (o conteúdo da venda), não ao clique: o mesmo conteúdo reenviado (duplo clique, retry depois de
 * timeout) reaproveita a chave e o servidor devolve a mesma venda; conteúdo diferente gera chave nova. Depois de um sucesso
 * a chave é descartada, para a próxima venda igual (recompra do mesmo plano) não ser confundida com esta.
 *
 * Se o servidor recusar porque o negócio mostrado deixou de ser o alvo real (409, `motivo: alvo_mudou`), a prévia é recarregada
 * (o quadro mostra o negócio de agora e avisa); nada foi gravado.
 *
 * Ao concluir, invalida o que mostra venda: faturamento, itens do negócio, compras do contato, quadro, contato e timeline.
 */
export function useRegistrarVenda(aoConcluir?: (venda: VendaRegistrada) => void) {
  const qc = useQueryClient();
  const intencao = useRef<{ impressao: string; chave: string } | null>(null);

  return useMutation({
    mutationFn: async (corpo: VendaCriarInput) => {
      const impressao = JSON.stringify(corpo);
      if (!intencao.current || intencao.current.impressao !== impressao) {
        intencao.current = { impressao, chave: randomId() };
      }
      const r = await apiClient.post<{ data: VendaRegistrada }>("/api/v1/sales", corpo, { idempotencyKey: intencao.current.chave });
      return r.data;
    },
    onSuccess: (venda) => {
      intencao.current = null;
      for (const chave of [["revenue"], ["lead-items"], ["purchase-history"], ["board"], ["contact"], ["contacts"], ["timeline"], ["contato-vinculos"]]) {
        void qc.invalidateQueries({ queryKey: chave });
      }
      aoConcluir?.(venda);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.details?.motivo === "alvo_mudou") void qc.invalidateQueries({ queryKey: ["sale-target"] });
      showApiError(err);
    },
  });
}
