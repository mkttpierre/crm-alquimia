/**
 * O que o seletor de produto da venda e da aba "Produtos" do negócio mostra.
 *
 * Regra do operador: se a organização tem produto INTERNO ativo (os planos de comissão), o seletor mostra SÓ os internos,
 * agrupados por marca e com busca; se não tem, mostra o catálogo como sempre foi. Item avulso continua possível na tela.
 * O modo não muda com a busca: procurar por algo da loja não traz o catálogo público para dentro da venda.
 */

export interface ProdutoDoSeletor {
  id: string;
  codigo: string;
  nome: string;
  marca: string | null;
  preco_cents: number;
  moeda: string;
  ativo: boolean;
  so_interno: boolean;
}

export interface GrupoDoSeletor<P extends ProdutoDoSeletor> {
  /** `null` = sem marca (ou o catálogo inteiro, no modo "catalogo"). */
  marca: string | null;
  produtos: P[];
}

export interface SeletorDeProdutos<P extends ProdutoDoSeletor> {
  modo: "internos" | "catalogo";
  grupos: Array<GrupoDoSeletor<P>>;
}

const normalizar = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();

const porNome = (a: { nome: string }, b: { nome: string }): number => a.nome.localeCompare(b.nome, "pt-BR", { numeric: true, sensitivity: "base" });

export function produtosParaSeletor<P extends ProdutoDoSeletor>(produtos: ReadonlyArray<P>, busca: string, moeda: string): SeletorDeProdutos<P> {
  const daMoeda = produtos.filter((p) => p.ativo && p.moeda === moeda);
  const modo: "internos" | "catalogo" = daMoeda.some((p) => p.so_interno) ? "internos" : "catalogo";
  const base = modo === "internos" ? daMoeda.filter((p) => p.so_interno) : daMoeda;

  const palavras = normalizar(busca).split(/\s+/).filter(Boolean);
  const achados = base.filter((p) => {
    if (palavras.length === 0) return true;
    const palheiro = normalizar(`${p.nome} ${p.codigo} ${p.marca ?? ""}`);
    return palavras.every((w) => palheiro.includes(w));
  });

  if (modo === "catalogo") {
    return { modo, grupos: achados.length === 0 ? [] : [{ marca: null, produtos: [...achados].sort(porNome) }] };
  }

  const porMarca = new Map<string | null, P[]>();
  for (const p of achados) {
    const marca = p.marca?.trim() ? p.marca.trim() : null;
    porMarca.set(marca, [...(porMarca.get(marca) ?? []), p]);
  }
  const grupos = [...porMarca.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, "pt-BR", { sensitivity: "base" })))
    .map(([marca, lista]) => ({ marca, produtos: [...lista].sort(porNome) }));
  return { modo, grupos };
}
