"use client";
import { useMemo } from "react";

import { useFunis } from "@/hooks/inbox/useFunis";
import { useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import { itensDeAtalho } from "@/lib/inbox/atalhos/itens";

/** Tudo o que a barra de atalhos do chat pode mostrar: funis + mensagens/áudios/mídias/documentos. */
export function useAtalhos() {
  const modelos = useMessageTemplates();
  const funis = useFunis();
  const itens = useMemo(() => itensDeAtalho(modelos.data ?? [], funis.data ?? []), [modelos.data, funis.data]);
  return { itens, modelos: modelos.data ?? [], funis: funis.data ?? [], carregando: modelos.isLoading || funis.isLoading };
}
