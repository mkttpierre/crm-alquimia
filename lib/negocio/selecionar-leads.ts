import { ordenarContatos } from "./ordenar-contatos";

export interface LinhaLead {
  id: string; nome: string; telefone: string; tags: string[]; tipo: "pessoa" | "empresa"; pipelines: string[];
  total: number; compras: number; ciclo: number | null; ultima: string | null;
}
export type OrdemLead = "tipo" | "nome" | "tags" | "total" | "compras" | "ciclo" | "ultima";
export interface FiltrosLead { busca?: string; tag?: string; pipeline?: string; de?: string; ate?: string; ordem: OrdemLead; direcao: "asc" | "desc"; pagina: number; limite: number }

/**
 * O filtro de intervalo da tela de Leads: a ÚLTIMA compra do contato cai entre `de` e `ate` (datas `AAAA-MM-DD`, limites
 * inclusive, pelo dia). Sem intervalo, todos passam; com intervalo, quem nunca comprou fica de fora. A exportação de CSV
 * usa esta mesma função, para o arquivo e a tela nunca discordarem.
 */
export function ultimaCompraNoIntervalo(ultima: string | null, de?: string, ate?: string): boolean {
  return (!de || (!!ultima && ultima.slice(0, 10) >= de)) && (!ate || (!!ultima && ultima.slice(0, 10) <= ate));
}

export function selecionarLeads(linhas: LinhaLead[], f: FiltrosLead) {
  const busca = (f.busca ?? "").trim().toLocaleLowerCase();
  const filtradas = linhas.filter((l) => (!busca || [l.nome, l.telefone, ...l.tags].some((v) => v.toLocaleLowerCase().includes(busca))) && (!f.tag || l.tags.includes(f.tag)) && (!f.pipeline || l.pipelines.includes(f.pipeline)) && ultimaCompraNoIntervalo(l.ultima, f.de, f.ate));
  const ordenadas = ordenarContatos(filtradas, f.ordem, f.direcao);
  const inicio = (Math.max(1, f.pagina) - 1) * f.limite;
  return { total: ordenadas.length, linhas: ordenadas.slice(inicio, inicio + f.limite) };
}
