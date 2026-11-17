"use client";
import { useState, useTransition, type ReactNode } from "react";

import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { BarraLateral, ConteudoDaBarra } from "@/components/app/BarraLateral";
import { CONSULTA_DO_CELULAR, Topo } from "@/components/app/Topo";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useT } from "@/hooks/i18n/useT";
import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";
import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { useNotifyOpenFromServiceWorker } from "@/lib/notifications/notify_open";

interface AppShellProps {
  /** A barra estava escondida no computador (cookie `sidebar_collapsed`, lido no SSR para não piscar). */
  sidebarCollapsed: boolean;
  /** Nome ou logo configurados (resolvido no servidor) — ver `components/app/MarcaDoProduto.tsx`. */
  marcaPropria: boolean;
  children: ReactNode;
}

/**
 * A casca do app (protótipo A): barra lateral de 264px + topo de 60px + conteúdo.
 *
 * O botão do topo faz duas coisas conforme a largura: no computador esconde ou
 * mostra a barra (e grava a escolha no cookie, como o "Recolher" de antes); no
 * celular (≤ 860px) abre a mesma barra como gaveta, sem tocar no cookie — abrir
 * a gaveta no celular não pode mudar a preferência escolhida no notebook.
 */
export function AppShell({ sidebarCollapsed, marcaPropria, children }: AppShellProps) {
  useInboundMessageAlerts();
  useCrmAlerts();
  useNotifyOpenFromServiceWorker();
  const t = useT();
  const [escondida, setEscondida] = useState(sidebarCollapsed);
  const [gaveta, setGaveta] = useState(false);
  // O modo personalização está ligado na gaveta: ela só fecha por Cancelar ou Concluir.
  const [editandoNaGaveta, setEditandoNaGaveta] = useState(false);
  const [, startTransition] = useTransition();

  function alternarMenu() {
    if (window.matchMedia(CONSULTA_DO_CELULAR).matches) {
      setGaveta((v) => !v);
      return;
    }
    const antes = escondida;
    setEscondida(!antes);
    startTransition(() => toggleSidebar(antes));
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      <BarraLateral escondida={escondida} marcaPropria={marcaPropria} />
      <Sheet
        open={gaveta}
        // Também barra o "X" da gaveta: fechar desmonta o conteúdo e o modo inteiro se perde.
        onOpenChange={(aberta) => {
          if (!aberta && editandoNaGaveta) return;
          setGaveta(aberta);
        }}
      >
        <SheetContent
          side="left"
          // Escape e toque fora fecham a gaveta, e com isso jogariam fora o que a pessoa mexeu
          // no modo personalização (o estado dele mora no conteúdo, que desmonta).
          onEscapeKeyDown={(e) => {
            if (editandoNaGaveta) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (editandoNaGaveta) e.preventDefault();
          }}
          className="w-[264px] max-w-[calc(100vw-2rem)] gap-0 border-lateral-linha bg-lateral p-0 text-lateral-texto sm:max-w-[264px]"
        >
          <SheetTitle className="sr-only">{t("Navegação principal")}</SheetTitle>
          <ConteudoDaBarra
            naGaveta
            aoNavegar={() => setGaveta(false)}
            aoMudarEdicao={setEditandoNaGaveta}
            marcaPropria={marcaPropria}
          />
        </SheetContent>
      </Sheet>
      {/*
        `min-w-0` é o que permite a coluna de conteúdo ENCOLHER. Um flex item
        nasce com `min-width: auto`, ou seja, nunca fica menor que o conteúdo —
        então qualquer bloco largo (uma fila de abas, uma tabela) empurrava a
        PÁGINA INTEIRA para o lado em vez de rolar dentro da própria caixa.

        Sem margem à esquerda: a barra reserva o próprio lugar na linha (ver
        `BarraLateral`), então sobra para esta coluna exatamente o que ela não
        usou — não há segunda medida para discordar.
      */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <Topo aoAlternarMenu={alternarMenu} />
        <main className="app-shell-main flex-1 overflow-auto p-6 max-[860px]:px-4">{children}</main>
      </div>
    </div>
  );
}
