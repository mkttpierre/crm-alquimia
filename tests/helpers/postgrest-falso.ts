/**
 * Banco de mentira que se comporta como o PostgREST nos pontos que a exportação de CSV depende:
 *
 *  - aplica `eq` / `is(null)` / `in` / `contains` / `or` (ilike e `cs`) — inclusive em colunas de recurso embutido
 *    (`contacts.tags`, `{ referencedTable: "contacts" }`);
 *  - ordena por `order(...)` (desempate por quem vem depois) e respeita `range(de, ate)` / `limit(n)`;
 *  - CORTA toda resposta em `max_rows` (1.000, o de supabase/config.toml), em silêncio — é esse corte que a
 *    exportação precisa contornar com `.range()`;
 *  - guarda cada consulta feita (`consultas`) para o teste afirmar o que foi pedido (colunas, filtros, faixa).
 *
 * Não tenta ser um PostgREST completo: operação que não conhece LANÇA, para o teste não passar por engano.
 */

export type Linha = Record<string, unknown>;

export const MAX_ROWS = 1000;

export interface ConsultaFeita {
  tabela: string;
  colunas: string;
  filtros: string[];
  ordem: string[];
  faixa: [number, number] | null;
}

function valorEm(linha: Linha, coluna: string): unknown {
  let atual: unknown = linha;
  for (const parte of coluna.split(".")) {
    if (atual === null || typeof atual !== "object") return undefined;
    atual = (atual as Linha)[parte];
  }
  return atual;
}

/** `*` e `%` são o curinga; aqui, "contém" sem diferenciar caixa. */
function ilike(valor: unknown, padrao: string): boolean {
  if (typeof valor !== "string") return false;
  const miolo = padrao.replace(/^\*|\*$/g, "").replace(/\\([%_])/g, "$1");
  return valor.toLowerCase().includes(miolo.toLowerCase());
}

function contemTodos(valor: unknown, esperado: unknown[]): boolean {
  return Array.isArray(valor) && esperado.every((e) => valor.includes(e));
}

/** Uma condição de `or=(...)`: `coluna.ilike.*x*`, `coluna.cs.{x}` ou `coluna.eq.x`. */
function condicaoDoOr(linha: Linha, condicao: string, prefixo: string): boolean {
  const m = /^([^.]+)\.(ilike|cs|eq)\.(.*)$/.exec(condicao);
  if (!m) throw new Error(`postgrest-falso: condição de or() desconhecida: ${condicao}`);
  const [, coluna, op, valor] = m as unknown as [string, string, string, string];
  const alvo = valorEm(linha, `${prefixo}${coluna}`);
  if (op === "ilike") return ilike(alvo, valor);
  if (op === "eq") return String(alvo) === valor;
  return contemTodos(alvo, valor.replace(/^\{|\}$/g, "").split(","));
}

export function bancoFalso(tabelas: Record<string, Linha[]>, opcoes: { falharEm?: string } = {}) {
  const consultas: ConsultaFeita[] = [];

  const db = {
    from(tabela: string) {
      const feita: ConsultaFeita = { tabela, colunas: "", filtros: [], ordem: [], faixa: null };
      const predicados: Array<(l: Linha) => boolean> = [];
      const ordem: Array<{ coluna: string; asc: boolean }> = [];
      let limite: number | null = null;
      let modoContagem = false;

      const cadeia: Record<string, unknown> = {};
      cadeia.select = (colunas: string, o?: { count?: string; head?: boolean }) => {
        feita.colunas = colunas;
        modoContagem = !!o?.head;
        return cadeia;
      };
      cadeia.eq = (c: string, v: unknown) => {
        feita.filtros.push(`eq:${c}=${String(v)}`);
        predicados.push((l) => valorEm(l, c) === v);
        return cadeia;
      };
      cadeia.is = (c: string, v: null) => {
        feita.filtros.push(`is:${c}=${String(v)}`);
        predicados.push((l) => (valorEm(l, c) ?? null) === v);
        return cadeia;
      };
      cadeia.in = (c: string, vs: unknown[]) => {
        feita.filtros.push(`in:${c}`);
        predicados.push((l) => vs.includes(valorEm(l, c)));
        return cadeia;
      };
      cadeia.contains = (c: string, v: unknown[]) => {
        feita.filtros.push(`contains:${c}=${v.join(",")}`);
        predicados.push((l) => contemTodos(valorEm(l, c), v));
        return cadeia;
      };
      cadeia.or = (filtro: string, o?: { referencedTable?: string }) => {
        const prefixo = o?.referencedTable ? `${o.referencedTable}.` : "";
        feita.filtros.push(`or:${prefixo}${filtro}`);
        const condicoes = filtro.split(",");
        predicados.push((l) => condicoes.some((c) => condicaoDoOr(l, c, prefixo)));
        return cadeia;
      };
      cadeia.order = (coluna: string, o?: { ascending?: boolean }) => {
        feita.ordem.push(coluna);
        ordem.push({ coluna, asc: o?.ascending !== false });
        return cadeia;
      };
      cadeia.range = (de: number, ate: number) => {
        feita.faixa = [de, ate];
        return cadeia;
      };
      cadeia.limit = (n: number) => {
        limite = n;
        return cadeia;
      };

      const executar = () => {
        consultas.push({ ...feita });
        if (opcoes.falharEm === tabela) return { data: null, error: { message: "banco caiu" }, count: null };
        let linhas = (tabelas[tabela] ?? []).filter((l) => predicados.every((p) => p(l)));
        for (const { coluna, asc } of [...ordem].reverse()) {
          linhas = [...linhas].sort((a, b) => {
            const x = String(valorEm(a, coluna) ?? "");
            const y = String(valorEm(b, coluna) ?? "");
            return asc ? x.localeCompare(y) : y.localeCompare(x);
          });
        }
        if (modoContagem) return { data: null, error: null, count: linhas.length };
        if (feita.faixa) linhas = linhas.slice(feita.faixa[0], feita.faixa[1] + 1);
        if (limite !== null) linhas = linhas.slice(0, limite);
        return { data: linhas.slice(0, MAX_ROWS), error: null, count: null };
      };
      cadeia.maybeSingle = async () => ({ ...executar(), data: executar().data?.[0] ?? null });
      cadeia.then = (resolve: (v: unknown) => unknown, rejeitar?: (e: unknown) => unknown) =>
        Promise.resolve(executar()).then(resolve, rejeitar);
      return cadeia;
    },
  };

  return { db: db as never, consultas };
}
