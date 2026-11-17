"use client";

import * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useCatalogoParaNegocio, useItensDoNegocio, useMutacoesDeItens } from "@/hooks/negocio/useItensDoNegocio";
import { useT } from "@/hooks/i18n/useT";
import { formatCents } from "@/lib/money";
import { produtosParaSeletor } from "@/lib/negocio/seletor-produtos";

/**
 * "Produtos e Valores" do lead, para a barra lateral da conversa. Cada produto do catálogo já é o kit fechado
 * (ex.: "5 MESES (OURO)"), então não há quantidade, desconto nem cupom aqui: escolher o produto o adiciona na hora, com o
 * preço do catálogo, e o "X" o remove. O total embaixo é o faturamento do lead (soma dos produtos). A etiqueta
 * `COMPROU <P>` é posta pela rota ao adicionar; `aoMudar` serve para o painel recarregar as tags.
 */
export function ProdutosDoLead({ leadId, podeEditar, aoMudar }: { leadId: string; podeEditar: boolean; aoMudar?: () => void }) {
  const t = useT();
  const lista = useItensDoNegocio(leadId);
  const { criar, apagar } = useMutacoesDeItens(leadId);
  const [aberto, setAberto] = React.useState(false);
  const [busca, setBusca] = React.useState("");
  const catalogo = useCatalogoParaNegocio(aberto && podeEditar);

  const moeda = lista.data?.currency ?? "BRL";
  const seletor = React.useMemo(() => produtosParaSeletor(catalogo.data ?? [], busca, moeda), [catalogo.data, busca, moeda]);
  const ocupado = criar.isPending || apagar.isPending;

  function adicionar(produtoId: string) {
    if (!produtoId || ocupado) return;
    criar.mutate(
      { product_id: produtoId, quantidade: 1, desconto_cents: 0, acrescimo_cents: 0 },
      {
        onSuccess: () => {
          setAberto(false);
          setBusca("");
          aoMudar?.();
        },
      },
    );
  }

  if (lista.isLoading) return <Skeleton className="h-24 w-full" />;
  if (lista.isError || !lista.data) {
    return <p className="text-xs text-error-fg">{t("Não foi possível carregar os produtos deste negócio.")}</p>;
  }

  const { itens, total_cents: total } = lista.data;

  return (
    <div className="rounded-md border border-border p-3" data-testid="produtos-do-lead">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{t("Produtos e Valores")}</p>
        {podeEditar && (
          <button
            type="button"
            className="text-xs text-accent underline underline-offset-2 disabled:opacity-50"
            disabled={ocupado}
            onClick={() => setAberto((v) => !v)}
          >
            {aberto ? t("Cancelar") : `+ ${t("Adicionar produto")}`}
          </button>
        )}
      </div>

      {podeEditar && aberto && (
        <div className="mt-2 space-y-1">
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("Buscar produto")}
            aria-label={t("Buscar produto")}
            className="flex h-9 w-full rounded-sm border border-border bg-bg px-3 text-sm text-text"
          />
          <select
            className="flex h-9 w-full rounded-sm border border-border bg-bg px-2 text-sm text-text"
            value=""
            disabled={ocupado || catalogo.isLoading}
            onChange={(e) => adicionar(e.target.value)}
            aria-label={t("Produto do catálogo")}
          >
            <option value="">{catalogo.isLoading ? t("Carregando…") : t("Escolha o produto")}</option>
            {seletor.grupos.map((g) => {
              const opcoes = g.produtos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome} · {formatCents(p.preco_cents, p.moeda)}
                </option>
              ));
              return seletor.modo === "internos" ? (
                <optgroup key={g.marca ?? "__sem_marca__"} label={g.marca ?? t("Sem marca")}>
                  {opcoes}
                </optgroup>
              ) : (
                opcoes
              );
            })}
          </select>
        </div>
      )}

      {itens.length === 0 && !aberto && <p className="mt-2 text-xs text-text-muted">{t("Nenhum produto neste negócio ainda.")}</p>}

      <ul className="mt-2 divide-y divide-border">
        {itens.map((i) => (
          <li key={i.id} className="flex items-start justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <p className="break-words font-medium text-text">{i.nome}</p>
              {i.sku && <p className="text-xs text-text-muted">SKU: {i.sku}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-medium tabular-nums text-text">{formatCents(i.total_cents, i.currency)}</span>
              {podeEditar && (
                <button
                  type="button"
                  aria-label={`${t("Remover")} ${i.nome}`}
                  disabled={ocupado}
                  className="rounded px-1 text-text-muted hover:text-error-fg disabled:opacity-50"
                  onClick={() => apagar.mutate(i.id, { onSuccess: () => aoMudar?.() })}
                >
                  ✕
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
        <span className="text-xs text-text-muted">
          {t("Faturado com esta pessoa")}
          {itens.length > 0 ? ` · ${itens.length}` : ""}
        </span>
        <span className="text-lg font-semibold tabular-nums text-text" data-testid="faturado-do-lead">
          {formatCents(total, moeda)}
        </span>
      </div>
    </div>
  );
}
