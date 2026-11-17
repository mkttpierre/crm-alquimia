import { LimiteDeLeituraExcedido } from "./limite-de-leitura";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resumirComprasPorContato } from "./resumo-contatos";
import { STATUS_DE_PEDIDO_COM_RECEITA } from "./receita";
import { tipoContato } from "./tipo-contato";
import type { LinhaLead } from "./selecionar-leads";

type Pagina<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
const TAMANHO = 1000;
async function lerTudo<T>(consulta: (inicio: number, fim: number) => Pagina<T>): Promise<T[]> {
  const linhas: T[] = [];
  for (let pagina = 0; pagina < 20; pagina++) {
    const { data, error } = await consulta(pagina * TAMANHO, (pagina + 1) * TAMANHO - 1);
    if (error) throw error;
    linhas.push(...(data ?? []));
    if ((data?.length ?? 0) < TAMANHO) return linhas;
  }
  throw new LimiteDeLeituraExcedido();
}
type Contato = { id: string; display_name: string | null; name: string | null; phone_number: string | null; tags: string[]; source_metadata: unknown; nome_ordenacao?: string | null };
type Lead = { id: string; contact_id: string | null; pipeline_id: string; status: string; title: string; closed_at: string | null; value_cents: number | null; currency: string | null };
type Pedido = { id: string; contact_id: string | null; external_id: string; ordered_at: string; total_cents: number; currency: string; status: string };
type Link = { lead_id: string; target_id: string };
type Pipeline = { id: string; name: string };

const COLUNAS_DO_CONTATO = "id,display_name,name,phone_number,tags,source_metadata,nome_ordenacao";
const COLUNAS_DO_LEAD = "id,contact_id,pipeline_id,status,title,closed_at,value_cents,currency";
const COLUNAS_DO_PEDIDO = "id,contact_id,external_id,ordered_at,total_cents,currency,status";

/** Filtros que o banco aplica na consulta de contatos (os dois caminhos da tela usam os mesmos). */
export interface FiltrosDoServidor { busca?: string; tag?: string; pipeline?: string }

/**
 * A busca da tela de Leads, como filtro do PostgREST.
 *
 * Mesmo escape de `termoSeguroParaOr` (app/api/v1/conversations/_handler.ts): `%`/`_`
 * são curingas do `ilike`, e `,` `(` `)` são a gramática do `or=` — viram o próprio
 * curinga. Casa nome exibido, nome, telefone e, se o termo for uma palavra só, a tag
 * exata (array não tem `ilike`; a tela antiga casava pedaço de tag em memória).
 */
export function filtroDaBusca(bruto: string): string | null {
  const termo = bruto.trim().replace(/[%_]/g, (m) => `\\${m}`).replace(/[,()]/g, "*");
  if (!termo) return null;
  const partes = [`display_name.ilike.*${termo}*`, `name.ilike.*${termo}*`, `phone_number.ilike.*${termo}*`];
  const digitos = termo.replace(/\D/g, "");
  if (digitos.length >= 4 && digitos !== termo) partes.push(`phone_number.ilike.*${digitos}*`);
  if (/^[\p{L}\p{N}_-]+$/u.test(bruto.trim())) partes.push(`tags.cs.{${bruto.trim()}}`);
  return partes.join(",");
}

// O construtor do PostgREST muda de tipo a cada filtro; aqui só se encadeia.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Consulta = any;

function comFiltros(consulta: Consulta, org: string, f: FiltrosDoServidor): Consulta {
  let q = consulta.eq("organization_id", org).is("is_merged_into", null);
  const busca = f.busca ? filtroDaBusca(f.busca) : null;
  if (busca) q = q.or(busca);
  if (f.tag) q = q.contains("tags", [f.tag]);
  // `!inner` no select + este filtro: só contatos com negócio nesse funil.
  if (f.pipeline) q = q.eq("crm_leads.pipeline_id", f.pipeline);
  return q;
}

function selectDoContato(f: FiltrosDoServidor): string {
  return f.pipeline ? `${COLUNAS_DO_CONTATO},crm_leads!inner(pipeline_id)` : COLUNAS_DO_CONTATO;
}

/** Linhas da tabela a partir dos contatos e das compras deles (os dois caminhos usam). */
function montarLinhas(contatos: Contato[], leads: Lead[], pedidos: Pedido[], links: Link[]): LinhaLead[] {
  const linksPorLead = new Map<string, string[]>();
  for (const l of links) linksPorLead.set(l.lead_id, [...(linksPorLead.get(l.lead_id) ?? []), l.target_id]);
  const negocios = leads.flatMap((l) => l.status === "won" && l.closed_at && l.contact_id ? [{ lead_id:l.id, contact_id:l.contact_id, titulo:l.title, closed_at:l.closed_at, value_cents:l.value_cents, currency:l.currency, itens:[], order_ids:linksPorLead.get(l.id) ?? [] }] : []);
  const historicos = resumirComprasPorContato(contatos.map((c) => c.id), { negocios, pedidos: pedidos.flatMap((p) => p.contact_id ? [{ ...p, contact_id:p.contact_id }] : []) });
  const porContato = new Map<string, Set<string>>();
  for (const l of leads) if (l.contact_id) { const conjunto = porContato.get(l.contact_id) ?? new Set<string>(); conjunto.add(l.pipeline_id); porContato.set(l.contact_id, conjunto); }
  return contatos.map((c) => { const h = historicos[c.id]!; return { id:c.id, nome:rotuloDoContato(c), telefone:c.phone_number ?? "", tags:c.tags ?? [], tipo:tipoContato(c.source_metadata), pipelines:[...(porContato.get(c.id) ?? [])], total:h.total_gasto_cents, compras:h.numero_de_compras, ciclo:h.ciclo_medio_dias, ultima:h.ultima_compra }; });
}

/**
 * Vocabulário de tags da ORGANIZAÇÃO inteira, para as sugestões do campo de tag
 * (a página só conhece as tags dos seus 50). RPC `fn_tags_dos_contatos` (0255):
 * distinct no banco, RLS de quem chama, teto de 500.
 */
async function lerTagsDaOrganizacao(db: SupabaseClient, org: string): Promise<string[]> {
  const { data, error } = await db.rpc("fn_tags_dos_contatos", { p_org: org });
  if (error) throw error;
  return (data ?? []) as string[];
}

async function lerPipelines(db: SupabaseClient, org: string): Promise<Pipeline[]> {
  const { data, error } = await db.from("crm_pipelines").select("id,name").eq("organization_id", org).order("name").limit(500);
  if (error) throw error;
  return (data ?? []) as Pipeline[];
}

/**
 * Caminho COMPLETO: lê a base inteira e deixa ordenar/filtrar em memória.
 *
 * Só serve às ordenações e filtros que dependem da compra calculada (total, compras,
 * ciclo, última compra, intervalo de datas) e às de coluna derivada (tipo, tags):
 * ordenar por "total gasto" entre todos exige conhecer o total de todos. Busca, tag e
 * funil já vão ao banco aqui também, então a leitura encolhe junto com o filtro.
 */
export async function carregarLeads(db: SupabaseClient, org: string, filtros: FiltrosDoServidor = {}, opcoes: { semAuxiliares?: boolean } = {}): Promise<{ linhas: LinhaLead[]; pipelines: Pipeline[]; tags: string[] }> {
  const [contatos, leads, pedidos, links, pipes, tags] = await Promise.all([
    lerTudo<Contato>((a,b) => comFiltros(db.from("contacts").select(selectDoContato(filtros)), org, filtros).order("id").range(a,b) as Pagina<Contato>),
    lerTudo<Lead>((a,b) => db.from("crm_leads").select(COLUNAS_DO_LEAD).eq("organization_id",org).order("id").range(a,b) as unknown as Pagina<Lead>),
    lerTudo<Pedido>((a,b) => db.from("orders").select(COLUNAS_DO_PEDIDO).eq("organization_id",org).in("status",[...STATUS_DE_PEDIDO_COM_RECEITA]).order("id").range(a,b) as unknown as Pagina<Pedido>),
    lerTudo<Link>((a,b) => db.from("crm_lead_links").select("lead_id,target_id").eq("organization_id",org).eq("target_kind","order").order("id").range(a,b) as unknown as Pagina<Link>),
    // `semAuxiliares`: quem só quer as linhas (a exportação com intervalo) não paga a leitura dos funis nem das tags da organização.
    opcoes.semAuxiliares ? Promise.resolve<Pipeline[]>([]) : lerPipelines(db, org),
    opcoes.semAuxiliares ? Promise.resolve<string[]>([]) : lerTagsDaOrganizacao(db, org),
  ]);
  return { pipelines: pipes, tags, linhas: montarLinhas(contatos, leads, pedidos, links) };
}

/** Cursor da tela de Leads: `nome_ordenacao` e id do último contato da página (mesmo formato `{sort,id}` do de /api/v1/contacts). */
interface CursorDeLeads { sort: string | null; id: string }
export function codificarCursorDeLeads(c: CursorDeLeads): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodificarCursorDeLeads(bruto: string): CursorDeLeads | null {
  try {
    const c = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as Partial<CursorDeLeads>;
    if (typeof c.id !== "string" || !/^[0-9a-f-]{36}$/i.test(c.id)) return null;
    return { sort: typeof c.sort === "string" ? c.sort : null, id: c.id };
  } catch {
    return null;
  }
}

export const LEADS_POR_PAGINA = 50;

export interface PaginaDeLeads { linhas: LinhaLead[]; total: number; proximo: string | null; pipelines: Pipeline[]; tags: string[] }

/**
 * Caminho PAGINADO (visão padrão, ordem por nome): 50 contatos por página pelo cursor,
 * com busca, tag e funil no banco, e compras lidas só para os contatos da página.
 *
 * A ordem é por `nome_ordenacao` (coluna gerada, 0254): o mesmo nome que a tela
 * mostra — nome exibido, senão nome, senão telefone — em minúsculas e nunca nulo;
 * desempate por `id`. Keyset (nome_ordenacao, id), como o de `/api/v1/contacts`.
 */
export async function carregarPaginaDeLeads(db: SupabaseClient, org: string, opcoes: FiltrosDoServidor & { direcao: "asc" | "desc"; cursor?: string }): Promise<PaginaDeLeads> {
  const asc = opcoes.direcao === "asc";
  let pagina: Consulta = comFiltros(db.from("contacts").select(selectDoContato(opcoes)), org, opcoes)
    .order("nome_ordenacao", { ascending: asc })
    .order("id", { ascending: asc })
    .limit(LEADS_POR_PAGINA + 1);
  const cursor = opcoes.cursor ? decodificarCursorDeLeads(opcoes.cursor) : null;
  if (cursor) {
    const op = asc ? "gt" : "lt";
    // Entre aspas duplas o `or=` aceita vírgula e parêntese no valor; escapam-se só a barra e a aspa.
    const sort = `"${(cursor.sort ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    pagina = pagina.or(`nome_ordenacao.${op}.${sort},and(nome_ordenacao.eq.${sort},id.${op}.${cursor.id})`);
  }
  const contagem: Consulta = comFiltros(db.from("contacts").select(opcoes.pipeline ? "id,crm_leads!inner(pipeline_id)" : "id", { count: "exact", head: true }), org, opcoes);

  const [lidos, contados, pipes, tags] = await Promise.all([pagina, contagem, lerPipelines(db, org), lerTagsDaOrganizacao(db, org)]);
  if (lidos.error) throw lidos.error;
  if (contados.error) throw contados.error;
  const todos = (lidos.data ?? []) as Contato[];
  const temMais = todos.length > LEADS_POR_PAGINA;
  const contatos = todos.slice(0, LEADS_POR_PAGINA);
  const ultimo = contatos.at(-1);
  const proximo = temMais && ultimo ? codificarCursorDeLeads({ sort: ultimo.nome_ordenacao ?? "", id: ultimo.id }) : null;

  const ids = contatos.map((c) => c.id);
  if (ids.length === 0) return { linhas: [], total: contados.count ?? 0, proximo: null, pipelines: pipes, tags };
  const [leads, pedidos] = await Promise.all([
    db.from("crm_leads").select(COLUNAS_DO_LEAD).eq("organization_id", org).in("contact_id", ids),
    db.from("orders").select(COLUNAS_DO_PEDIDO).eq("organization_id", org).in("contact_id", ids).in("status", [...STATUS_DE_PEDIDO_COM_RECEITA]),
  ]);
  if (leads.error) throw leads.error;
  if (pedidos.error) throw pedidos.error;
  const ganhos = ((leads.data ?? []) as Lead[]).filter((l) => l.status === "won").map((l) => l.id);
  let links: Link[] = [];
  if (ganhos.length > 0) {
    const r = await db.from("crm_lead_links").select("lead_id,target_id").eq("organization_id", org).eq("target_kind", "order").in("lead_id", ganhos);
    if (r.error) throw r.error;
    links = (r.data ?? []) as Link[];
  }
  return { linhas: montarLinhas(contatos, (leads.data ?? []) as Lead[], (pedidos.data ?? []) as Pedido[], links), total: contados.count ?? 0, proximo, pipelines: pipes, tags };
}
