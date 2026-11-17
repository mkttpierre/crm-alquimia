"use client";
/**
 * Editor de funil (sequência de mensagens prontas): nome, atalho, palavras-chave e a lista de mensagens que saem em ordem, cada uma
 * com a espera antes dela e o "digitando…/gravando…" que o contato vê. Salva o funil inteiro de uma vez.
 */
import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useSalvarFunil } from "@/hooks/inbox/useFunis";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { ATRASO_MAX_MS, PRESENCA_MAX_MS } from "@/lib/inbox/atalhos/schema-funil";
import type { Funil, Presenca } from "@/lib/inbox/atalhos/tipos";
import { duracaoEmTexto } from "@/lib/inbox/sequencias";
import { CaretDown, CaretUp, Plus, Trash } from "@/lib/ui/icons";

type PassoEditavel = { chave: number; templateId: string; esperaSeg: number; presenca: Presenca; presencaSeg: number };

export function atalhoDoNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

interface Props {
  funil?: Funil | null;
  modelos: Pick<MessageTemplate, "id" | "title" | "body" | "media">[];
  canShare: boolean;
  onSalvo: () => void;
}

export function FunilEditor({ funil, modelos, canShare, onSalvo }: Props) {
  const t = useT();
  const salvar = useSalvarFunil();
  // Chave estável de cada passo (a lista reordena): as iniciais são 1..n e as novas seguem dali.
  const proximaChave = React.useRef((funil?.passos.length ?? 0) + 1);
  const novaChave = () => proximaChave.current++;

  const [nome, setNome] = React.useState(funil?.nome ?? "");
  const [atalho, setAtalho] = React.useState(funil?.atalho ?? "");
  const [atalhoEditado, setAtalhoEditado] = React.useState(Boolean(funil));
  const [palavras, setPalavras] = React.useState((funil?.palavras_chave ?? []).join(", "));
  const [favorito, setFavorito] = React.useState(funil?.favorito ?? false);
  const [compartilhado, setCompartilhado] = React.useState(funil ? funil.compartilhado : canShare);
  const [erro, setErro] = React.useState<string | null>(null);
  const [passos, setPassos] = React.useState<PassoEditavel[]>(() =>
    (funil?.passos ?? []).map((p, i) => ({
      chave: i + 1,
      templateId: p.template_id,
      esperaSeg: p.atraso_ms / 1000,
      presenca: p.presenca,
      presencaSeg: p.presenca_ms / 1000,
    })),
  );

  const totalSeg = passos.slice(1).reduce((s, p) => s + (Number.isFinite(p.esperaSeg) ? p.esperaSeg : 0), 0);

  function mudarPasso(i: number, parcial: Partial<PassoEditavel>) {
    setPassos((ps) => ps.map((p, j) => (j === i ? { ...p, ...parcial } : p)));
  }
  function mover(i: number, para: number) {
    setPassos((ps) => {
      if (para < 0 || para >= ps.length) return ps;
      const novo = [...ps];
      const [p] = novo.splice(i, 1);
      novo.splice(para, 0, p!);
      return novo;
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (!passos.length) return setErro(t("Adicione ao menos uma mensagem."));
    if (passos.some((p) => !p.templateId)) return setErro(t("Escolha a mensagem de cada passo."));
    if (passos.some((p) => p.presencaSeg * 1000 > PRESENCA_MAX_MS)) return setErro(t("A presença (digitando/gravando) vai no máximo 25 s."));
    if (passos.some((p) => p.esperaSeg * 1000 > ATRASO_MAX_MS || p.esperaSeg < 0)) return setErro(t("A espera vai de 0 a 10 minutos."));
    try {
      await salvar.mutateAsync({
        ...(funil ? { id: funil.id } : {}),
        nome: nome.trim(),
        atalho,
        palavras_chave: palavras.split(",").map((p) => p.trim()).filter(Boolean),
        favorito,
        compartilhado: canShare ? compartilhado : false,
        passos: passos.map((p, i) => ({
          template_id: p.templateId,
          atraso_ms: i === 0 ? 0 : Math.round(p.esperaSeg * 1000),
          presenca: p.presenca,
          presenca_ms: p.presenca === "nenhuma" ? 0 : Math.round(p.presencaSeg * 1000),
        })),
      });
      toast.success(t("Funil salvo."));
      onSalvo();
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="funil-nome">{t("Nome do funil")}</Label>
          <Input
            id="funil-nome"
            value={nome}
            maxLength={80}
            required
            onChange={(e) => {
              setNome(e.target.value);
              if (!atalhoEditado) setAtalho(atalhoDoNome(e.target.value));
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="funil-atalho">{t("Atalho")}</Label>
          <Input
            id="funil-atalho"
            value={atalho}
            maxLength={40}
            required
            pattern="[a-z0-9-]{2,40}"
            onChange={(e) => {
              setAtalhoEditado(true);
              setAtalho(e.target.value.toLowerCase());
            }}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="funil-palavras">{t("Palavras que acham este funil no chat (separe por vírgula)")}</Label>
        <Input id="funil-palavras" value={palavras} onChange={(e) => setPalavras(e.target.value)} placeholder={t("valores, preço")} />
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={favorito} onCheckedChange={setFavorito} aria-label={t("Favorito")} /> {t("Favorito (aparece primeiro)")}
        </label>
        {canShare && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={compartilhado} onCheckedChange={setCompartilhado} aria-label={t("Para a equipe")} /> {t("Para a equipe toda")}
          </label>
        )}
      </div>

      <ol className="space-y-2">
        {passos.map((p, i) => {
          const n = i + 1;
          return (
            <li key={p.chave} className="space-y-2 rounded-md border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-sm font-medium text-muted-foreground">{n}.</span>
                <select
                  aria-label={`${t("Mensagem do passo")} ${n}`}
                  className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
                  value={p.templateId}
                  onChange={(e) => mudarPasso(i, { templateId: e.target.value })}
                >
                  <option value="">{t("Escolha a mensagem…")}</option>
                  {modelos.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
                <Button type="button" variant="ghost" size="icon" aria-label={`${t("Subir passo")} ${n}`} onClick={() => mover(i, i - 1)} disabled={i === 0}>
                  <CaretUp />
                </Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`${t("Descer passo")} ${n}`} onClick={() => mover(i, i + 1)} disabled={i === passos.length - 1}>
                  <CaretDown />
                </Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`${t("Tirar passo")} ${n}`} onClick={() => setPassos((ps) => ps.filter((_, j) => j !== i))}>
                  <Trash />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3 pl-8 text-sm">
                {i > 0 && (
                  <label className="flex items-center gap-1.5">
                    {t("Espera")}
                    <Input
                      type="number"
                      min={0}
                      max={600}
                      step={1}
                      aria-label={`${t("Espera antes do passo")} ${n} (${t("segundos")})`}
                      className="h-8 w-20"
                      value={p.esperaSeg}
                      onChange={(e) => mudarPasso(i, { esperaSeg: Number(e.target.value) })}
                    />
                    s
                  </label>
                )}
                <select
                  aria-label={`${t("Presença do passo")} ${n}`}
                  className="h-8 rounded-md border bg-background px-2"
                  value={p.presenca}
                  onChange={(e) => mudarPasso(i, { presenca: e.target.value as Presenca })}
                >
                  <option value="nenhuma">{t("Sem presença")}</option>
                  <option value="digitando">{t("Digitando…")}</option>
                  <option value="gravando">{t("Gravando áudio…")}</option>
                </select>
                {p.presenca !== "nenhuma" && (
                  <label className="flex items-center gap-1.5">
                    {t("por")}
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      aria-label={`${t("Duração da presença do passo")} ${n} (${t("segundos")})`}
                      className="h-8 w-20"
                      value={p.presencaSeg}
                      onChange={(e) => mudarPasso(i, { presencaSeg: Number(e.target.value) })}
                    />
                    s
                  </label>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setPassos((ps) => [...ps, { chave: novaChave(), templateId: "", esperaSeg: ps.length ? 3 : 0, presenca: "digitando", presencaSeg: 2 }])}
        >
          <Plus /> {t("Adicionar mensagem")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t("Total")}: {duracaoEmTexto(totalSeg)}
        </span>
      </div>
      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={salvar.isPending}>
          {t("Salvar funil")}
        </Button>
      </div>
    </form>
  );
}
