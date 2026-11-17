"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocaleDeData, useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { Granularidade, PainelDeFaturamento, VendaDoPeriodo } from "@/lib/negocio/faturamento";
import { SEM_PRODUTO, variacaoPercentual } from "@/lib/negocio/faturamento";
import { formatCents } from "@/lib/money";

import { GraficoDeFaturamento } from "./GraficoDeFaturamento";

type Resposta = PainelDeFaturamento & { timezone: string; truncado: boolean };

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const somar = (d: Date, dias: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + dias);
const MAX_NO_RANKING = 8;

/** Quanto a métrica mudou contra o período anterior de mesmo tamanho. Sem base de comparação, diz isso em vez de inventar %. */
function Variacao({ atual, anterior }: { atual: number; anterior: number }) {
  const t = useT();
  const tag = useTagDeIdioma();
  const v = variacaoPercentual(atual, anterior);
  if (v === null) return <p className="mt-1 text-xs text-text-muted">{t("Sem período anterior para comparar")}</p>;
  const texto = new Intl.NumberFormat(tag, { maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(v);
  const cor = v > 0 ? "text-success-fg" : v < 0 ? "text-error-fg" : "text-text-muted";
  return (
    <p className={`mt-1 text-xs ${cor}`} data-testid="variacao">
      <span aria-hidden>{v > 0 ? "▲" : v < 0 ? "▼" : "•"} </span>
      {texto}% <span className="text-text-muted">{t("vs. período anterior")}</span>
    </p>
  );
}

function Cartao({ rotulo, valor, apoio, children }: { rotulo: string; valor: string; apoio?: string; children?: React.ReactNode }) {
  return (
    <Card className="min-w-0 p-4">
      <p className="text-xs uppercase text-muted-foreground">{rotulo}</p>
      <p className="mt-1 truncate text-2xl font-semibold tabular-nums text-text">{valor}</p>
      {apoio && <p className="mt-1 break-words text-xs text-text-muted">{apoio}</p>}
      {children}
    </Card>
  );
}

function Secao({ titulo, children, className }: { titulo: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={`min-w-0 p-4 ${className ?? ""}`}>
      <h2 className="mb-3 text-sm font-medium text-text">{titulo}</h2>
      {children}
    </Card>
  );
}

export function FaturamentoClient() {
  const t = useT();
  const locale = useLocaleDeData();
  const tag = useTagDeIdioma();
  const [desde, setDesde] = React.useState("");
  const [ate, setAte] = React.useState("");
  const [gran, setGran] = React.useState<Granularidade>("dia");

  const q = useQuery({
    queryKey: ["revenue", desde, ate, gran],
    queryFn: async () => {
      const sp = new URLSearchParams({ granularidade: gran });
      if (desde && ate) {
        sp.set("desde", desde);
        sp.set("ate", ate);
      }
      return (await apiClient.get<{ data: Resposta }>(`/api/v1/revenue?${sp.toString()}`)).data;
    },
    placeholderData: (anterior) => anterior,
  });

  // Primeira resposta sem período escolhido: a API usou os últimos 30 dias e os campos passam a mostrá-los.
  React.useEffect(() => {
    if (q.data && !desde && !ate) {
      setDesde(q.data.desde);
      setAte(q.data.ate);
    }
  }, [q.data, desde, ate]);

  function atalho(dias: number | "mes") {
    const hoje = new Date();
    setAte(ymd(hoje));
    setDesde(dias === "mes" ? ymd(new Date(hoje.getFullYear(), hoje.getMonth(), 1)) : ymd(somar(hoje, -(dias - 1))));
  }

  const d = q.data;
  const rotuloDoPeriodo = (chave: string): string => {
    // placeholderData pode manter a série da granularidade anterior enquanto a nova consulta carrega.
    const granularidadeVisivel = d?.granularidade ?? gran;
    try {
      if (granularidadeVisivel === "mes") {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(chave)) return chave;
        const [ano, mes] = chave.split("-").map(Number);
        const data = new Date(ano!, mes! - 1, 1, 12);
        if (data.getFullYear() !== ano || data.getMonth() !== mes! - 1) return chave;
        return format(data, "MMM/yyyy", { locale });
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(chave)) return chave;
      const [ano, mes, diaNumero] = chave.split("-").map(Number);
      const data = new Date(ano!, mes! - 1, diaNumero!, 12);
      if (data.getFullYear() !== ano || data.getMonth() !== mes! - 1 || data.getDate() !== diaNumero) return chave;
      const dia = format(data, "dd/MM", { locale });
      return granularidadeVisivel === "semana" ? `${t("Semana de")} ${dia}` : dia;
    } catch {
      return chave;
    }
  };

  const moeda = d?.currency ?? "BRL";
  const dataDaVenda = (v: VendaDoPeriodo) => {
    try {
      return new Intl.DateTimeFormat(tag, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: d?.timezone }).format(new Date(v.data));
    } catch {
      return v.data.slice(0, 10);
    }
  };
  const nomeDoAtendente = (tipo: "usuario" | "ia" | "sem_atendente", nome: string | null) =>
    tipo === "ia" ? t("Agente de IA") : tipo === "sem_atendente" ? t("Sem atendente") : (nome ?? "—");

  // "Mais vendidos": por quantidade, depois por valor. A sobra sem produto (valor sem item) fica de fora do ranking.
  const maisVendidos = (d?.por_produto ?? [])
    .filter((p) => p.chave !== SEM_PRODUTO)
    .sort((a, b) => b.quantidade - a.quantidade || b.total_cents - a.total_cents)
    .slice(0, MAX_NO_RANKING);
  const semProduto = d?.por_produto.find((p) => p.chave === SEM_PRODUTO);

  return (
    <div className="min-w-0 max-w-full space-y-6" data-testid="faturamento">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs text-text-muted">
          {t("De")}
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="mt-1 w-40" />
        </label>
        <label className="block text-xs text-text-muted">
          {t("Até")}
          <Input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="mt-1 w-40" />
        </label>
        <label className="block text-xs text-text-muted">
          {t("Agrupar por")}
          <select
            className="mt-1 flex h-10 w-32 rounded-sm border border-border bg-bg px-3 text-sm text-text"
            value={gran}
            onChange={(e) => setGran(e.target.value as Granularidade)}
          >
            <option value="dia">{t("Dia")}</option>
            <option value="semana">{t("Semana")}</option>
            <option value="mes">{t("Mês")}</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => atalho(7)}>
            {t("Últimos 7 dias")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => atalho(30)}>
            {t("Últimos 30 dias")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => atalho("mes")}>
            {t("Este mês")}
          </Button>
        </div>
      </div>

      {q.isLoading && <Skeleton className="h-40 w-full" />}
      {q.isError && !d && <p className="text-sm text-error-fg">{t("Não foi possível carregar o faturamento.")}</p>}

      {d && (
        <>
          {d.truncado && (
            <p role="alert" className="rounded-md border border-border bg-warning-bg p-3 text-sm text-warning-fg">
              {t("Os números estão incompletos: o período tem vendas demais para ler de uma vez. Reduza o período.")}
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Cartao
              rotulo={t("Faturamento")}
              valor={formatCents(d.total_cents, moeda)}
              apoio={
                d.somente_negocios
                  ? `${t("Negócios")} ${formatCents(d.receita_negocios_cents, moeda)}`
                  : `${t("Negócios")} ${formatCents(d.receita_negocios_cents, moeda)} · ${t("Pedidos da loja")} ${formatCents(d.receita_pedidos_cents, moeda)}`
              }
            >
              <Variacao atual={d.total_cents} anterior={d.anterior.total_cents} />
            </Cartao>
            <Cartao rotulo={t("Vendas")} valor={String(d.numero_de_vendas)}>
              <Variacao atual={d.numero_de_vendas} anterior={d.anterior.numero_de_vendas} />
            </Cartao>
            <Cartao rotulo={t("Ticket médio")} valor={d.ticket_medio_cents === null ? "—" : formatCents(d.ticket_medio_cents, moeda)}>
              {d.ticket_medio_cents !== null && d.anterior.ticket_medio_cents !== null ? (
                <Variacao atual={d.ticket_medio_cents} anterior={d.anterior.ticket_medio_cents} />
              ) : (
                <p className="mt-1 text-xs text-text-muted">{t("Sem período anterior para comparar")}</p>
              )}
            </Cartao>
          </div>
          {d.somente_negocios && d.fora_do_total && (
            <p className="text-xs text-text-muted" data-testid="fora-do-total">
              {t("Fora do total")}: {t("Pedidos da loja")} {d.fora_do_total.pedidos} · {formatCents(d.fora_do_total.pedidos_cents, moeda)}. {t("O total conta só os negócios ganhos.")}
            </p>
          )}
          {d.ignorados_outra_moeda > 0 && <p className="text-xs text-text-muted">{t("Vendas em outra moeda não entram na soma.")}</p>}

          {d.numero_de_vendas === 0 ? (
            <Card className="flex flex-col items-start gap-3 p-6" data-testid="faturamento-vazio">
              <p className="text-sm font-medium text-text">{t("Nenhuma venda neste período.")}</p>
              <p className="text-sm text-text-muted">{t("Registre uma venda pela tela de Leads e ela aparece aqui.")}</p>
              <Button asChild>
                <Link href="/app/leads">{t("Ir para Leads")}</Link>
              </Button>
            </Card>
          ) : (
            <>
              <Secao titulo={t("Por período")}>
                <GraficoDeFaturamento
                  moeda={moeda}
                  pontos={d.serie.map((s) => ({ chave: s.chave, rotulo: rotuloDoPeriodo(s.chave), total_cents: s.total_cents, vendas: s.vendas }))}
                />
              </Secao>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Secao titulo={t("Produtos mais vendidos")}>
                  {maisVendidos.length === 0 ? (
                    <p className="text-sm text-text-muted">{t("Sem produto informado")}</p>
                  ) : (
                    <ol className="space-y-2" data-testid="ranking-de-produtos">
                      {maisVendidos.map((p) => (
                        <li key={p.chave} className="grid grid-cols-[1fr_auto] gap-x-3 text-sm">
                          <span className="min-w-0 break-words">{p.nome}</span>
                          <span className="text-right tabular-nums">{formatCents(p.total_cents, moeda)}</span>
                          <span className="text-xs text-text-muted">
                            {p.quantidade} {t("vendidos")}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {semProduto && (
                    <p className="mt-3 text-xs text-text-muted">
                      {t("Sem produto informado")}: {formatCents(semProduto.total_cents, moeda)}
                    </p>
                  )}
                </Secao>

                <Secao titulo={t("Atendentes com mais vendas")}>
                  {d.por_atendente.length === 0 ? (
                    <p className="text-sm text-text-muted">{t("Os pedidos da loja não têm atendente.")}</p>
                  ) : (
                    <ol className="space-y-2" data-testid="ranking-de-atendentes">
                      {d.por_atendente.map((a) => (
                        <li key={`${a.tipo}:${a.user_id ?? ""}`} className="grid grid-cols-[1fr_auto] gap-x-3 text-sm">
                          <span className="min-w-0 break-words">{nomeDoAtendente(a.tipo, a.nome)}</span>
                          <span className="text-right tabular-nums">{formatCents(a.total_cents, moeda)}</span>
                          <span className="text-xs text-text-muted">
                            {a.vendas} {t(a.vendas === 1 ? "venda" : "vendas")}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </Secao>

                <Secao titulo={t("Por funil")}>
                  <ol className="space-y-2" data-testid="ranking-de-funis">
                    {d.por_pipeline.map((p) => (
                      <li key={p.pipeline_id} className="grid grid-cols-[1fr_auto] gap-x-3 text-sm">
                        <span className="min-w-0 break-words">{p.nome ?? "—"}</span>
                        <span className="text-right tabular-nums">{formatCents(p.total_cents, moeda)}</span>
                        <span className="text-xs text-text-muted">
                          {p.vendas} {t(p.vendas === 1 ? "venda" : "vendas")}
                        </span>
                      </li>
                    ))}
                  </ol>
                </Secao>
              </div>

              <Secao titulo={t("Vendas do período")}>
                {/* Sem <table>: no celular cada venda vira um bloco de duas linhas, e a página não rola para os lados. */}
                <div role="table" aria-label={t("Vendas do período")} className="min-w-0 text-sm" data-testid="tabela-de-vendas">
                  <div role="row" className="hidden grid-cols-[6rem_minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_7rem] gap-3 border-b border-border pb-2 text-xs uppercase text-muted-foreground md:grid">
                    <span role="columnheader">{t("Data")}</span>
                    <span role="columnheader">{t("Lead")}</span>
                    <span role="columnheader">{t("Produtos")}</span>
                    <span role="columnheader">{t("Atendente")}</span>
                    <span role="columnheader">{t("Funil")}</span>
                    <span role="columnheader" className="text-right">
                      {t("Valor")}
                    </span>
                  </div>
                  {d.vendas.map((v) => (
                    <div
                      role="row"
                      key={`${v.tipo}:${v.id}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b border-border py-2 last:border-0 md:grid-cols-[6rem_minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_7rem] md:items-center md:gap-3"
                    >
                      <span role="cell" className="order-2 text-xs text-text-muted md:order-none md:text-sm md:text-text">
                        {dataDaVenda(v)}
                      </span>
                      <span role="cell" className="order-1 min-w-0 break-words font-medium md:order-none">
                        {v.lead_id ? (
                          <Link className="hover:underline" href={`/app/pipelines/${v.pipeline_id}?lead=${v.lead_id}`}>
                            {v.titulo ?? t("Negócio")}
                          </Link>
                        ) : (
                          t("Pedido da loja")
                        )}
                      </span>
                      <span role="cell" className="order-3 col-span-2 min-w-0 break-words text-xs text-text-muted md:order-none md:col-span-1 md:text-sm md:text-text">
                        {v.produtos.length > 0 ? v.produtos.join(", ") : "—"}
                      </span>
                      <span role="cell" className="order-4 min-w-0 break-words text-xs text-text-muted md:order-none md:text-sm md:text-text">
                        {v.atendente_tipo ? nomeDoAtendente(v.atendente_tipo, v.atendente_nome) : "—"}
                      </span>
                      <span role="cell" className="order-5 min-w-0 break-words text-xs text-text-muted md:order-none md:text-sm md:text-text">
                        {v.funil ?? "—"}
                      </span>
                      <span role="cell" className="order-1 text-right font-medium tabular-nums md:order-none">
                        {formatCents(v.valor_cents, moeda)}
                      </span>
                    </div>
                  ))}
                </div>
                {d.vendas_cortadas && <p className="mt-3 text-xs text-text-muted">{t("Mostrando as 200 vendas mais recentes do período.")}</p>}
              </Secao>
            </>
          )}
        </>
      )}
    </div>
  );
}
