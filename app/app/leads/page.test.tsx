import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A TELA DE LEADS LIA A BASE INTEIRA PARA MOSTRAR 25 LINHAS.
 *
 * `carregarLeads` puxava, de 1.000 em 1.000, TODOS os contatos, negócios,
 * pedidos e vínculos da organização (até 20.000 de cada, e lançava acima disso),
 * e só então filtrava, ordenava e cortava em memória (varredura de 10/11/2026).
 *
 * Aqui a página roda com um dublê do Supabase que conta quantas linhas cada
 * tabela ENTREGOU. Critério: a visão padrão pagina pelo cursor (50 por página,
 * 51 lidas para saber se há mais) e a busca vai ao servidor como filtro.
 */

const TOTAL_DE_CONTATOS = 3_000;

type Chamada = { metodo: string; args: unknown[] };
type Consulta = { tabela: string; chamadas: Chamada[] };

let consultas: Consulta[] = [];
let rpcs: { fn: string; args: unknown }[] = [];
/** O vocabulário de tags da ORGANIZAÇÃO inteira (a RPC), não o da página. */
const TAGS_DA_ORGANIZACAO = ["cliente-antigo", "lead-frio", "vip"];
let entregues: Record<string, number> = {};

const contatos = Array.from({ length: TOTAL_DE_CONTATOS }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  display_name: `Contato ${String(i).padStart(4, "0")}`,
  name: null,
  nome_ordenacao: `contato ${String(i).padStart(4, "0")}`,
  phone_number: `+55119${String(i).padStart(8, "0")}`,
  tags: i % 2 ? ["vip"] : [],
  source_metadata: {},
}));

/** Responde como o PostgREST quanto ao TAMANHO (range/limit/count); filtros não são avaliados. */
function dubleDoSupabase() {
  return {
    rpc(fn: string, args: unknown) {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: fn === "fn_tags_dos_contatos" ? TAGS_DA_ORGANIZACAO : null, error: null });
    },
    from(tabela: string) {
      const consulta: Consulta = { tabela, chamadas: [] };
      consultas.push(consulta);
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => {
                try {
                  return ok(responder(consulta));
                } catch (e) {
                  return falha?.(e);
                }
              };
            }
            return (...args: unknown[]) => {
              consulta.chamadas.push({ metodo: String(prop), args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
}

function responder({ tabela, chamadas }: Consulta) {
  const linhas = tabela === "contacts" ? contatos : [];
  const select = chamadas.find((c) => c.metodo === "select");
  const opcoes = (select?.args[1] ?? {}) as { count?: string; head?: boolean };
  if (opcoes.head) return { data: null, count: linhas.length, error: null };
  let fatia = linhas;
  const range = chamadas.find((c) => c.metodo === "range");
  const limit = chamadas.find((c) => c.metodo === "limit");
  if (range) fatia = fatia.slice(Number(range.args[0]), Number(range.args[1]) + 1);
  else if (limit) fatia = fatia.slice(0, Number(limit.args[0]));
  entregues[tabela] = (entregues[tabela] ?? 0) + fatia.length;
  return { data: fatia, count: opcoes.count ? linhas.length : null, error: null };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => dubleDoSupabase() }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u-1" }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin" }),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/app/leads",
  useSearchParams: () => new URLSearchParams(),
}));

type Props = { resultado: { linhas: unknown[]; total: number }; tags: string[] };

async function abrir(params: Record<string, string>) {
  const { default: LeadsPage } = await import("./page");
  const elemento = (await LeadsPage({ searchParams: Promise.resolve(params) })) as { props: Props };
  return elemento.props;
}

beforeEach(() => {
  rpcs = [];
  consultas = [];
  entregues = {};
});

describe("tela de Leads: pagina no servidor", () => {
  it("a visão padrão lê no máximo 51 contatos (50 + 1 para saber se há mais)", async () => {
    const props = await abrir({});
    expect(entregues.contacts ?? 0).toBeLessThanOrEqual(51);
    expect(props.resultado.linhas).toHaveLength(50);
  });

  it("o total do cabeçalho vem de contagem no banco, não de ler tudo", async () => {
    const props = await abrir({});
    expect(props.resultado.total).toBe(TOTAL_DE_CONTATOS);
    expect(entregues.contacts ?? 0).toBeLessThanOrEqual(51);
  });

  it("a busca vai ao servidor como filtro da consulta de contatos", async () => {
    await abrir({ busca: "ana" });
    const deContatos = consultas.filter((c) => c.tabela === "contacts");
    const filtros = deContatos.flatMap((c) => c.chamadas.filter((x) => x.metodo === "or"));
    expect(filtros.length).toBeGreaterThan(0);
    for (const f of filtros) expect(String(f.args[0])).toContain("ilike.*ana*");
    expect(entregues.contacts ?? 0).toBeLessThanOrEqual(51);
  });

  it("negócios e pedidos são lidos só para os contatos da página", async () => {
    await abrir({});
    for (const tabela of ["crm_leads", "orders"]) {
      const q = consultas.filter((c) => c.tabela === tabela);
      expect(q.length).toBeGreaterThan(0);
      for (const c of q) {
        const porContato = c.chamadas.find((x) => x.metodo === "in" && x.args[0] === "contact_id");
        expect(porContato, `${tabela} sem filtro por contato`).toBeDefined();
        expect((porContato!.args[1] as string[]).length).toBeLessThanOrEqual(50);
      }
    }
  });

  it("a página seguinte sai do cursor da anterior (keyset por nome e id), sem reler o começo", async () => {
    const primeira = (await abrir({})) as Props & { paginacao: { tipo: string; proximo: string | null } };
    expect(primeira.paginacao.tipo).toBe("cursor");
    expect(primeira.paginacao.proximo).toBeTruthy();
    consultas = [];
    await abrir({ cursor: primeira.paginacao.proximo! });
    const pagina = consultas.find((c) => c.tabela === "contacts" && c.chamadas.some((x) => x.metodo === "limit"))!;
    const keyset = pagina.chamadas.find((x) => x.metodo === "or");
    expect(String(keyset?.args[0])).toBe('nome_ordenacao.gt."contato 0049",and(nome_ordenacao.eq."contato 0049",id.gt.00000000-0000-4000-8000-000000000049)');
  });

  it("ordena pelo nome que a tela mostra (nome_ordenacao: nome exibido, senão nome, senão telefone), desempate por id", async () => {
    await abrir({});
    const pagina = consultas.find((c) => c.tabela === "contacts" && c.chamadas.some((x) => x.metodo === "limit"))!;
    const ordens = pagina.chamadas.filter((x) => x.metodo === "order").map((x) => x.args[0]);
    expect(ordens).toEqual(["nome_ordenacao", "id"]);
    expect(String(pagina.chamadas.find((x) => x.metodo === "select")?.args[0])).toContain("nome_ordenacao");
  });

  it("as sugestões de tag são as da organização inteira, não as da página", async () => {
    const props = await abrir({});
    expect(props.tags).toEqual(TAGS_DA_ORGANIZACAO);
    expect(rpcs).toEqual([{ fn: "fn_tags_dos_contatos", args: { p_org: "org-1" } }]);
  });

  it("com uma tag filtrada, as sugestões continuam sendo todas as da organização", async () => {
    const props = await abrir({ tag: "vip" });
    expect(props.tags).toEqual(TAGS_DA_ORGANIZACAO);
  });

  it("no caminho completo (ordem calculada) as sugestões também vêm da organização", async () => {
    const props = await abrir({ ordem: "total" });
    expect(props.tags).toEqual(TAGS_DA_ORGANIZACAO);
  });

  it("o filtro de funil vai ao banco pelo vínculo com o negócio (inner join)", async () => {
    await abrir({ pipeline: "p-1" });
    const deContatos = consultas.filter((c) => c.tabela === "contacts");
    for (const c of deContatos) {
      expect(String(c.chamadas.find((x) => x.metodo === "select")?.args[0])).toContain("crm_leads!inner(pipeline_id)");
      expect(c.chamadas.some((x) => x.metodo === "eq" && x.args[0] === "crm_leads.pipeline_id" && x.args[1] === "p-1")).toBe(true);
    }
  });

  it("CONTROLE: ordenar por total (calculado) segue lendo a base para ordenar entre todos", async () => {
    const props = await abrir({ ordem: "total" });
    expect(entregues.contacts).toBe(TOTAL_DE_CONTATOS);
    expect(props.resultado.linhas).toHaveLength(50);
  });
});
