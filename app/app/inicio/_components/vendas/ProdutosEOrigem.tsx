import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { formatCents } from "@/lib/money";
import type { PainelDeVendas } from "@/lib/negocio/painel-vendas";

import { Cartao, SemDado } from "../Cartao";

/** Produtos mais vendidos do período: quantidade e valor. O valor é o dos itens do negócio, como na tela Faturamento. */
export function ProdutosMaisVendidos({ painel, idioma }: { painel: PainelDeVendas; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const n = (v: number) => new Intl.NumberFormat(tagDeIdioma(idioma)).format(v);
  const titulo = t("Produtos mais vendidos");

  if (painel.produtos.length === 0) {
    return (
      <Cartao titulo={titulo}>
        <SemDado texto={t("Os produtos aparecem aqui quando as vendas do período têm itens do catálogo.")} />
      </Cartao>
    );
  }

  return (
    <Cartao titulo={titulo} subtitulo={t("Por quantidade vendida no período")}>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="text-[12px] text-muted-foreground">
            <tr>
              <th scope="col" className="pb-2 pr-3 font-medium">
                {t("Produto")}
              </th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">
                {t("Qtd.")}
              </th>
              <th scope="col" className="pb-2 text-right font-medium">
                {t("Valor")}
              </th>
            </tr>
          </thead>
          <tbody>
            {painel.produtos.map((p) => (
              <tr key={p.chave} className="border-t border-border">
                <td className="max-w-[16rem] truncate py-2 pr-3">{p.nome}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{n(p.quantidade)}</td>
                <td className="py-2 text-right tabular-nums">{formatCents(p.total_cents, painel.moeda)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {painel.sem_produto_cents > 0 && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {`${formatCents(painel.sem_produto_cents, painel.moeda)} ${t("em vendas sem produto detalhado")}`}
        </p>
      )}
    </Cartao>
  );
}

/** Vendas por origem do lead, pelas tags de origem que a empresa cadastrou. */
export function VendasPorOrigem({ painel, idioma }: { painel: PainelDeVendas; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const n = (v: number) => new Intl.NumberFormat(tagDeIdioma(idioma)).format(v);
  const titulo = t("Vendas por origem");
  const { origem } = painel;

  if (!origem.configurada) {
    return (
      <Cartao titulo={titulo}>
        <SemDado
          texto={t("As origens aparecem aqui quando a empresa tem regras de origem cadastradas: cada fonte de lead vira uma tag automática, e as vendas são agrupadas por ela.")}
        />
      </Cartao>
    );
  }

  const linhas = [...origem.linhas];
  if (origem.sem_origem.vendas > 0) {
    linhas.push({ tag: "", vendas: origem.sem_origem.vendas, total_cents: origem.sem_origem.total_cents });
  }
  if (linhas.length === 0) {
    return (
      <Cartao titulo={titulo}>
        <SemDado texto={t("Nenhuma venda no período para agrupar por origem.")} />
      </Cartao>
    );
  }
  const maior = Math.max(...linhas.map((l) => l.total_cents), 1);

  return (
    <Cartao titulo={titulo} subtitulo={t("Pela tag de origem do lead que fechou")}>
      <ul className="mt-3 flex flex-col gap-3">
        {linhas.map((l) => (
          <li key={l.tag || "sem-origem"} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate font-medium">{l.tag === "" ? t("Sem origem") : l.tag === "OUTRAS" ? t("Outras origens") : l.tag}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {`${n(l.vendas)} ${l.vendas === 1 ? t("venda") : t("vendas")} · ${formatCents(l.total_cents, painel.moeda)}`}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.max(2, Math.round((l.total_cents / maior) * 100))}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Cartao>
  );
}
