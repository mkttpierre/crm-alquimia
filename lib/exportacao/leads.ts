/**
 * Exportação de leads (negócios) em CSV: o que sai, em que ordem e com que filtros.
 *
 * ─── Decisões fixas ────────────────────────────────────────────
 *
 *  · Colunas: nome, telefone, funil, etapa, dono, valor (em reais, `1234,56`), etiquetas (`|`), criado em, última
 *    atualização e UMA coluna por chave de campo personalizado do negócio. Uma linha por negócio.
 *  · A COMISSÃO DO DONO NUNCA SAI. `crm_leads.valor_sigiloso` marca o negócio cujo valor é a comissão do operador
 *    (plano interno, `catalog_products.so_interno`, ou "Registrar venda"): nele a célula de valor vai VAZIA, e os campos
 *    personalizados com nome de dinheiro (regra canônica `CAMPO_DE_DINHEIRO`: cents, amount, price, preco, valor, total)
 *    também somem, em qualquer profundidade (`semDinheiro`), junto com a coluna que só ele tinha. FALHA FECHADO: linha sem a marca `valor_sigiloso` (coluna não lida, versão antiga do schema) é tratada
 *    como sigilosa. Esta exportação não lê `catalog_products` nem `crm_lead_items`: o preço de plano interno nem chega a
 *    ser pedido ao banco.
 *  · Anonimização (LGPD): negócio de contato anonimizado sai com o nome anonimizado do banco, sem telefone e sem campos
 *    personalizados (que podem guardar dado pessoal do titular).
 *  · Escopo: `organization_id` explícito (além da RLS da sessão). Filtros como os da tela de Leads: `busca` e `tag` valem
 *    sobre o CONTATO (mesma regra de `filtroDaBusca`), `pipeline` sobre o funil do negócio e `de`/`ate` sobre a ÚLTIMA
 *    COMPRA do contato, resolvida por `intervalo-de-compra.ts` com a mesma regra da tela (`ultimaCompraNoIntervalo`).
 *    ATENÇÃO (M6, aceito): a tela de Leads lista CONTATOS e as etiquetas dela são as do contato; esta exportação é uma
 *    linha por NEGÓCIO e a coluna "Etiquetas" é a do negócio. O filtro por etiqueta vale pelo contato, a coluna mostra
 *    as do negócio.
 *  · Duas passadas, ambas paginadas: a primeira descobre as chaves de campo personalizado e os donos (o cabeçalho e os
 *    nomes precisam estar prontos antes do primeiro byte); a segunda entrega as linhas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { semDinheiro } from "@/lib/mcp/sem-comissao";
import { filtroDaBusca } from "@/lib/negocio/repositorio-leads";
import { CAMPO_DE_DINHEIRO } from "@/lib/negocio/valor-sigiloso";

import { formatarReais, textoDoCampo } from "./csv";
import { idsDeContatosNoIntervalo } from "./intervalo-de-compra";
import { colunasDosCampos, lerEmPaginas, type ExportacaoPreparada } from "./paginar";

export interface FiltrosDeLeads {
  busca?: string;
  tag?: string;
  pipeline?: string;
  /** Intervalo da última compra do contato (`AAAA-MM-DD`), como na tela de Leads. */
  de?: string;
  ate?: string;
}

/** Os contatos cuja última compra cai em `de`/`ate` (padrão: `idsDeContatosNoIntervalo`, a regra da tela de Leads). */
export type ContatosNoIntervalo = (orgId: string, filtros: FiltrosDeLeads) => Promise<Set<string>>;

/** Nome (só o nome) dos atendentes da organização, por id — `lib/negocio/nomes-dos-atendentes.ts`. */
export type NomesDosDonos = (orgId: string, ids: ReadonlyArray<string>) => Promise<Map<string, string | null>>;

interface ContatoDoLead {
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
  is_anonymized: boolean | null;
}

interface LeadLido {
  contact_id: string | null;
  title: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  owner_kind: string | null;
  owner_user_id: string | null;
  owner_agent_id: string | null;
  value_cents: number | string | null;
  valor_sigiloso?: boolean | null;
  tags: string[] | null;
  custom_fields: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
  contacts: ContatoDoLead | null;
}

/** FALHA FECHADO: só `false` explícito libera o valor. */
const ehSigiloso = (l: Pick<LeadLido, "valor_sigiloso">) => l.valor_sigiloso !== false;
/** Negócio sem contato não tem titular a proteger; com contato, só `false` explícito libera. */
const contatoAnonimo = (l: Pick<LeadLido, "contacts">) => !!l.contacts && l.contacts.is_anonymized !== false;

/** As chaves de campo personalizado que este negócio PODE mostrar. */
function chavesVisiveis(l: Pick<LeadLido, "valor_sigiloso" | "contacts" | "custom_fields">): string[] {
  if (contatoAnonimo(l)) return [];
  const chaves = Object.keys(l.custom_fields ?? {});
  // A regra é a canônica do repo (`CAMPO_DE_DINHEIRO`), a mesma das saídas para a IA e para webhooks.
  return ehSigiloso(l) ? chaves.filter((c) => !CAMPO_DE_DINHEIRO.test(c)) : chaves;
}

// O construtor do PostgREST muda de tipo a cada filtro; aqui só se encadeia.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Consulta = any;

function consultaDeLeads(
  db: SupabaseClient,
  orgId: string,
  filtros: FiltrosDeLeads,
  colunas: string,
  embutido: string,
): Consulta {
  const busca = filtros.busca ? filtroDaBusca(filtros.busca) : null;
  // Com busca ou tag, o contato é obrigatório (`!inner`): sem isso o filtro só esconderia o contato e o negócio ficaria.
  const filtraContato = !!busca || !!filtros.tag;
  let q: Consulta = db
    .from("crm_leads")
    .select(`${colunas},${filtraContato ? "contacts!inner" : "contacts"}(${embutido})`)
    .eq("organization_id", orgId);
  if (filtros.pipeline) q = q.eq("pipeline_id", filtros.pipeline);
  if (busca) q = q.or(busca, { referencedTable: "contacts" });
  if (filtros.tag) q = q.contains("contacts.tags", [filtros.tag]);
  // `id` por último: chave total, sem ela a paginação repete ou pula linhas entre datas iguais.
  return q.order("created_at", { ascending: false }).order("id", { ascending: true });
}

const COLUNAS_DA_LINHA =
  "id,contact_id,title,pipeline_id,stage_id,owner_kind,owner_user_id,owner_agent_id,value_cents,valor_sigiloso,tags,custom_fields,created_at,updated_at";
const CONTATO_DA_LINHA = "display_name,name,phone_number,is_anonymized";
const COLUNAS_DA_DESCOBERTA = "id,contact_id,owner_kind,owner_user_id,owner_agent_id,valor_sigiloso,custom_fields";
const CONTATO_DA_DESCOBERTA = "is_anonymized";

/** Tabela pequena da organização (funis, etapas, agentes) como mapa id → nome. */
async function nomesPorId(db: SupabaseClient, orgId: string, tabela: string): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  for await (const pagina of lerEmPaginas<{ id: string; name: string | null }>((de, ate) =>
    db.from(tabela).select("id,name").eq("organization_id", orgId).order("id", { ascending: true }).range(de, ate),
  )) {
    for (const r of pagina) mapa.set(r.id, r.name ?? "");
  }
  return mapa;
}

export async function prepararExportacaoDeLeads(
  db: SupabaseClient,
  orgId: string,
  filtros: FiltrosDeLeads,
  t: (texto: string) => string,
  nomesDosDonos: NomesDosDonos,
  contatosNoIntervalo: ContatosNoIntervalo = (org, f) => idsDeContatosNoIntervalo(db, org, f),
): Promise<ExportacaoPreparada> {
  // Intervalo de última compra (`de`/`ate`): valor calculado do histórico do contato, resolvido UMA vez pela mesma
  // regra da tela; as linhas de negócio são filtradas por `contact_id` (negócio sem contato fica de fora, como na tela).
  const permitidos = filtros.de || filtros.ate ? await contatosNoIntervalo(orgId, filtros) : null;
  const dentro = (l: Pick<LeadLido, "contact_id">) => !permitidos || (l.contact_id !== null && permitidos.has(l.contact_id));

  // Passada 1: chaves de campo personalizado e donos.
  const chaves = new Set<string>();
  const donosUsuario = new Set<string>();
  for await (const pagina of lerEmPaginas<
    Pick<LeadLido, "contact_id" | "owner_kind" | "owner_user_id" | "owner_agent_id" | "valor_sigiloso" | "custom_fields" | "contacts">
  >((de, ate) => consultaDeLeads(db, orgId, filtros, COLUNAS_DA_DESCOBERTA, CONTATO_DA_DESCOBERTA).range(de, ate))) {
    for (const l of pagina.filter(dentro)) {
      for (const chave of chavesVisiveis(l)) chaves.add(chave);
      if (l.owner_kind !== "ai" && l.owner_user_id) donosUsuario.add(l.owner_user_id);
    }
  }

  const [funis, etapas, agentes, usuarios] = await Promise.all([
    nomesPorId(db, orgId, "crm_pipelines"),
    nomesPorId(db, orgId, "crm_stages"),
    nomesPorId(db, orgId, "ai_agents"),
    donosUsuario.size > 0 ? nomesDosDonos(orgId, [...donosUsuario]) : Promise.resolve(new Map<string, string | null>()),
  ]);

  const fixas = ["Nome", "Telefone", "Funil", "Etapa", "Dono", "Valor", "Etiquetas", "Criado em", "Última atualização"].map(t);
  const campos = colunasDosCampos(fixas, chaves);
  const cabecalho = [...fixas, ...campos.map((c) => c.coluna)];

  function dono(l: LeadLido): string {
    if (l.owner_kind === "ai") return l.owner_agent_id ? (agentes.get(l.owner_agent_id) ?? "") : "";
    return l.owner_user_id ? (usuarios.get(l.owner_user_id) ?? "") : "";
  }

  function linha(l: LeadLido): string[] {
    const anonimo = contatoAnonimo(l);
    const nome = l.contacts
      ? rotuloDoContato({ ...l.contacts, phone_number: anonimo ? null : l.contacts.phone_number }, t)
      : (l.title ?? "");
    const visiveis = new Set(chavesVisiveis(l));
    return [
      nome,
      anonimo ? "" : (l.contacts?.phone_number ?? ""),
      l.pipeline_id ? (funis.get(l.pipeline_id) ?? "") : "",
      l.stage_id ? (etapas.get(l.stage_id) ?? "") : "",
      dono(l),
      ehSigiloso(l) || l.value_cents === null ? "" : formatarReais(Number(l.value_cents)),
      (l.tags ?? []).join("|"),
      l.created_at ?? "",
      l.updated_at ?? "",
      // No negócio sigiloso, o dinheiro de DENTRO de um campo aninhado também sai (remoção recursiva canônica).
      ...campos.map(({ chave }) => {
        if (!visiveis.has(chave)) return "";
        const valor = (l.custom_fields ?? {})[chave];
        return textoDoCampo(ehSigiloso(l) ? semDinheiro(valor) : valor);
      }),
    ];
  }

  async function* paginas(): AsyncGenerator<string[][]> {
    for await (const pagina of lerEmPaginas<LeadLido>((de, ate) =>
      consultaDeLeads(db, orgId, filtros, COLUNAS_DA_LINHA, CONTATO_DA_LINHA).range(de, ate),
    )) {
      const doIntervalo = pagina.filter(dentro);
      if (doIntervalo.length > 0) yield doIntervalo.map(linha);
    }
  }

  return { cabecalho, paginas };
}
