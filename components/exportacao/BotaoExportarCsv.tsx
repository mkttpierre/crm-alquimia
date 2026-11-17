"use client";
import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DownloadSimple } from "@/lib/ui/icons";

export type RotaDeExportacao = "contacts" | "leads";
type Separador = "virgula" | "ponto-e-virgula";

/**
 * O endereço da exportação com os filtros que a tela tem ativos AGORA (busca, tag, funil, origem, intervalo de datas).
 * Filtro vazio não vai na URL.
 */
export function urlDeExportacao(
  rota: RotaDeExportacao,
  filtros: Record<string, string | undefined | null>,
  separador: Separador,
): string {
  const consulta = new URLSearchParams();
  for (const [chave, valor] of Object.entries(filtros)) {
    if (valor) consulta.set(chave, valor);
  }
  if (separador === "ponto-e-virgula") consulta.set("separador", separador);
  const texto = consulta.toString();
  return `/api/v1/${rota}/export${texto ? `?${texto}` : ""}`;
}

/** O nome do arquivo que o servidor mandou em `Content-Disposition` (`attachment; filename="leads-2026-11-13.csv"`). */
function nomeDoArquivo(resposta: Response, rota: RotaDeExportacao): string {
  const cabecalho = resposta.headers.get("Content-Disposition") ?? "";
  return /filename="([^"]+)"/.exec(cabecalho)?.[1] ?? `${rota === "contacts" ? "contatos" : "leads"}.csv`;
}

/**
 * "Exportar CSV": baixa o que a tela está mostrando (mesmos filtros e busca). Duas opções de separador: vírgula
 * (padrão) e ponto e vírgula, que é o que o Excel em português espera. A rota só atende gerente ou acima; quem chama
 * esconde o botão de quem não pode, e a rota recusa de qualquer jeito.
 *
 * O pedido é um `fetch` e não um link, para a recusa (403 sem permissão ou em modo suporte, 429 de limite, 500) virar um
 * aviso na tela em vez de o navegador salvar o JSON de erro como se fosse a planilha.
 */
export function BotaoExportarCsv({
  rota,
  filtros,
}: {
  rota: RotaDeExportacao;
  filtros: Record<string, string | undefined | null>;
}) {
  const t = useT();
  const [baixando, setBaixando] = useState(false);

  async function baixar(separador: Separador) {
    setBaixando(true);
    try {
      const resposta = await fetch(urlDeExportacao(rota, filtros, separador));
      if (!resposta.ok) {
        // A mensagem do servidor já vem no idioma de quem pediu; sem ela, o texto padrão.
        const corpo = (await resposta.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(corpo?.error?.message || t("Não foi possível exportar."));
        return;
      }
      const url = URL.createObjectURL(await resposta.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = nomeDoArquivo(resposta, rota);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Revogar no mesmo instante do clique pode cortar a leitura do arquivo em alguns navegadores: um pouco depois.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error(t("Não foi possível exportar."));
    } finally {
      setBaixando(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={baixando}>
          <DownloadSimple size={16} weight="bold" aria-hidden />
          <span>{t("Exportar CSV")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void baixar("virgula")}>{t("Separado por vírgula")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void baixar("ponto-e-virgula")}>
          {t("Separado por ponto e vírgula (Excel em português)")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
