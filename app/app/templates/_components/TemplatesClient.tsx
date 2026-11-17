"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Funnel, Plus, PencilSimple, Star, Trash } from "@/lib/ui/icons";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApagarFunil, useFunis } from "@/hooks/inbox/useFunis";
import type { Funil } from "@/lib/inbox/atalhos/tipos";
import { duracaoEmTexto } from "@/lib/inbox/sequencias";
import { cn } from "@/lib/utils";
import { FunilEditor } from "./FunilEditor";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useMessageTemplates, type MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { KIND_ROTULO } from "@/lib/inbox/atalhos/rotulos";
import { TemplateFormDialog } from "./TemplateFormDialog";

const TEMPLATES_KEY = ["message-templates"];

type Aba = "mensagens" | "audios" | "midias" | "documentos" | "funis";
const ABAS: { id: Aba; rotulo: string }[] = [
  { id: "mensagens", rotulo: "Mensagens" },
  { id: "audios", rotulo: "Áudios" },
  { id: "midias", rotulo: "Imagens e vídeos" },
  { id: "documentos", rotulo: "Documentos" },
  { id: "funis", rotulo: "Funis" },
];

function daAba(aba: Aba, m: MessageTemplate): boolean {
  const k = m.media?.kind;
  if (aba === "mensagens") return !k;
  if (aba === "audios") return k === "audio";
  if (aba === "midias") return k === "image" || k === "video";
  if (aba === "documentos") return k === "document";
  return false;
}

interface Props {
  canShare: boolean;
  currentUserId: string;
}

export function TemplatesClient({ canShare, currentUserId }: Props) {
  const t = useT();
  const { data: templates, isLoading } = useMessageTemplates();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/message-templates/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MessageTemplate | null>(null);
  const [aba, setAba] = React.useState<Aba>("mensagens");
  const [busca, setBusca] = React.useState("");
  const funis = useFunis();
  const apagarFunil = useApagarFunil();
  const [funilAberto, setFunilAberto] = React.useState<Funil | "novo" | null>(null);
  const termo = busca.trim().toLowerCase();
  const visiveis = (templates ?? []).filter((m) => daAba(aba, m) && (!termo || m.title.toLowerCase().includes(termo) || m.body.toLowerCase().includes(termo)));

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (template: MessageTemplate) => {
    setEditing(template);
    setFormOpen(true);
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b" role="tablist">
        {ABAS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={aba === a.id}
            onClick={() => setAba(a.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              aba === a.id ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(a.rotulo)}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Buscar…")}
          className="h-9 rounded-md border bg-background px-3 text-sm sm:w-64"
        />
        {aba === "funis" ? (
          <Button type="button" onClick={() => setFunilAberto("novo")} className="w-full sm:w-auto">
            <Plus /> {t("Novo funil")}
          </Button>
        ) : (
          <Button type="button" onClick={openNew} className="w-full sm:w-auto">
            <Plus /> {t("Nova mensagem")}
          </Button>
        )}
      </div>
      {aba === "funis" ? (
        !funis.data?.length ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum funil ainda. Monte um com as mensagens prontas, na ordem e com a espera de cada uma.")}</p>
        ) : (
          <ul className="space-y-2">
            {funis.data
              .filter((f) => !termo || f.nome.toLowerCase().includes(termo) || f.atalho.includes(termo))
              .map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-4 rounded-md border bg-card p-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Funnel size={16} className="text-accent" />
                      <span className="font-medium">{f.nome}</span>
                      {f.favorito && <Star size={14} weight="fill" aria-label={t("Favorito")} />}
                      <Badge variant={f.compartilhado ? "default" : "neutral"}>{t(f.compartilhado ? "Compartilhado" : "Pessoal")}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      /{f.atalho} · {f.passos.length} {t(f.passos.length === 1 ? "mensagem" : "mensagens")} · {duracaoEmTexto(f.duracao_ms / 1000)}
                    </p>
                  </div>
                  {(!f.compartilhado || canShare) && (
                    <div className="flex shrink-0 gap-1">
                      <Button type="button" variant="ghost" size="icon" aria-label={t("Editar funil")} onClick={() => setFunilAberto(f)}>
                        <PencilSimple />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" aria-label={t("Excluir funil")}>
                            <Trash />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("Excluir este funil?")}</AlertDialogTitle>
                            <AlertDialogDescription>{t("As mensagens continuam salvas; só o funil sai.")}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                            <AlertDialogAction onClick={() => apagarFunil.mutate(f.id, { onSuccess: () => toast.success(t("Funil excluído.")), onError: showApiError })}>
                              {t("Excluir")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </li>
              ))}
          </ul>
        )
      ) : !visiveis.length ? (
        <p className="text-sm text-muted-foreground">{t("Nada aqui ainda.")}</p>
      ) : (
        <ul className="space-y-2">
          {visiveis.map((template) => {
            // Só quem pode editar/apagar pela RLS vê as ações: o dono do
            // pessoal, ou manager+ no compartilhado (owner null). Sem isto, um
            // agent veria botões que o backend rejeita (404/nada apagado).
            const canModify =
              template.owner_user_id === currentUserId ||
              (template.owner_user_id === null && canShare);
            return (
              <li
                key={template.id}
                className="flex items-start justify-between gap-4 rounded-md border bg-card p-4"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{template.title}</span>
                    {template.favorito && <Star size={14} weight="fill" aria-label={t("Favorito")} />}
                    <Badge variant={template.owner_user_id ? "neutral" : "default"}>
                      {t(template.owner_user_id ? "Pessoal" : "Compartilhado")}
                    </Badge>
                  </div>
                  {template.body ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{template.body}</p>
                  ) : null}
                  {template.media ? (
                    <div className="space-y-1.5 pt-1" data-testid="template-anexo">
                      <Badge variant="outline">{t(KIND_ROTULO[template.media.kind])}</Badge>
                      {/* O arquivo abre por /api/v1/media-library/[id]/file (302 para URL assinada,
                          após checar a org). preload="none"/lazy: a lista não baixa nada até o clique. */}
                      {template.media.kind === "audio" ? (
                        <audio
                          controls
                          preload="none"
                          className="h-9 w-full max-w-sm"
                          src={`/api/v1/media-library/${template.media.id}/file`}
                        />
                      ) : template.media.kind === "image" ? (
                        <img
                          loading="lazy"
                          alt={template.media.name}
                          className="max-h-28 rounded-md border object-contain"
                          src={`/api/v1/media-library/${template.media.id}/file`}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {canModify && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("Editar template")}
                      onClick={() => openEdit(template)}
                    >
                      <PencilSimple />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t("Excluir template")}
                        >
                          <Trash />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("Excluir este template?")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("Essa ação não pode ser desfeita.")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() =>
                              del.mutate(template.id, {
                                onSuccess: () => toast.success(t("Template excluído.")),
                              })
                            }
                          >
                            {t("Excluir")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={funilAberto !== null} onOpenChange={(v) => !v && setFunilAberto(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{funilAberto === "novo" ? t("Novo funil") : t("Editar funil")}</DialogTitle>
            <DialogDescription>{t("As mensagens saem em ordem, com a espera e o digitando/gravando de cada uma. Se o contato responder no meio, o resto para.")}</DialogDescription>
          </DialogHeader>
          {funilAberto !== null && (
            <FunilEditor
              key={funilAberto === "novo" ? "novo" : funilAberto.id}
              funil={funilAberto === "novo" ? null : funilAberto}
              modelos={templates ?? []}
              canShare={canShare}
              onSalvo={() => setFunilAberto(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      <TemplateFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        canShare={canShare}
        template={editing}
      />
    </div>
  );
}
