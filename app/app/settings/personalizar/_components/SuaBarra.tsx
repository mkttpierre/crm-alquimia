"use client";

/**
 * Configurações › Personalizar › "Sua barra": cada pessoa oculta, mostra e
 * reordena os tópicos da PRÓPRIA barra lateral.
 *
 * Ocultar NÃO é permissão — a tela ocultada continua abrindo pelo link e pelo ⌘K
 * (a tela diz isso). A restrição do admin vem antes: o que ele tirou da interface
 * deste vínculo nem aparece aqui (`barraParaPersonalizar` já a aplicou).
 *
 * Sem biblioteca de arrastar: subir e descer são botões com `aria-label`, o
 * "mostrar" é um interruptor (`role="switch"`), e a lista é uma lista de verdade
 * — funciona no teclado, no leitor de tela e no celular. Configurações aparece
 * travada: sem ela a pessoa perderia o caminho de volta para esta tela.
 */
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateMinhaBarra } from "@/app/actions/settings/updateMinhaBarra";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import {
  LIMITE_DE_CHAVES,
  moverItem,
  type PreferenciasDaBarra,
} from "@/lib/navigation/personalizar";
import { CaretDown, CaretUp, Lock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export interface LinhaEditavel {
  chave: string;
  label: string;
  /** O nome veio do admin: vai como está, sem tradução. */
  nomeProprio: boolean;
  oculto: boolean;
  fixo: boolean;
}

export interface BlocoEditavel {
  id: string;
  /** `null` = o bloco sem título (o do dia a dia). */
  titulo: string | null;
  itens: LinhaEditavel[];
}

/** Mensagem por código de recusa da Server Action. */
const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Algum campo não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo para salvar.",
  forbidden_tenant: "Não consegui identificar sua empresa. Recarregue a página.",
  forbidden_role: "Você não tem permissão para fazer esta alteração.",
  // NUNCA "salvo com uma ressalva": a gravação não casou nenhuma linha.
  nao_gravou: "A alteração não chegou ao banco — nada foi mudado. Tente de novo.",
};

export function SuaBarra({
  blocos,
  preservados,
  temEscolhaSalva,
}: {
  blocos: BlocoEditavel[];
  /**
   * O que está gravado e NÃO aparece agora (a interface do vínculo ou o papel
   * tiraram a linha). Volta no envio de "Salvar", para um "Salvar" de hoje não
   * apagar a escolha de uma linha que o admin pode liberar amanhã.
   */
  preservados: PreferenciasDaBarra;
  /** Há preferência gravada: habilita "Restaurar padrão". */
  temEscolhaSalva: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [estado, setEstado] = useState(blocos);
  const [pendente, startTransition] = useTransition();
  const raiz = useRef<HTMLElement>(null);
  // Qual botão acabou de mover uma linha: depois do render, o foco volta para ele —
  // ou para o vizinho, se ele chegou à ponta e ficou desabilitado (desabilitar o
  // botão focado joga o foco no <body> e quem usa teclado perde o lugar).
  const focoPendente = useRef<{ chave: string; acao: "subir" | "descer" } | null>(null);

  const inicial = useMemo(() => JSON.stringify(blocos), [blocos]);
  const mudou = JSON.stringify(estado) !== inicial;
  const total = estado.reduce((n, b) => n + b.itens.length, 0);
  const visiveis = estado.reduce((n, b) => n + b.itens.filter((i) => !i.oculto).length, 0);

  const rotulo = (i: LinhaEditavel) => (i.nomeProprio ? i.label : t(i.label));

  function alternar(chave: string) {
    setEstado((atual) =>
      atual.map((b) => ({
        ...b,
        itens: b.itens.map((i) => (i.chave === chave && !i.fixo ? { ...i, oculto: !i.oculto } : i)),
      })),
    );
  }

  function mover(blocoId: string, chave: string, delta: -1 | 1) {
    focoPendente.current = { chave, acao: delta < 0 ? "subir" : "descer" };
    setEstado((atual) =>
      atual.map((b) => (b.id === blocoId ? { ...b, itens: moverItem(b.itens, chave, delta) } : b)),
    );
  }

  useEffect(() => {
    const alvo = focoPendente.current;
    if (!alvo) return;
    focoPendente.current = null;
    for (const bloco of estado) {
      const i = bloco.itens.findIndex((x) => x.chave === alvo.chave);
      if (i < 0) continue;
      const pode = {
        subir: i > 0,
        descer: i < bloco.itens.length - 1 && !bloco.itens[i + 1]?.fixo,
      };
      const outra = alvo.acao === "subir" ? "descer" : "subir";
      const acao = pode[alvo.acao] ? alvo.acao : pode[outra] ? outra : "mostrar";
      raiz.current?.querySelector<HTMLElement>(`[data-foco="${alvo.chave}|${acao}"]`)?.focus();
      return;
    }
  }, [estado]);

  function resposta(r: Awaited<ReturnType<typeof updateMinhaBarra>>, sucesso: string) {
    if (r.ok) {
      toast.success(t(sucesso));
      router.refresh();
      return;
    }
    toast.error(t(ERRO_EM_PORTUGUES[r.error] ?? "Não foi possível salvar. Tente de novo."));
  }

  function salvar() {
    startTransition(async () => {
      const r = await updateMinhaBarra({
        ocultos: [
          ...estado.flatMap((b) => b.itens.filter((i) => i.oculto).map((i) => i.chave)),
          ...preservados.ocultos,
        ].slice(0, LIMITE_DE_CHAVES),
        ordem: [...estado.flatMap((b) => b.itens.map((i) => i.chave)), ...preservados.ordem].slice(
          0,
          LIMITE_DE_CHAVES,
        ),
      });
      resposta(r, "Sua barra foi salva.");
    });
  }

  function restaurar() {
    startTransition(async () => {
      resposta(await updateMinhaBarra(null), "Sua barra voltou ao padrão.");
    });
  }

  return (
    <section ref={raiz} aria-labelledby="sua-barra-titulo" className="space-y-4">
      <header>
        <h2 id="sua-barra-titulo" className="text-lg font-semibold tracking-tight">
          {t("Sua barra")}
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Escolha o que aparece na barra lateral e em que ordem. Isso vale só para você.")}
        </p>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Ocultar só tira da barra: a tela continua abrindo pelo link e pela busca (⌘K).")}
        </p>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Ocultar uma linha oculta também o submenu dela.")}
        </p>
      </header>

      <div className="space-y-4">
        {estado.map((bloco) => (
          <Card key={bloco.id} className="p-4">
            <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {bloco.titulo ? t(bloco.titulo) : t("Dia a dia")}
            </h3>
            <ul className="divide-y divide-border">
              {bloco.itens.map((item, indice) => {
                const nome = rotulo(item);
                const primeiraMovel = indice === 0;
                const ultimaMovel =
                  indice === bloco.itens.length - 1 || !!bloco.itens[indice + 1]?.fixo;
                return (
                  <li key={item.chave} className="flex items-center gap-2 py-2">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm",
                        item.oculto && "text-muted-foreground line-through",
                      )}
                    >
                      {nome}
                    </span>
                    {item.fixo ? (
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <Lock size={14} aria-hidden />
                        {t("Sempre visível")}
                      </span>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          data-foco={`${item.chave}|subir`}
                          aria-label={`${t("Subir")} ${nome}`}
                          disabled={pendente || primeiraMovel}
                          onClick={() => mover(bloco.id, item.chave, -1)}
                        >
                          <CaretUp aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          data-foco={`${item.chave}|descer`}
                          aria-label={`${t("Descer")} ${nome}`}
                          disabled={pendente || ultimaMovel}
                          onClick={() => mover(bloco.id, item.chave, 1)}
                        >
                          <CaretDown aria-hidden />
                        </Button>
                        <Switch
                          checked={!item.oculto}
                          disabled={pendente}
                          data-foco={`${item.chave}|mostrar`}
                          aria-label={`${t("Mostrar")} ${nome}`}
                          onCheckedChange={() => alternar(item.chave)}
                        />
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={salvar} disabled={pendente || !mudou}>
          {pendente ? t("Salvando…") : t("Salvar")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={restaurar}
          disabled={pendente || !temEscolhaSalva}
        >
          {t("Restaurar padrão")}
        </Button>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {`${visiveis} / ${total} ${t("tópicos visíveis")}`}
        </span>
      </div>
    </section>
  );
}
