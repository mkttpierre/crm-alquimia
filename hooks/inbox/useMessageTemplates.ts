"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** Anexo da resposta rápida: um item da biblioteca de mídia da organização (migration 0240). */
export interface MessageTemplateMedia {
  id: string;
  kind: "audio" | "image" | "video" | "document";
  name: string;
  mime: string;
  size_bytes: number;
}

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  owner_user_id: string | null;
  media_id?: string | null;
  media?: MessageTemplateMedia | null;
  /** Estrela da barra de atalhos (migration 0248). */
  favorito?: boolean;
  /** Palavras que a barra do chat também casa (migration 0248). */
  palavras_chave?: string[];
}

/** Onda 5: templates de script (pessoais + compartilhados) para o slash-menu do composer. */
export function useMessageTemplates() {
  const podeConsultar = usePermission("message-templates.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: ["message-templates"],
    queryFn: async () => apiClient.get<{ data: MessageTemplate[] }>("/api/v1/message-templates"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}
