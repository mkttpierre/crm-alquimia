import { describe, expect, it, vi } from "vitest";

import { lerAlvoDaVenda } from "./alvo-da-venda";

vi.mock("@/lib/catalogo/moeda-da-org", async () => ({ moedaDaOrganizacao: vi.fn(async () => "MXN") }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const AGORA = new Date("2026-11-08T15:00:00Z");

const itemDe = (id: string, nome: string, total: number, currency = "BRL") => ({
  id, lead_id: LEAD, product_id: null, nome, sku: null, quantidade: 1, preco_unit_cents: total, desconto_cents: 0, acrescimo_cents: 0, cupom: null, currency, total_cents: total, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
});

/** Supabase de mentira: a função de escolha devolve `escolhido`; as tabelas devolvem o que se pôs nelas. */
function dbCom(opcoes: { escolhido: string | null; negocio?: Record<string, unknown>; itens?: Array<Record<string, unknown>>; timezone?: string }) {
  const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      chamadas.push({ fn, args });
      return { data: opcoes.escolhido, error: null };
    },
    from: (tabela: string) => {
      const linhas =
        tabela === "crm_leads" ? [opcoes.negocio ?? {}] : tabela === "crm_lead_items" ? (opcoes.itens ?? []) : tabela === "organizations" ? [{ timezone: opcoes.timezone ?? "America/Sao_Paulo" }] : [];
      const cadeia: Record<string, unknown> = {};
      let faixa: [number, number] | null = null;
      for (const m of ["select", "eq", "order", "in"]) cadeia[m] = () => cadeia;
      // como o PostgREST: respeita a faixa e nunca devolve mais que 1000 linhas por consulta
      cadeia.range = (de: number, ate: number) => {
        faixa = [de, ate];
        return cadeia;
      };
      cadeia.maybeSingle = async () => ({ data: linhas[0] ?? null, error: null });
      cadeia.then = (res: (v: unknown) => unknown) => {
        const [de, ate] = faixa ?? [0, 999];
        return res({ data: linhas.slice(de, Math.min(ate, de + 999) + 1), error: null });
      };
      return cadeia;
    },
  };
  return { db: db as never, chamadas };
}

describe("lerAlvoDaVenda — o que a venda vai usar, antes de confirmar", () => {
  it("usa a MESMA função do banco da operação, sem travar a linha, com a organização da sessão", async () => {
    const { db, chamadas } = dbCom({ escolhido: null });
    await lerAlvoDaVenda(db, ORG, { contactId: CONTATO, leadId: LEAD }, AGORA);
    expect(chamadas).toEqual([{ fn: "fn_escolher_negocio_da_venda", args: { p_org: ORG, p_contact: CONTATO, p_lead: LEAD, p_travar: false } }]);
  });

  it("sem negócio aberto: nenhum item, total zero e a moeda é a da ORGANIZAÇÃO", async () => {
    const { db } = dbCom({ escolhido: null });
    const r = await lerAlvoDaVenda(db, ORG, { contactId: CONTATO }, AGORA);
    expect(r).toMatchObject({ negocio: null, itens: [], ja_no_negocio_cents: 0, moeda: "MXN" });
  });

  it("com negócio aberto: devolve os itens que já estão nele, a soma e a moeda do NEGÓCIO (não a da organização)", async () => {
    const { db } = dbCom({
      escolhido: LEAD,
      negocio: { id: LEAD, title: "Negócio de Exemplo", currency: "BRL", status: "open" },
      itens: [itemDe("i1", "1 MÊS", 12000), itemDe("i2", "3 MESES", 18200), itemDe("i3", "Em dólar", 999, "USD")],
    });
    const r = await lerAlvoDaVenda(db, ORG, { contactId: CONTATO }, AGORA);
    expect(r.negocio).toMatchObject({ id: LEAD, titulo: "Negócio de Exemplo" });
    expect(r.moeda).toBe("BRL");
    expect(r.itens.map((i) => i.nome)).toEqual(["1 MÊS", "3 MESES", "Em dólar"]);
    // só a moeda do negócio entra na conta, como no trigger do banco
    expect(r.ja_no_negocio_cents).toBe(30200);
  });

  it("com mais de 1000 linhas no negócio, o \"já no negócio\" soma TODAS (a prévia não mente)", async () => {
    const muitos = Array.from({ length: 2500 }, (_, i) => itemDe(`m${i}`, "Linha", 100));
    const { db } = dbCom({ escolhido: LEAD, negocio: { id: LEAD, title: "Grande", currency: "BRL", status: "open" }, itens: muitos });
    const r = await lerAlvoDaVenda(db, ORG, { contactId: CONTATO }, AGORA);
    expect(r.itens).toHaveLength(2500);
    expect(r.ja_no_negocio_cents).toBe(250_000);
  });

  it("devolve o fuso da organização e o 'hoje' DE LÁ (não o do UTC)", async () => {
    const { db } = dbCom({ escolhido: null, timezone: "America/Sao_Paulo" });
    const noite = new Date("2026-11-08T02:00:00Z"); // 23h de 07/11 em São Paulo
    expect(await lerAlvoDaVenda(db, ORG, { contactId: CONTATO }, noite)).toMatchObject({ timezone: "America/Sao_Paulo", hoje: "2026-11-07" });
  });

  it("erro do banco na escolha vira exceção (a rota responde 500), não 'sem negócio'", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "boom" } }), from: () => ({}) } as never;
    await expect(lerAlvoDaVenda(db, ORG, { contactId: CONTATO }, AGORA)).rejects.toBeTruthy();
  });
});
