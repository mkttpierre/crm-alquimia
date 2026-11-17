"use client";
import { useT } from "@/hooks/i18n/useT";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { PaperPlaneTilt } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { AttachmentPreviewDialog } from "@/components/inbox/composer/AttachmentPreviewDialog";
import { ContactPickerDialog } from "@/components/inbox/composer/ContactPickerDialog";
import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";
import { ReplyReviewPanel } from "@/components/inbox/composer/ReplyReviewPanel";
import { EmojiButton } from "@/components/inbox/composer/EmojiButton";
import { ItemsBar } from "@/components/inbox/composer/ItemsBar";
import { FaixaDoFunil } from "@/components/inbox/composer/FaixaDoFunil";
import { useCreateNote } from "@/hooks/inbox/useCreateNote";
import { useSequenciaComando } from "@/hooks/inbox/useSequenciaComando";
import { useAtalhos } from "@/hooks/inbox/useAtalhos";
import { ApiError } from "@/lib/api/types";
import type { ItemDeAtalho } from "@/lib/inbox/atalhos/tipos";
import { desfechoDoErroDeEnvio } from "@/lib/inbox/desfecho-do-envio";
import { atalhoDoComando } from "@/lib/inbox/sequencias";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { X } from "lucide-react";
import { toast } from "sonner";
import { extFromMime } from "@/lib/messaging/media/types";
import { recusaDoAnexo } from "@/lib/messaging/media/upload-validation";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia } from "@/hooks/inbox/useUploadMedia";
import { imagemDoClipboard } from "@/lib/inbox/clipboard-image";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import { cn } from "@/lib/utils";

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  conversationId: string;
  disabled?: boolean;
  /** Set true when contact is blocked / anonymized — explanation shown. */
  blockedReason?: string | null;
  /**
   * Janela de 24h fechada: barra a RESPOSTA, e só ela.
   *
   * Separado de `blockedReason` porque a nota interna nunca chega ao cliente —
   * a regra da plataforma não a alcança, e barrá-la tira do atendente
   * justamente o lugar onde ele registra por que a conversa esfriou. A primeira
   * versão deste bloqueio usava `blockedReason` e levou a nota junto.
   */
  janelaFechada?: string | null;
  /**
   * A mensagem que esta resposta CITA, quando o atendente escolheu responder
   * "em cima" de uma. `null` = envio solto, o caso comum.
   *
   * Vem de fora e não daqui porque quem escolhe é a lista de mensagens: o
   * composer só precisa mostrar o que foi escolhido e mandá-lo junto.
   */
  respondendo?: { id: string; body: string | null; direction: string } | null;
  /** Desfaz a escolha — o `x` da faixa de citação. */
  onCancelarResposta?: () => void;
  /** Nome do contato da conversa, para interpolar {{nome}}/{{primeiro_nome}} do template escolhido. */
  contactName?: string | null;
  /** Contato da conversa — excluído do seletor de cartão compartilhado. */
  currentContactId?: string | null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    conversationId,
    disabled,
    blockedReason,
    janelaFechada,
    contactName,
    currentContactId,
    respondendo,
    onCancelarResposta,
  },
  ref,
) {
  const t = useT();
  const [text, setText] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // Legenda que veio junto com o anexo de uma resposta rápida (o texto da própria resposta).
  const [pendingCaption, setPendingCaption] = useState("");
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const createNote = useCreateNote();
  const sequenciaComando = useSequenciaComando();
  const atalhos = useAtalhos();
  // A barra de atalhos (atalhos de mensagem pronta) aparece enquanto se digita uma resposta; Esc a fecha até o texto mudar.
  const barraAberta = mode === "reply" && !menuDismissed && text.trim().length > 0;

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  // send/createNote fora do disable: o texto some na hora do envio; travar o campo
  // até a API voltar impedia digitar a próxima mensagem com o campo ainda cheio.
  const isDisabled = disabled || !!blockedReason || upload.isPending;
  // A janela só alcança o que SAI. Em modo nota o composer segue liberado: a
  // nota interna nunca chega ao cliente, e é onde o atendente registra por que
  // a conversa esfriou — barrá-la tira exatamente o que ainda dá para fazer.
  const respostaBarrada = isDisabled || (mode === "reply" && !!janelaFechada);

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function handleSubmit() {
    const body = text.trim();
    if (!body || (mode === "note" ? isDisabled : respostaBarrada || send.isPending)) return;

    // `/<atalho do funil>`: sequência do operador. O texto do comando nunca vai ao lead; o servidor AGENDA as mensagens
    // (em ordem, com pausa) e o motor as leva ao canal. Em modo nota é só texto da nota.
    const atalho = mode === "reply" ? atalhoDoComando(body) : null;
    const funilDigitado = atalho ? atalhos.funis.find((f) => f.atalho === atalho) : undefined;
    if (funilDigitado) {
      agendar({ funnel_id: funilDigitado.id }, body);
      return;
    }

    setText("");
    requestAnimationFrame(() => autoresize());

    const restoreOnError = () => {
      setText(body);
      requestAnimationFrame(() => autoresize());
    };

    if (mode === "note") {
      createNote.mutate({ conversation_id: conversationId, body }, { onError: restoreOnError });
      return;
    }
    send.mutate(
      {
        conversation_id: conversationId,
        body,
        type: "text",
        ...(respondendo ? { reply_to_message_id: respondendo.id } : {}),
      },
      {
        onSuccess: () => {
          // A citação vale para UMA mensagem. Mantê-la depois do envio faria a
          // próxima frase sair citando algo que o atendente já respondeu.
          onCancelarResposta?.();
          requestAnimationFrame(() => autoresize());
        },
        // O texto volta só na falha CERTA (nada saiu): sem isto quem escreveu um
        // parágrafo o perde. No desfecho incerto ou já enviado ele NÃO volta —
        // devolvê-lo convida a clicar de novo, e foi assim que a mesma frase saiu
        // três vezes em 06/11. Ali quem fala é o aviso do `useSendMessage`, com a
        // saída explícita ("Enviar de novo" / "Tentar de novo").
        onError: (err) => {
          if (desfechoDoErroDeEnvio(err) === "falha") restoreOnError();
        },
      },
    );
  }

  /** Agenda um funil ou uma mensagem avulsa. `textoDigitado` volta ao campo se o pedido falhar. */
  function agendar(alvo: { funnel_id: string } | { template_id: string }, textoDigitado = "", seSemChip?: () => void) {
    if (respostaBarrada) return;
    setMenuDismissed(true);
    setText("");
    requestAnimationFrame(() => autoresize());
    sequenciaComando.mutate(
      { conversation_id: conversationId, ...alvo },
      {
        onError: (err) => {
          // Conversa que não sai por chip do motor: a mensagem avulsa cai no envio comum (como era antes).
          if (seSemChip && err instanceof ApiError && err.code === "sequencia_chip" && (err.details as { sem_chip_do_motor?: boolean } | undefined)?.sem_chip_do_motor) {
            seSemChip();
            return;
          }
          if (!textoDigitado) return;
          setText(textoDigitado);
          requestAnimationFrame(() => autoresize());
        },
      },
    );
  }

  /** Um cartão da barra de atalhos: funil agenda as mensagens; mensagem/mídia sai como um envio só. */
  function escolherAtalho(item: ItemDeAtalho) {
    const digitado = text;
    if (item.tipo === "funil") {
      agendar({ funnel_id: item.id }, digitado);
      return;
    }
    const tpl = atalhos.modelos.find((m) => m.id === item.id);
    agendar({ template_id: item.id }, digitado, tpl ? () => applyTemplate(tpl) : undefined);
  }

  /**
   * Todo anexo entra por aqui (menu "+", Ctrl+V, resposta rápida com mídia). O que o upload recusaria
   * (vídeo acima de 16 MB, vídeo fora de MP4…) é recusado JÁ, com o limite escrito: sem isto o
   * operador esperava subir 40 MB para ler a recusa — ou nem lia, quando o canal aceitava e a mídia
   * não chegava.
   */
  function anexar(file: File): boolean {
    const recusa = recusaDoAnexo(file.type || "application/octet-stream", file.size);
    if (recusa) {
      toast.error(t(recusa));
      return false;
    }
    setPendingFile(file);
    return true;
  }

  // A legenda pré-preenchida vale para UM anexo: sem zerá-la aqui ela vazaria para o próximo arquivo escolhido.
  function limparAnexo() {
    setPendingFile(null);
    setPendingCaption("");
  }

  /** Resposta rápida COM anexo (biblioteca de mídia): baixa o arquivo e abre o preview de envio. */
  async function applyTemplateWithMedia(tpl: MessageTemplate, filled: string) {
    const media = tpl.media;
    if (!media) return;
    try {
      const resp = await fetch(`/api/v1/media-library/${media.id}/file`);
      if (!resp.ok) throw new Error(String(resp.status));
      const blob = await resp.blob();
      const nome = `${media.name.replace(/[\\\/:*?"<>|]+/g, " ").trim() || "anexo"}.${extFromMime(media.mime)}`;
      if (!anexar(new File([blob], nome, { type: media.mime }))) return;
      setText("");
      setPendingCaption(media.kind === "audio" ? "" : filled);
    } catch {
      toast.error(t("Não foi possível abrir o anexo desta resposta rápida."));
    }
  }

  function applyTemplate(tpl: MessageTemplate) {
    const filled = interpolateTemplate(tpl.body, { name: contactName ?? null });
    setMenuDismissed(true);
    if (tpl.media) {
      void applyTemplateWithMedia(tpl, filled);
      return;
    }
    setText(filled);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = filled.length;
      autoresize();
    });
  }

  /**
   * Ctrl/Cmd+V com imagem no clipboard cai no MESMO caminho do menu "+":
   * abre o preview com legenda e envia por ali. Nada de atalho paralelo — a
   * validação, o toast de erro e o retry já vivem lá.
   *
   * As três guardas antes de olhar o clipboard não são zelo: em "Nota interna"
   * não existe anexo (a nota é só texto e o envio nem passa pelo upload), com
   * um anexo já em preview a colagem substituiria em silêncio o que o operador
   * escolheu, e desabilitado é desabilitado. Em qualquer um desses casos o
   * Ctrl+V precisa continuar sendo o Ctrl+V de sempre.
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (mode !== "reply" || respostaBarrada || pendingFile) return;
    const imagem = imagemDoClipboard(e.clipboardData, new Date());
    if (!imagem) return; // colagem de texto segue o caminho normal do browser
    e.preventDefault();
    anexar(imagem);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && barraAberta) {
      setMenuDismissed(true);
      return;
    }
    // Enter na caixa é sempre "enviar o texto": a barra só escolhe com clique ou com Enter num cartão em foco.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  if (blockedReason) {
    return (
      <div className="border-t border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
        {blockedReason}
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "relative border-t border-border bg-background px-3 py-2",
          mode === "note" && "border-warning/40 bg-warning-bg",
        )}
      >
        {mode === "reply" && (
          <ReplyReviewPanel conversationId={conversationId} disabled={isDisabled} />
        )}
        {mode === "reply" && <FaixaDoFunil conversationId={conversationId} funis={atalhos.funis} />}
        {barraAberta && (
          <ItemsBar
            texto={text}
            itens={atalhos.itens}
            onEscolher={escolherAtalho}
            onFechar={() => {
              setMenuDismissed(true);
              taRef.current?.focus();
            }}
          />
        )}
        <div className="mb-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "reply"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Responder")}
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "note"
                ? "bg-warning text-warning-fg"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Nota interna")}
          </button>
        </div>
        {/*
          A FAIXA DA CITAÇÃO — o que o atendente escolheu responder.

          Fica ACIMA do campo, como no WhatsApp, e não dentro dele: o texto
          citado pode ter várias linhas, e empurrá-lo para dentro do campo faria
          o que se digita disputar espaço com o que se cita.

          `line-clamp-2` porque o objetivo é reconhecer qual mensagem é, não
          relê-la — ela está logo acima, no fio.
        */}
        {respondendo && mode === "reply" && (
          <div className="mb-1 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-primary">
                {respondendo.direction === "outbound" ? t("Você") : t("Cliente")}
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">
                {respondendo.body?.trim() || t("(sem texto)")}
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelarResposta}
              aria-label={t("Cancelar resposta")}
              className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {mode === "reply" && (
            <AttachMenu
              disabled={respostaBarrada}
              onPick={anexar}
              onPickContact={() => setContactPickerOpen(true)}
            />
          )}
          <EmojiButton
            disabled={isDisabled}
            onPick={(emoji) => {
              const ta = taRef.current;
              if (!ta) {
                setText((t) => t + emoji);
                return;
              }
              const start = ta.selectionStart ?? text.length;
              const end = ta.selectionEnd ?? text.length;
              const next = text.slice(0, start) + emoji + text.slice(end);
              setText(next);
              requestAnimationFrame(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = start + emoji.length;
                autoresize();
              });
            }}
          />
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setMenuDismissed(false);
              autoresize();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            // O atalho saiu do placeholder e foi para o diálogo de atalhos (`?`)
            // e para o `title` aqui. Dois motivos, nesta ordem: ele some assim
            // que se digita a primeira letra — isto é, some justamente quando
            // você ia quebrar linha —; e, com a coluna do inbox mais estreita
            // depois do conserto do layout, a frase quebrava em duas linhas
            // dentro de um campo de uma linha só.
            //
            // "(só o time vê)" FICA: não é atalho, é consequência. Quem escreve
            // uma nota interna precisa saber que ela não vai para o cliente, e
            // essa informação não pode depender de abrir um diálogo.
            placeholder={
              mode === "note"
                ? t("Escreva uma nota interna… (só o time vê)")
                : t("Escreva uma mensagem…")
            }
            title={
              mode === "note"
                ? t("Enter salva a nota · Shift+Enter quebra linha")
                : t("Enter envia · Shift+Enter quebra linha")
            }
            className={cn(
              "max-h-40 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm",
              "placeholder:text-muted-foreground focus:ring-1 focus:ring-ring focus:outline-hidden",
            )}
            disabled={mode === "note" ? isDisabled : respostaBarrada}
            aria-label={t("Mensagem")}
          />
          {text.trim() || mode === "note" || send.isPending ? (
            <Button
              type="button"
              size="icon"
              className={cn("h-9 shrink-0", send.isPending ? "w-auto px-2" : "w-9")}
              onClick={handleSubmit}
              disabled={(mode === "note" ? isDisabled : respostaBarrada || send.isPending) || !text.trim()}
              aria-label={send.isPending ? t("Enviando…") : t("Enviar")}
            >
              {send.isPending ? <span className="text-xs">{t("Enviando…")}</span> : <PaperPlaneTilt size={16} weight="fill" aria-hidden />}
            </Button>
          ) : (
            <AudioRecorder conversationId={conversationId} disabled={respostaBarrada} />
          )}
        </div>
      </div>
      <AttachmentPreviewDialog
        file={pendingFile}
        initialCaption={pendingCaption}
        sending={upload.isPending || send.isPending}
        onCancel={limparAnexo}
        onSend={async (caption) => {
          if (!pendingFile) return;
          try {
            const uploaded = await upload.mutateAsync({ conversationId, file: pendingFile });
            send.mutate(
              {
                conversation_id: conversationId,
                type: uploaded.kind,
                body: caption || undefined,
                media_storage_path: uploaded.storage_path,
                media_mime: uploaded.media_mime,
                media_size_bytes: uploaded.media_size_bytes,
              },
              { onSuccess: limparAnexo },
            );
          } catch {
            // toast já disparado pelo onError de useUploadMedia; dialog fica aberto p/ retry
            return;
          }
        }}
      />
      <ContactPickerDialog
        open={contactPickerOpen}
        onOpenChange={setContactPickerOpen}
        excludeContactId={currentContactId}
        sending={send.isPending}
        onPick={(payload) => {
          send.mutate(
            {
              conversation_id: conversationId,
              type: "contact",
              metadata: payload.contactId
                ? { shared_contact_id: payload.contactId }
                : {
                    shared_contact: {
                      name: payload.name,
                      phone_number: payload.phone_number,
                    },
                  },
            },
            { onSuccess: () => setContactPickerOpen(false) },
          );
        }}
      />
    </>
  );
});
