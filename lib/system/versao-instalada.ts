/**
 * A versão instalada que a tela mostra quando o banco não sabe.
 *
 * `system_version.current_version` nasce vazia (baseline) e, sem o agente do host, só o instalador a
 * preenche. Uma instalação feita antes disso, ou um banco restaurado de um backup antigo, ficaria com a
 * frase "Versão instalada: ." (achado da terceira prova de instalação). A ordem: a coluna, depois o
 * `APP_VERSION` da imagem (o `dev` do Dockerfile não é versão), depois a versão do `package.json` com que
 * este código foi construído. Nunca vazia.
 */
import { version as VERSAO_DO_PACOTE } from "@/package.json";

export function versaoInstalada(daColuna: string | null | undefined, daImagem: string | undefined = process.env.APP_VERSION): string {
  const coluna = (daColuna ?? "").trim();
  if (coluna) return coluna;
  const imagem = (daImagem ?? "").trim();
  if (imagem && imagem !== "dev") return imagem;
  return VERSAO_DO_PACOTE;
}
