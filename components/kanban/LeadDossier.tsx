"use client";

import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { tipoContato } from "@/lib/negocio/tipo-contato";
import { numeroDoNegocio } from "./numero-do-negocio";

import { useT } from "@/hooks/i18n/useT";
import { produtosComprados } from "@/lib/leads/tag-de-origem";
import { useContact } from "@/hooks/contacts/useContact";
import type { Stage } from "@/lib/kanban/types";
import { JornadaDoNegocio } from "./JornadaDoNegocio";
import { AbaProdutosDoNegocio } from "@/components/negocio/AbaProdutosDoNegocio";
import { BotaoRegistrarVenda } from "@/components/negocio/BotaoRegistrarVenda";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLeadTimeline } from "@/hooks/leads/useLeadTimeline";
import type { Lead } from "@/lib/types/leads";
import { ConversaNoDossie } from "./ConversaNoDossie";
import { LeadFieldsForm } from "./LeadFieldsForm";
import { ScoreSlot } from "./ScoreSlot";
import { LeadTimeline } from "./LeadTimeline";
import { OwnerBadge } from "./OwnerBadge";
import { resolveLeadOwner } from "@/lib/kanban/owner";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  stageName: string;
  ownerNames?: Map<string, string | null>;
  stages?: Stage[];
}

function formatBRL(cents: number | null, currency: string | null): string {
  if (cents === null) return "—";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency ?? "BRL",
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `R$ ${(cents / 100).toFixed(0)}`;
  }
}

/**
 * O dossiê do negócio: cabeçalho vivo → timeline → campos.
 *
 * A ORDEM É a mudança em relação ao diálogo de edição: quem abre um lead quer
 * primeiro saber O QUE ACONTECEU, e só depois mexer. O formulário íntegro fica
 * por último, e o cabeçalho tem um atalho para ele — ordem preservada, custo de
 * rolagem resolvido.
 *
 * SALVAR NÃO FECHA. Quem edita precisa ver a atividade que acabou de gerar
 * entrar na timeline; fechar esconderia o registro justamente de quem o
 * produziu, e a funcionalidade que prova "sua ação fica registrada" provaria
 * isso para todo mundo menos para o autor.
 */
export function LeadDossier({
  open,
  onOpenChange,
  lead,
  pipelineId,
  fieldDefs = [],
  stageName,
  ownerNames,
  stages = [],
}: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const campos = useRef<HTMLDivElement | null>(null);
  const [aba, setAba] = useState("resumo");
  const timeline = useLeadTimeline(open ? lead.id : null, lead.contact_id);
  const owner = resolveLeadOwner(lead, ownerNames);
  const score = lead.score ?? null;
  const contato = useContact(open ? lead.contact_id ?? "" : "").data?.data;
  const nome = contato ? rotuloDoContato(contato) : lead.title;
  const vinculos = useQuery({
    queryKey: ["contato-vinculos", lead.contact_id],
    enabled: open && !!lead.contact_id,
    queryFn: () => apiClient.get<{ data: {
      leads: Array<{ id: string; title: string; pipeline_id: string }>;
      conversations: Array<{ id: string; last_message_preview: string | null }>;
    } }>(`/api/v1/contacts/${lead.contact_id}/vinculos`),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-[min(1100px,95vw)]"
        // Observável pelo mesmo motivo do board: "a assinatura morreu" e "nada
        // aconteceu" têm a mesma aparência, que é silêncio.
        data-realtime-status={timeline.realtimeStatus.toLowerCase()}
        // Observável como no board: "a entrega morreu" e "nada aconteceu"
        // têm a mesma aparência, e no dossiê a segunda é ainda mais crível —
        // negócio sem novidade é um estado normal.
        data-refetch-divergencias={timeline.seguranca.divergencias}
      >
        <SheetHeader className="pb-3">
          <SheetTitle className="text-base leading-6">{lead.title} · {numeroDoNegocio(lead.id)}</SheetTitle>
        </SheetHeader>

        <div className="mb-4">
          <ConversaNoDossie conversa={lead.conversa} />
        </div>

        <div className="grid gap-5 md:grid-cols-[minmax(250px,32%)_1fr]">
        <section className="border-b border-border pb-4 md:border-b-0 md:border-r md:pr-5" aria-label={t("Contato")}>
          <div className="flex flex-col items-center gap-3 text-center">
            <span aria-hidden className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/15 text-xl font-semibold text-accent">{nome.trim().slice(0, 1).toLocaleUpperCase()}</span>
            <h2 className="font-semibold">{nome}</h2>
            {contato && <span className="rounded-full bg-surface-muted px-2 py-1 text-xs text-text-muted">{t(tipoContato(contato.source_metadata) === "empresa" ? "Empresa" : "Pessoa")}</span>}
            <div className="flex flex-wrap justify-center gap-1">{lead.tags.map((tag) => <span key={tag} className="rounded-full bg-accent/10 px-2 py-1 text-xs text-accent">{tag}</span>)}</div>
          </div>
          <Tabs defaultValue="perfil" className="mt-5">
            <TabsList className="flex h-auto w-full flex-wrap justify-start"><TabsTrigger value="perfil">{t("Perfil")}</TabsTrigger><TabsTrigger value="negocios">{t("Negócios")}</TabsTrigger><TabsTrigger value="atividades">{t("Atividades")}</TabsTrigger><TabsTrigger value="atendimentos">{t("Atendimentos")}</TabsTrigger></TabsList>
            <TabsContent value="perfil" className="space-y-3 py-4 text-sm">
              <div className="flex justify-between gap-2"><span className="text-text-muted">{t("Atendente")}</span><OwnerBadge ownerKind={owner.kind} ownerName={owner.name} agentVersion={owner.agentVersion} /></div>
              {produtosComprados(lead.tags).length > 0 && <div className="flex justify-between gap-2"><span className="text-text-muted">{t("Produto comprado")}</span><span>{produtosComprados(lead.tags).join(", ")}</span></div>}
              <div className="flex justify-between gap-2"><span className="text-text-muted">{t("Telefone")}</span><span>{contato?.phone_number ?? "—"}</span></div>
              <div className="flex justify-between gap-2"><span className="text-text-muted">{t("E-mail")}</span><span className="break-all">{contato?.email ?? "—"}</span></div>
            </TabsContent>
            <TabsContent value="negocios" className="space-y-2 py-4 text-sm">
              {vinculos.isLoading && lead.contact_id && t("Carregando…")}
              {vinculos.isError && t("Não foi possível carregar os vínculos do contato.")}
              {!vinculos.isLoading && !vinculos.isError && (vinculos.data?.data.leads.length ? vinculos.data.data.leads.map((item) => <Link key={item.id} className="block rounded-md border border-border p-2 hover:bg-surface-muted" href={`/app/pipelines/${item.pipeline_id}?lead=${item.id}`}>{numeroDoNegocio(item.id)} · {item.title}</Link>) : t("Nenhum negócio encontrado."))}
            </TabsContent>
            <TabsContent value="atendimentos" className="space-y-2 py-4 text-sm">
              {vinculos.isLoading && lead.contact_id && t("Carregando…")}
              {vinculos.isError && t("Não foi possível carregar os vínculos do contato.")}
              {!vinculos.isLoading && !vinculos.isError && (vinculos.data?.data.conversations.length ? vinculos.data.data.conversations.map((item) => <Link key={item.id} className="block rounded-md border border-border p-2 hover:bg-surface-muted" href={`/app/inbox?id=${item.id}`}>{item.last_message_preview || t("conversa sem mensagens")}</Link>) : t("Nenhum atendimento encontrado."))}
            </TabsContent>
            <TabsContent value="atividades" className="py-4"><LeadTimeline itens={timeline.itens} chegouAoVivo={timeline.chegouAoVivo} isLoading={timeline.isLoading} isError={timeline.isError} /></TabsContent>
          </Tabs>
        </section>
        <section className="min-w-0" aria-label={t("Negócio")}>
        <div className="mb-4 grid gap-2 sm:grid-cols-2"><div className="rounded-lg border border-border bg-surface p-3"><p className="text-xs text-text-muted">{t("Valor total")}</p><p className="font-semibold">{formatBRL(lead.value_cents, lead.currency)}</p></div><div className="rounded-lg border border-border bg-surface p-3"><p className="text-xs text-text-muted">{t("Criado em")}</p><p className="font-semibold">{new Date(lead.created_at).toLocaleDateString(tagDoIdioma)}</p></div></div>
        <JornadaDoNegocio stages={stages} stageId={lead.stage_id} />
        {/* ① cabeçalho vivo */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border pb-3 text-xs">
          <span className="font-medium tabular-nums text-text">
            {formatBRL(lead.value_cents, lead.currency)}
          </span>
          <span className="text-text-muted">{stageName}</span>
          <OwnerBadge
            ownerKind={owner.kind}
            ownerName={owner.name}
            agentVersion={owner.agentVersion}
          />
          {score && (
            // O MESMO componente do card, não uma cópia do medidor.
            // "Superfície nova herda as decisões da antiga" só vale como
            // mecanismo: herdar por cópia é como as duas listas do evidence —
            // funciona hoje e diverge no mês em que alguém mudar um dos dois.
            // De brinde, o rótulo honesto da âncora ("registro que sustenta",
            // nunca "momento da conversa") vem junto, sem eu reescrever nada.
            <ScoreSlot
              probability={score.probability}
              band={score.band}
              reason={score.reason}
              factors={score.factors.slice(0, 3)}
            />
          )}

          <BotaoRegistrarVenda contactId={lead.contact_id} leadId={lead.id} nomeDoContato={nome} className="ml-auto" />
          <button
            type="button"
            onClick={() => {
              // Os campos moram na aba Resumo: volta para ela e rola quando o conteúdo já estiver montado.
              setAba("resumo");
              requestAnimationFrame(() => campos.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
            }}
            className="text-text-muted underline-offset-2 hover:text-text hover:underline"
          >
            {t("Editar campos")}
          </button>
        </div>

        {/* O score NÃO aparece na timeline: recálculo é telemetria e não emite
            atividade (silêncio para telemetria, pulso para mudança de estado).
            Sem esta linha, quem visse o número mudando no cabeçalho e nunca na
            timeline concluiria que a timeline está incompleta. */}
        {score?.at && (
          <p className="pt-2 text-[11px] text-text-muted">
            {t("Probabilidade recalculada automaticamente")} ·{" "}
            {new Date(score.at).toLocaleString(tagDoIdioma)}
          </p>
        )}

        <Tabs value={aba} onValueChange={setAba} className="flex flex-1 flex-col">
          <TabsList className="mt-3 self-start">
            <TabsTrigger value="resumo">{t("Resumo")}</TabsTrigger>
            <TabsTrigger value="produtos">{t("Produtos")}</TabsTrigger>
            <TabsTrigger value="valores">{t("Valores")}</TabsTrigger>
            <TabsTrigger value="historico">{t("Histórico")}</TabsTrigger>
          </TabsList>

          <TabsContent value="valores" className="py-3 text-sm">{t("Valor total")}: {formatBRL(lead.value_cents, lead.currency)}</TabsContent>
          <TabsContent value="historico" className="py-3"><LeadTimeline itens={timeline.itens} chegouAoVivo={timeline.chegouAoVivo} isLoading={timeline.isLoading} isError={timeline.isError} /></TabsContent>

          {/* A aba Produtos monta só quando abre (Radix): o valor do cabeçalho acima é o do banco, que acompanha a soma dos itens. */}
          <TabsContent value="produtos" className="py-3">
            <AbaProdutosDoNegocio leadId={lead.id} />
          </TabsContent>

          <TabsContent value="resumo" className="mt-0 flex flex-1 flex-col">

            {/* ② timeline */}
            <section className="flex-1 py-3">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                {t("Linha do tempo")}
              </h3>
              <LeadTimeline
                itens={timeline.itens}
                chegouAoVivo={timeline.chegouAoVivo}
                isLoading={timeline.isLoading}
                isError={timeline.isError}
              />
            </section>

            {/* ③ campos, por último */}
            <div ref={campos} className="border-t border-border pt-3">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                {t("Dados do negócio")}
              </h3>
              <LeadFieldsForm lead={lead} pipelineId={pipelineId} fieldDefs={fieldDefs} />
            </div>
          </TabsContent>
        </Tabs>
        </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
