"use client";

import { format } from "date-fns";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { usePurchaseHistory } from "@/hooks/negocio/usePurchaseHistory";
import { formatCents } from "@/lib/money";

function Numero({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{rotulo}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-text">{valor}</dd>
    </div>
  );
}

/**
 * Aba "Compras" do contato: negócios ganhos (com as linhas de produto) + pedidos pagos da loja, com total gasto, nº de
 * compras, última compra e ciclo médio entre compras. Os números vêm prontos do servidor (`purchase-history`).
 */
export function HistoricoDeCompras({ contactId }: { contactId: string }) {
  const t = useT();
  const locale = useLocaleDeData();
  const q = usePurchaseHistory(contactId);

  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  if (q.isError || !q.data) return <p className="text-sm text-error-fg">{t("Não foi possível carregar as compras.")}</p>;

  const h = q.data;
  const dia = (iso: string) => format(new Date(iso), "dd/MM/yyyy", { locale });

  return (
    <div className="space-y-4" data-testid="historico-de-compras">
      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Numero rotulo={t("Total gasto")} valor={formatCents(h.total_gasto_cents, h.currency)} />
          <Numero rotulo={t("Compras")} valor={String(h.numero_de_compras)} />
          <Numero rotulo={t("Última compra")} valor={h.ultima_compra ? dia(h.ultima_compra) : "—"} />
          <Numero
            rotulo={t("Ciclo médio entre compras")}
            valor={h.ciclo_medio_dias === null ? "—" : `${String(h.ciclo_medio_dias).replace(".", ",")} ${t("dias")}`}
          />
        </dl>
      </Card>

      {h.compras.length === 0 ? (
        <p className="text-sm text-text-muted">{t("Este contato ainda não comprou.")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {h.compras.map((c) => (
            <li key={`${c.tipo}-${c.id}`} className="space-y-1 p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-medium text-text">{c.titulo}</p>
                  <p className="text-xs text-text-muted">
                    {dia(c.data)} · {c.tipo === "negocio" ? t("Negócio ganho") : t("Pedido da loja")}
                  </p>
                </div>
                <span className="shrink-0 font-medium tabular-nums text-text">{formatCents(c.total_cents, h.currency)}</span>
              </div>
              {c.itens.length > 0 && (
                <ul className="text-xs text-text-muted">
                  {c.itens.map((i, idx) => (
                    <li key={`${c.id}-${idx}`}>
                      {i.quantidade} × {i.nome} · {formatCents(i.total_cents, h.currency)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {h.ignoradas_outra_moeda > 0 && <p className="text-xs text-text-muted">{t("Compras em outra moeda não entram na soma.")}</p>}
    </div>
  );
}
