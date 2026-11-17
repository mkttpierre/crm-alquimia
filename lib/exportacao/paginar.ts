/**
 * Leitura paginada com `.range()` para as exportações.
 *
 * O PostgREST corta TODA resposta em `max_rows` (1.000 em `supabase/config.toml`), em silêncio: um `select` sem faixa de
 * uma base de 2.500 contatos devolve 1.000 linhas e nenhum erro, e o arquivo sairia cortado como se estivesse inteiro.
 * Aqui a base é lida de 1.000 em 1.000, uma página por vez, e só se pede a próxima quando quem consome pede (gerador
 * assíncrono): a base nunca está inteira na memória.
 *
 * Quem chama TEM de ordenar por uma chave total (`id` por último): sem ela, a paginação por deslocamento repete ou pula
 * linhas quando a coluna de ordem tem valores iguais.
 */
export const TAMANHO_DA_PAGINA = 1000;

export type RespostaDaPagina<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export async function* lerEmPaginas<T>(
  consulta: (de: number, ate: number) => RespostaDaPagina<T>,
): AsyncGenerator<T[]> {
  for (let de = 0; ; de += TAMANHO_DA_PAGINA) {
    const { data, error } = await consulta(de, de + TAMANHO_DA_PAGINA - 1);
    if (error) throw new Error(error.message);
    const linhas = data ?? [];
    if (linhas.length > 0) yield linhas;
    if (linhas.length < TAMANHO_DA_PAGINA) return;
  }
}

export interface ColunaDeCampo {
  /** A chave dentro de `custom_fields`. */
  chave: string;
  /** O nome da coluna no arquivo. */
  coluna: string;
}

/**
 * Uma coluna por chave de campo personalizado, em ordem alfabética. Chave com o mesmo nome de uma coluna fixa (ou de outra
 * chave) sem diferenciar caixa ganha o sufixo `(campo)`, para o cabeçalho nunca ter duas colunas iguais.
 */
export function colunasDosCampos(fixas: readonly string[], chaves: Iterable<string>): ColunaDeCampo[] {
  const usados = new Set(fixas.map((c) => c.toLowerCase()));
  const colunas: ColunaDeCampo[] = [];
  for (const chave of [...new Set(chaves)].sort((a, b) => a.localeCompare(b, "pt-BR"))) {
    let coluna = chave;
    for (let n = 1; usados.has(coluna.toLowerCase()); n++) coluna = n === 1 ? `${chave} (campo)` : `${chave} (campo ${n})`;
    usados.add(coluna.toLowerCase());
    colunas.push({ chave, coluna });
  }
  return colunas;
}

/** O que cada exportação entrega à rota: o cabeçalho (conhecido antes do primeiro byte) e as linhas, página a página. */
export interface ExportacaoPreparada {
  cabecalho: string[];
  /** Páginas de linhas já em texto, de no máximo 1.000. Só lê a seguinte quando o consumidor pede. */
  paginas: () => AsyncGenerator<string[][]>;
}
