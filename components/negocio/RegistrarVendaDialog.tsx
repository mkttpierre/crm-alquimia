"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/types";
import { useAlvoDaVenda } from "@/hooks/negocio/useAlvoDaVenda";
import { useCatalogoParaNegocio } from "@/hooks/negocio/useItensDoNegocio";
import { useRegistrarVenda } from "@/hooks/negocio/useRegistrarVenda";
import { useT } from "@/hooks/i18n/useT";
import { formatCents } from "@/lib/money";
import {
  lerRascunho,
  linhaAvulsa,
  linhaDoProduto,
  totalDoRascunho,
  type ErroDoRascunho,
  type LinhaRascunho,
} from "@/lib/negocio/rascunho-venda";
import { produtosParaSeletor } from "@/lib/negocio/seletor-produtos";
import { randomId } from "@/lib/random-id";

interface Props {
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
  /** Contato que comprou. Pode faltar quando se vem de um negócio sem contato (aí vale `leadId`). */
  contactId?: string | null;
  /** Negócio de onde o botão foi clicado (dossiê): se estiver aberto, é ele que ganha. */
  leadId?: string | null;
  /** Só para o cabeçalho do quadro. */
  nomeDoContato?: string | null;
}

/**
 * Quadro "Registrar venda": um componente só, usado na linha de /app/leads, na página do contato e no dossiê do negócio.
 *
 * É INCREMENTAL, e o quadro diz isso: ao abrir, consulta qual negócio a venda vai usar (a mesma regra da operação) e mostra
 * o que já está nele, somente leitura — "já no negócio" —, a soma do que se está lançando — "esta venda" — e o "total
 * final", que é o que ficará gravado. Confirmar grava tudo numa transação só (POST /api/v1/sales) e a confirmação mostra o
 * total que o servidor devolveu, não o que o quadro calculou. A moeda é a do negócio usado (num negócio novo, a da
 * organização) e a data é limitada ao "hoje" da organização. Registrar venda não envia mensagem nenhuma ao cliente.
 */
export function RegistrarVendaDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto" data-testid="registrar-venda">
        {/* O formulário monta a cada abertura: o rascunho nunca sobra de uma venda anterior. */}
        <Formulario {...props} />
      </DialogContent>
    </Dialog>
  );
}

function Formulario({ onOpenChange, contactId, leadId, nomeDoContato }: Props) {
  const t = useT();
  const router = useRouter();
  const alvo = useAlvoDaVenda(contactId, leadId);
  const catalogo = useCatalogoParaNegocio(true);
  const [linhas, setLinhas] = React.useState<LinhaRascunho[]>([]);
  const [busca, setBusca] = React.useState("");
  const [dataEscolhida, setDataEscolhida] = React.useState("");
  const [erro, setErro] = React.useState<ErroDoRascunho | null>(null);

  const a = alvo.data;
  // O padrão e o limite do campo são o "hoje" DA ORGANIZAÇÃO (o servidor confere de novo, no mesmo fuso).
  const data = dataEscolhida || a?.hoje || "";

  const registrar = useRegistrarVenda((venda) => {
    // O número da confirmação é o que ficou GRAVADO no negócio, na moeda dele.
    toast.success(`${t("Venda registrada")} · ${t("Total do negócio")} ${formatCents(venda.total_cents, venda.currency)}`);
    // As telas de lista (/app/leads, contato) são renderizadas no servidor: refresh traz o total novo.
    router.refresh();
    onOpenChange(false);
  });

  const todos = React.useMemo(() => catalogo.data ?? [], [catalogo.data]);
  const moeda = a?.moeda ?? "BRL";
  const seletor = React.useMemo(() => produtosParaSeletor(todos, busca, moeda), [todos, busca, moeda]);
  const estaVenda = totalDoRascunho(linhas);
  const jaNoNegocio = a?.ja_no_negocio_cents ?? 0;
  const totalFinal = jaNoNegocio + estaVenda;

  const muda = (chave: string, campo: keyof LinhaRascunho, valor: string) => {
    setErro(null);
    setLinhas((ls) => ls.map((l) => (l.chave === chave ? { ...l, [campo]: valor } : l)));
  };

  function confirmar() {
    // O que o quadro MOSTROU: o servidor recusa se, ao confirmar, o alvo real for outro (ver `negocio_previsto`).
    const r = lerRascunho(linhas, data, { contactId, leadId, negocioPrevisto: a?.negocio?.id ?? "novo" });
    if (!r.ok) {
      setErro(r.erro);
      return;
    }
    setErro(null);
    registrar.mutate(r.corpo);
  }

  const MENSAGEM: Record<ErroDoRascunho, string> = {
    sem_linhas: t("Escolha ao menos um produto."),
    valor_invalido: t("Confira o valor de cada produto."),
    quantidade_invalida: t("Confira a quantidade de cada produto."),
    desconto_invalido: t("O desconto não pode passar do valor da linha."),
    nome_vazio: t("Dê um nome ao item avulso."),
    venda_invalida: t("Confira os dados da venda."),
  };

  const pronto = !!a && !alvo.isError;
  // O negócio mostrado mudou (outro operador o encerrou): nada foi gravado; a prévia já foi recarregada acima.
  const alvoMudou = registrar.error instanceof ApiError && registrar.error.details?.motivo === "alvo_mudou";

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Registrar venda")}</DialogTitle>
        <DialogDescription>
          {nomeDoContato ? `${nomeDoContato} · ` : ""}
          {t("A venda entra como ganho no funil. Nenhuma mensagem é enviada ao cliente.")}
        </DialogDescription>
      </DialogHeader>

      {alvo.isLoading && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}
      {alvo.isError && <p role="alert" className="text-sm text-error-fg">{t("Não foi possível ler o negócio da venda.")}</p>}

      {a && (
        <section className="space-y-2 rounded-md border border-border p-3" aria-label={t("Negócio")} data-testid="alvo-da-venda">
          {a.negocio ? (
            <p className="text-sm">
              <span className="text-text-muted">{t("Negócio")}: </span>
              <span className="font-medium">{a.negocio.titulo}</span>
            </p>
          ) : (
            <p className="text-sm text-text-muted">{t("A venda abrirá um negócio novo para este contato.")}</p>
          )}
          {a.itens.length > 0 && (
            <div data-testid="ja-no-negocio">
              <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Já no negócio")}</h3>
              <ul className="mt-1 divide-y divide-border text-sm">
                {a.itens.map((i) => (
                  <li key={i.id} className="flex items-start justify-between gap-3 py-1.5">
                    <span className="min-w-0 break-words">{i.nome}</span>
                    <span className="shrink-0 tabular-nums text-text-muted">{formatCents(i.total_cents, i.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="space-y-2" aria-label={t("Produtos")}>
        <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={t("Buscar produto")} aria-label={t("Buscar produto")} />
        <div className="max-h-48 overflow-y-auto rounded-md border border-border" data-testid="seletor-de-produtos">
          {(catalogo.isLoading || alvo.isLoading) && <p className="p-3 text-sm text-text-muted">{t("Carregando…")}</p>}
          {catalogo.isError && <p className="p-3 text-sm text-error-fg">{t("Não foi possível carregar os produtos.")}</p>}
          {pronto && !catalogo.isLoading && !catalogo.isError && seletor.grupos.length === 0 && (
            <p className="p-3 text-sm text-text-muted">{t("Nenhum produto encontrado.")}</p>
          )}
          {pronto &&
            seletor.grupos.map((g) => (
              <div key={g.marca ?? "__sem_marca__"}>
                {seletor.modo === "internos" && (
                  <p className="sticky top-0 bg-surface-muted px-3 py-1 text-xs font-medium uppercase tracking-wide text-text-muted">
                    {g.marca ?? t("Sem marca")}
                  </p>
                )}
                <ul>
                  {g.produtos.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-muted"
                        onClick={() => {
                          setErro(null);
                          setLinhas((ls) => [...ls, linhaDoProduto(p, randomId())]);
                        }}
                      >
                        <span className="min-w-0 break-words">{p.nome}</span>
                        <span className="shrink-0 tabular-nums text-text-muted">{formatCents(p.preco_cents, p.moeda)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!pronto}
          onClick={() => {
            setErro(null);
            setLinhas((ls) => [...ls, linhaAvulsa(randomId())]);
          }}
        >
          {t("Item avulso (sem catálogo)")}
        </Button>
      </section>

      {linhas.length > 0 && (
        <ul className="space-y-3" data-testid="linhas-da-venda">
          {linhas.map((l) => (
            <li key={l.chave} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                {l.produtoId ? (
                  <p className="min-w-0 break-words text-sm font-medium">{l.nome}</p>
                ) : (
                  <Input value={l.nome} onChange={(e) => muda(l.chave, "nome", e.target.value)} placeholder={t("Nome do item")} aria-label={t("Nome do item")} />
                )}
                <Button type="button" variant="ghost" size="sm" onClick={() => setLinhas((ls) => ls.filter((x) => x.chave !== l.chave))}>
                  {t("Remover")}
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="block text-xs text-text-muted">
                  {t("Preço unitário")}
                  <Input inputMode="decimal" value={l.preco} onChange={(e) => muda(l.chave, "preco", e.target.value)} placeholder="0,00" className="mt-1" />
                </label>
                <label className="block text-xs text-text-muted">
                  {t("Quantidade")}
                  <Input inputMode="numeric" value={l.quantidade} onChange={(e) => muda(l.chave, "quantidade", e.target.value)} className="mt-1" />
                </label>
                <label className="block text-xs text-text-muted">
                  {t("Desconto")}
                  <Input inputMode="decimal" value={l.desconto} onChange={(e) => muda(l.chave, "desconto", e.target.value)} placeholder="0,00" className="mt-1" />
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}

      <label className="block text-xs text-text-muted">
        {t("Data da venda")}
        <Input type="date" value={data} max={a?.hoje} onChange={(e) => setDataEscolhida(e.target.value)} className="mt-1 sm:w-48" />
      </label>

      <dl className="space-y-1 border-t border-border pt-3 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-text-muted">{t("Já no negócio")}</dt>
          <dd className="tabular-nums" data-testid="total-ja-no-negocio">
            {formatCents(jaNoNegocio, moeda)}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-text-muted">{t("Esta venda")}</dt>
          <dd className="tabular-nums" data-testid="total-desta-venda">
            {formatCents(estaVenda, moeda)}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="font-medium">{t("Total final")}</dt>
          <dd className="text-base font-semibold tabular-nums" data-testid="total-final">
            {formatCents(totalFinal, moeda)}
          </dd>
        </div>
      </dl>

      {alvoMudou && (
        <p role="alert" className="text-xs text-error-fg" data-testid="alvo-mudou">
          {t("O negócio desta venda mudou enquanto você preenchia (talvez outra pessoa o tenha encerrado). Revise o que já está nele e confirme de novo.")}
        </p>
      )}

      {erro && (
        <p role="alert" className="text-xs text-error-fg">
          {MENSAGEM[erro]}
        </p>
      )}

      <DialogFooter className="gap-2 sm:gap-0">
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={registrar.isPending}>
          {t("Cancelar")}
        </Button>
        <Button type="button" onClick={confirmar} disabled={registrar.isPending || linhas.length === 0 || !pronto}>
          {t("Confirmar venda")}
        </Button>
      </DialogFooter>
    </>
  );
}
