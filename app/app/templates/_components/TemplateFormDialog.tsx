"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { MessageTemplate, MessageTemplateMedia } from "@/hooks/inbox/useMessageTemplates";
import { KIND_ROTULO } from "@/lib/inbox/atalhos/rotulos";

const TEMPLATES_KEY = ["message-templates"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canShare: boolean;
  template?: MessageTemplate | null;
}

interface CreateInput {
  title: string;
  body: string;
  shortcut?: string;
  shared?: boolean;
  favorito: boolean;
  palavras_chave: string[];
  media_id: string | null;
}

interface UpdateInput {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  favorito: boolean;
  palavras_chave: string[];
  media_id: string | null;
}

/** Sobe o arquivo para a biblioteca de mídia da organização (POST /api/v1/media-library). */
async function subirArquivo(arquivo: File): Promise<MessageTemplateMedia> {
  const form = new FormData();
  form.set("file", arquivo);
  const res = await fetch("/api/v1/media-library", { method: "POST", body: form });
  const corpo = (await res.json().catch(() => null)) as { data?: MessageTemplateMedia; error?: { message?: string } } | null;
  if (!res.ok || !corpo?.data) throw new Error(corpo?.error?.message ?? `Falha ao subir o arquivo (${res.status}).`);
  return corpo.data;
}

export function TemplateFormDialog({ open, onOpenChange, canShare, template }: Props) {
  const t = useT();
  const isEdit = !!template;
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [shortcut, setShortcut] = React.useState("");
  const [shared, setShared] = React.useState(false);
  const [favorito, setFavorito] = React.useState(false);
  const [palavras, setPalavras] = React.useState("");
  const [midia, setMidia] = React.useState<MessageTemplateMedia | null>(null);
  const [subindo, setSubindo] = React.useState(false);

  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async (input: CreateInput) =>
      apiClient.post<{ data: MessageTemplate }>("/api/v1/message-templates", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const update = useMutation({
    mutationFn: async ({ id, ...input }: UpdateInput) =>
      apiClient.patch<{ data: MessageTemplate }>(`/api/v1/message-templates/${id}`, input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const pending = create.isPending || update.isPending;

  React.useEffect(() => {
    if (!open) return;
    setTitle(template?.title ?? "");
    setBody(template?.body ?? "");
    setShortcut(template?.shortcut ?? "");
    setShared(template ? template.owner_user_id === null : false);
    setFavorito(template?.favorito ?? false);
    setPalavras((template?.palavras_chave ?? []).join(", "));
    setMidia(template?.media ?? null);
  }, [open, template]);

  async function escolherArquivo(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivo = e.target.files?.[0];
    e.target.value = "";
    if (!arquivo) return;
    setSubindo(true);
    try {
      setMidia(await subirArquivo(arquivo));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubindo(false);
    }
  }

  const extras = () => ({
    favorito,
    palavras_chave: palavras.split(",").map((p) => p.trim()).filter(Boolean),
    media_id: midia?.id ?? null,
  });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: template.id,
          title,
          body,
          shortcut: shortcut.trim() || null,
          ...extras(),
        });
        toast.success(t("Template atualizado."));
      } else {
        await create.mutateAsync({
          title,
          body,
          shortcut: shortcut.trim() || undefined,
          shared: canShare ? shared : false,
          ...extras(),
        });
        toast.success(t("Template criado."));
      }
      onOpenChange(false);
    } catch {
      /* erro já mostrado pelo showApiError */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t("Editar template") : t("Novo template")}</DialogTitle>
          <DialogDescription>
            {t("Scripts salvos para responder mais rápido no atendimento.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tpl-title">{t("Título")}</Label>
            <Input
              id="tpl-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("Saudação inicial")}
              minLength={1}
              maxLength={80}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-body">{t("Mensagem")}</Label>
            <Textarea
              id="tpl-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("Oi {{primeiro_nome}}, tudo bem?")}
              maxLength={4096}
              required={!midia}
              rows={5}
            />
            <p className="text-xs text-muted-foreground">
              {t("Use")} {"{{primeiro_nome}}"} {t("e")} {"{{nome}}"} {t("para personalizar.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-arquivo">{t("Anexo: áudio, imagem, vídeo ou documento (opcional)")}</Label>
            {midia ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="rounded-md border px-2 py-1">{t(KIND_ROTULO[midia.kind])}: {midia.name}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setMidia(null)}>
                  {t("Tirar anexo")}
                </Button>
              </div>
            ) : (
              <Input id="tpl-arquivo" type="file" accept="audio/*,image/*,video/*,application/pdf" onChange={escolherArquivo} disabled={subindo} />
            )}
            {subindo && <p className="text-xs text-muted-foreground">{t("Subindo o arquivo…")}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-palavras">{t("Palavras que acham esta mensagem no chat (separe por vírgula)")}</Label>
            <Input id="tpl-palavras" value={palavras} onChange={(e) => setPalavras(e.target.value)} placeholder={t("valores, preço")} />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="tpl-favorito" checked={favorito} onCheckedChange={setFavorito} />
            <Label htmlFor="tpl-favorito">{t("Favorita (aparece primeiro na barra do chat)")}</Label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-shortcut">{t("Atalho (opcional)")}</Label>
            <Input
              id="tpl-shortcut"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              placeholder="oi"
              maxLength={40}
            />
          </div>
          {canShare && (
            <div className="flex items-center gap-2">
              <Switch
                id="tpl-shared"
                checked={shared}
                onCheckedChange={setShared}
                disabled={isEdit}
              />
              <Label htmlFor="tpl-shared">{t("Compartilhar com a equipe")}</Label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pending || subindo}>
              {isEdit ? t("Salvar") : t("Criar template")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
