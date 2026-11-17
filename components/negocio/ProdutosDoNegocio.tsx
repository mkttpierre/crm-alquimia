"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCatalogoParaNegocio, useItensDoNegocio, useMutacoesDeItens } from "@/hooks/negocio/useItensDoNegocio";
import { useT } from "@/hooks/i18n/useT";
import { formatCents } from "@/lib/money";
import type { ItemDoNegocio } from "@/lib/negocio/repositorio-itens";
import { produtosParaSeletor } from "@/lib/negocio/seletor-produtos";
import { totalDoItem } from "@/lib/negocio/totais";
import { precoParaCentavos } from "@/lib/schemas/produtos";

interface Rascunho {
  produtoId: string;
  nome: string;
  preco: string;
  quantidade: string;
  desconto: string;
  acrescimo: string;
  cupom: string;
}

const VAZIO: Rascunho = { produtoId: "", nome: "", preco: "", quantidade: "1", desconto: "", acrescimo: "", cupom: "" };

const reais = (cents: number): string => (cents / 100).toFixed(2).replace(".", ",");

/** Campo vazio de desconto/acréscimo vale 0; texto ilegível vale `null` (a tela recusa em vez de adivinhar). */
const centavosOuZero = (texto: string): number | null => (texto.trim() === "" ? 0 : precoParaCentavos(texto));

function doItem(i: ItemDoNegocio): Rascunho {
  return {
    produtoId: i.product_id ?? "",
    nome: i.nome,
    preco: reais(i.preco_unit_cents),
    quantidade: String(i.quantidade),
    desconto: i.desconto_cents ? reais(i.desconto_cents) : "",
    acrescimo: i.acrescimo_cents ? reais(i.acrescimo_cents) : "",
    cupom: i.cupom ?? "",
  };
}

/** Os números do rascunho já em centavos, ou `null` se algo não for legível. */
function leitura(r: Rascunho) {
  const preco = precoParaCentavos(r.preco);
  const desconto = centavosOuZero(r.desconto);
  const acrescimo = centavosOuZero(r.acrescimo);
  const quantidade = Number(r.quantidade);
  if (preco === null || desconto === null || acrescimo === null) return null;
  if (!Number.isInteger(quantidade) || quantidade < 1) return null;
  return { preco_unit_cents: preco, desconto_cents: desconto, acrescimo_cents: acrescimo, quantidade };
}

function totalDoRascunho(r: Rascunho): number | null {
  const n = leitura(r);
  if (!n) return null;
  try {
    return totalDoItem(n);
  } catch {
    return null;
  }
}

/**
 * Aba "Produtos" do negócio: linhas de produto do catálogo ou avulsas, com quantidade, desconto, acréscimo e cupom.
 * O total vem do servidor (o banco soma e mantém o valor do negócio igual); o total do formulário é só prévia.
 */
export function ProdutosDoNegocio({ leadId, podeEditar, aoMudar }: { leadId: string; podeEditar: boolean; aoMudar?: () => void }) {
  const t = useT();
  const lista = useItensDoNegocio(leadId);
  const { criar, atualizar, apagar } = useMutacoesDeItens(leadId);
  const [aberto, setAberto] = React.useState(false);
  const [editandoId, setEditandoId] = React.useState<string | null>(null);
  const [rascunho, setRascunho] = React.useState<Rascunho>(VAZIO);
  const [erro, setErro] = React.useState<string | null>(null);
  const [busca, setBusca] = React.useState("");
  const catalogo = useCatalogoParaNegocio(aberto && podeEditar);

  const moeda = lista.data?.currency ?? "BRL";
  // Com produto interno ativo (planos de comissão) o seletor mostra SÓ eles, por marca e com busca; sem, o catálogo de sempre.
  const seletor = React.useMemo(() => produtosParaSeletor(catalogo.data ?? [], busca, moeda), [catalogo.data, busca, moeda]);
  const previa = totalDoRascunho(rascunho);
  const muda = (campo: keyof Rascunho) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setRascunho((r) => ({ ...r, [campo]: e.target.value }));

  function escolherProduto(id: string) {
    const p = (catalogo.data ?? []).find((x) => x.id === id);
    setRascunho((r) => (p ? { ...r, produtoId: id, nome: p.nome, preco: reais(p.preco_cents) } : { ...r, produtoId: "" }));
  }

  function fechar() {
    setAberto(false);
    setEditandoId(null);
    setRascunho(VAZIO);
    setErro(null);
    setBusca("");
  }

  const aposSalvar = () => {
    fechar();
    aoMudar?.();
  };

  function salvar() {
    const n = leitura(rascunho);
    if (!n || totalDoRascunho(rascunho) === null) {
      setErro(t("Valores inválidos. Confira preço, quantidade, desconto e acréscimo."));
      return;
    }
    const cupom = rascunho.cupom.trim() === "" ? null : rascunho.cupom.trim();
    if (editandoId) {
      atualizar.mutate({ item_id: editandoId, ...n, nome: rascunho.nome.trim() || undefined, cupom }, { onSuccess: aposSalvar });
      return;
    }
    if (!rascunho.produtoId && rascunho.nome.trim() === "") {
      setErro(t("Escolha um produto do catálogo ou dê um nome ao item avulso."));
      return;
    }
    criar.mutate(
      {
        ...(rascunho.produtoId ? { product_id: rascunho.produtoId } : { nome: rascunho.nome.trim() }),
        ...n,
        cupom,
      },
      { onSuccess: aposSalvar },
    );
  }

  if (lista.isLoading) return <Skeleton className="h-24 w-full" />;
  if (lista.isError || !lista.data) {
    return <p className="text-sm text-error-fg">{t("Não foi possível carregar os produtos deste negócio.")}</p>;
  }

  const { itens, total_cents: total, ignorados_outra_moeda: ignorados } = lista.data;
  const ocupado = criar.isPending || atualizar.isPending || apagar.isPending;

  return (
    <div className="space-y-3" data-testid="produtos-do-negocio">
      {itens.length === 0 && !aberto && <p className="text-sm text-text-muted">{t("Nenhum produto neste negócio ainda.")}</p>}

      <ul className="divide-y divide-border">
        {itens.map((i) => (
          <li key={i.id} className="flex items-start justify-between gap-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="break-words font-medium text-text">{i.nome}</p>
              <p className="text-xs text-text-muted">
                {i.quantidade} × {formatCents(i.preco_unit_cents, i.currency)}
                {i.sku ? ` · ${i.sku}` : ""}
                {i.desconto_cents > 0 ? ` · ${t("Desconto")} −${formatCents(i.desconto_cents, i.currency)}` : ""}
                {i.acrescimo_cents > 0 ? ` · ${t("Acréscimo")} +${formatCents(i.acrescimo_cents, i.currency)}` : ""}
                {i.cupom ? ` · ${t("Cupom")} ${i.cupom}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-medium tabular-nums text-text">{formatCents(i.total_cents, i.currency)}</span>
              {podeEditar && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={ocupado}
                    onClick={() => {
                      setEditandoId(i.id);
                      setRascunho(doItem(i));
                      setAberto(true);
                      setErro(null);
                    }}
                  >
                    {t("Editar")}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={ocupado} onClick={() => apagar.mutate(i.id, { onSuccess: () => aoMudar?.() })}>
                    {t("Remover")}
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t border-border pt-2 text-sm">
        <span className="text-text-muted">{t("Total do negócio")}</span>
        <span className="font-semibold tabular-nums text-text">{formatCents(total, moeda)}</span>
      </div>
      {ignorados > 0 && <p className="text-xs text-text-muted">{t("Itens em outra moeda não entram no total.")}</p>}

      {podeEditar && !aberto && (
        <Button type="button" variant="outline" size="sm" onClick={() => setAberto(true)}>
          {t("Adicionar produto")}
        </Button>
      )}

      {podeEditar && aberto && (
        <form
          className="space-y-2 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            salvar();
          }}
        >
          {!editandoId && (
            <div className="space-y-1">
              <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={t("Buscar produto")} aria-label={t("Buscar produto")} />
              <label className="block text-xs text-text-muted">
                {t("Produto do catálogo")}
                <select
                  className="mt-1 flex h-10 w-full rounded-sm border border-border bg-bg px-3 text-sm text-text"
                  value={rascunho.produtoId}
                  onChange={(e) => escolherProduto(e.target.value)}
                  aria-label={t("Produto do catálogo")}
                >
                  <option value="">{t("Item avulso (sem catálogo)")}</option>
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
              </label>
            </div>
          )}

          <label className="block text-xs text-text-muted">
            {t("Nome do item")}
            <Input value={rascunho.nome} onChange={muda("nome")} disabled={!!rascunho.produtoId && !editandoId} className="mt-1" />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-text-muted">
              {t("Preço unitário")}
              <Input inputMode="decimal" value={rascunho.preco} onChange={muda("preco")} placeholder="0,00" className="mt-1" />
            </label>
            <label className="block text-xs text-text-muted">
              {t("Quantidade")}
              <Input inputMode="numeric" value={rascunho.quantidade} onChange={muda("quantidade")} className="mt-1" />
            </label>
            <label className="block text-xs text-text-muted">
              {t("Desconto")}
              <Input inputMode="decimal" value={rascunho.desconto} onChange={muda("desconto")} placeholder="0,00" className="mt-1" />
            </label>
            <label className="block text-xs text-text-muted">
              {t("Acréscimo")}
              <Input inputMode="decimal" value={rascunho.acrescimo} onChange={muda("acrescimo")} placeholder="0,00" className="mt-1" />
            </label>
          </div>

          <label className="block text-xs text-text-muted">
            {t("Cupom")}
            <Input value={rascunho.cupom} onChange={muda("cupom")} maxLength={40} className="mt-1" />
          </label>

          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">{t("Total do item")}</span>
            <span className="font-medium tabular-nums text-text">{previa === null ? "—" : formatCents(previa, moeda)}</span>
          </div>
          {erro && (
            <p role="alert" className="text-xs text-error-fg">
              {erro}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={fechar} disabled={ocupado}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" size="sm" disabled={ocupado}>
              {editandoId ? t("Salvar") : t("Adicionar")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
