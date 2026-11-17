/**
 * Gerador de CSV em streaming para as exportações (contatos e leads).
 *
 * ─── Decisões fixas ────────────────────────────────────────────
 *
 *  · RFC 4180: separador, aspas duplas dobradas, célula entre aspas quando contém separador, aspas ou quebra de linha;
 *    linhas terminam em CRLF.
 *  · BOM UTF-8 no início: sem ele o Excel abre o arquivo como ANSI e destrói os acentos.
 *  · Separador `,` (padrão) ou `;` (o Excel em português espera `;`: com `,` ele joga tudo numa coluna só).
 *  · PROTEÇÃO CONTRA INJEÇÃO DE FÓRMULA: célula que começa com `=`, `+`, `-`, `@`, tab ou CR recebe `'` na frente. Quem
 *    abre a planilha no Excel/Sheets e tem um contato cujo nome é `=HYPERLINK(...)` executaria a fórmula; o apóstrofo a
 *    torna texto. O apóstrofo vem ANTES do escape de aspas, para a célula continuar íntegra.
 *  · STREAMING: o arquivo sai por páginas. Quem chama entrega as páginas como um gerador assíncrono; só se lê a página
 *    seguinte quando o leitor consome a anterior (contrapressão do `ReadableStream`), e a base nunca está inteira na
 *    memória.
 *  · Cancelar o download (o usuário fecha a aba) encerra o gerador, e erro no meio DERRUBA o stream: um arquivo cortado
 *    nunca é entregue como se estivesse inteiro.
 */

/** Marca de ordem de bytes do UTF-8 (EF BB BF). */
export const BOM = String.fromCharCode(0xfeff);

export type Separador = "," | ";";

/** Primeiro caractere que faz planilha tratar a célula como fórmula. */
const COMECA_FORMULA = /^[=+\-@\t\r]/;

/** Um valor qualquer vira o texto da célula (nulo = vazia). */
function emTexto(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  return typeof valor === "string" ? valor : String(valor);
}

export function escaparCelula(valor: unknown, separador: Separador): string {
  let texto = emTexto(valor);
  if (COMECA_FORMULA.test(texto)) texto = `'${texto}`;
  const precisaAspas = texto.includes(separador) || /["\r\n]/.test(texto);
  return precisaAspas ? `"${texto.replace(/"/g, '""')}"` : texto;
}

export function linhaCsv(celulas: readonly unknown[], separador: Separador): string {
  return `${celulas.map((c) => escaparCelula(c, separador)).join(separador)}\r\n`;
}

export interface FimDoArquivo {
  /** Linhas de dados entregues (sem o cabeçalho). */
  linhas: number;
  /** `true` só quando o arquivo foi até o fim; cancelado ou com erro, `false`. */
  completo: boolean;
  /** Mensagem do erro que derrubou o arquivo, se foi isso. */
  erro?: string;
}

export interface OpcoesDoStream {
  cabecalho: readonly string[];
  separador: Separador;
  /** Páginas de linhas já em texto. Só é puxada a página seguinte quando o leitor pede. */
  paginas: AsyncGenerator<string[][]>;
  /** Roda UMA vez, ao terminar, cancelar ou falhar — é onde a auditoria registra a contagem. */
  aoEncerrar?: (fim: FimDoArquivo) => void | Promise<void>;
}

export function criarStreamDeCsv(opcoes: OpcoesDoStream): ReadableStream<Uint8Array> {
  const { cabecalho, separador, paginas, aoEncerrar } = opcoes;
  const codificador = new TextEncoder();
  let linhas = 0;
  let enviouCabecalho = false;
  let encerrado = false;

  async function encerrar(fim: Omit<FimDoArquivo, "linhas">): Promise<void> {
    if (encerrado) return;
    encerrado = true;
    await aoEncerrar?.({ linhas, ...fim });
  }

  return new ReadableStream<Uint8Array>(
    {
      async pull(controle) {
        try {
          if (!enviouCabecalho) {
            enviouCabecalho = true;
            controle.enqueue(codificador.encode(BOM + linhaCsv(cabecalho, separador)));
            return;
          }
          const proxima = await paginas.next();
          if (proxima.done) {
            await encerrar({ completo: true });
            controle.close();
            return;
          }
          linhas += proxima.value.length;
          controle.enqueue(codificador.encode(proxima.value.map((l) => linhaCsv(l, separador)).join("")));
        } catch (erro) {
          const mensagem = erro instanceof Error ? erro.message : String(erro);
          await encerrar({ completo: false, erro: mensagem });
          controle.error(erro);
        }
      },
      async cancel() {
        await paginas.return(undefined);
        await encerrar({ completo: false });
      },
    },
    // Fila de uma só entrada: a próxima página só é pedida depois que o leitor consumiu a anterior.
    { highWaterMark: 0 },
  );
}

/** `contatos-2026-11-13.csv`: a data é a de São Paulo, não a do UTC (às 22h30 de lá já é "amanhã" no servidor). */
export function nomeDoArquivo(prefixo: string, agora: Date = new Date()): string {
  const data = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
  return `${prefixo}-${data}.csv`;
}

/** Centavos em reais, `1234,56`: vírgula decimal, sem separador de milhar. Nulo vira célula vazia. */
export function formatarReais(centavos: number | null): string {
  if (centavos === null) return "";
  const negativo = centavos < 0;
  const abs = Math.abs(Math.trunc(centavos));
  const reais = Math.floor(abs / 100);
  const resto = String(abs % 100).padStart(2, "0");
  return `${negativo ? "-" : ""}${reais},${resto}`;
}

/** Valor de campo personalizado (jsonb) como texto de célula: objeto e lista viram JSON. */
export function textoDoCampo(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "object") return JSON.stringify(valor);
  return String(valor);
}
