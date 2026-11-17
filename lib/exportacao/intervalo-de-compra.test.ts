// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { LimiteDeLeituraExcedido } from "@/lib/negocio/limite-de-leitura";
import { ultimaCompraNoIntervalo } from "@/lib/negocio/selecionar-leads";
import { bancoFalso, type Linha } from "@/tests/helpers/postgrest-falso";

import { idsDeContatosNoIntervalo } from "./intervalo-de-compra";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("ultimaCompraNoIntervalo — a regra da tela de Leads", () => {
  it("sem intervalo, todos passam (inclusive quem nunca comprou)", () => {
    expect(ultimaCompraNoIntervalo(null, undefined, undefined)).toBe(true);
    expect(ultimaCompraNoIntervalo("2026-05-01T10:00:00Z", undefined, undefined)).toBe(true);
  });

  it("com intervalo, quem nunca comprou fica de fora; os limites valem pelo DIA, inclusive", () => {
    expect(ultimaCompraNoIntervalo(null, "2026-01-01", undefined)).toBe(false);
    expect(ultimaCompraNoIntervalo("2026-05-01T23:59:00Z", "2026-05-01", "2026-05-01")).toBe(true);
    expect(ultimaCompraNoIntervalo("2026-04-30T23:59:00Z", "2026-05-01", undefined)).toBe(false);
    expect(ultimaCompraNoIntervalo("2026-05-02T00:00:00Z", undefined, "2026-05-01")).toBe(false);
  });
});

function pedido(id: string, contato: string, quando: string): Linha {
  return {
    id,
    organization_id: ORG,
    contact_id: contato,
    external_id: id,
    ordered_at: quando,
    total_cents: 1000,
    currency: "BRL",
    status: "paid",
  };
}

function contato(id: string, nome: string): Linha {
  return { id, organization_id: ORG, display_name: nome, name: null, phone_number: null, tags: [], source_metadata: null, nome_ordenacao: nome, is_merged_into: null };
}

/** O banco falso mais o RPC de tags que `carregarLeads` chama. */
function banco(tabelas: Record<string, Linha[]>) {
  const { db } = bancoFalso({ crm_leads: [], crm_lead_links: [], crm_pipelines: [], ...tabelas });
  return { ...(db as object), rpc: async () => ({ data: [], error: null }) } as never;
}

describe("idsDeContatosNoIntervalo — reaproveita carregarLeads + a regra da tela", () => {
  it("devolve só os contatos cuja ÚLTIMA compra cai no intervalo", async () => {
    const db = banco({
      contacts: [contato("c1", "Ana"), contato("c2", "Bruno"), contato("c3", "Caio")],
      orders: [
        pedido("o1", "c1", "2026-03-10T12:00:00Z"),
        pedido("o2", "c1", "2026-06-10T12:00:00Z"), // a última de Ana é junho
        pedido("o3", "c2", "2026-03-15T12:00:00Z"),
      ],
    });
    const ids = await idsDeContatosNoIntervalo(db, ORG, { de: "2026-03-01", ate: "2026-03-31" });
    // Ana comprou em março, mas a ÚLTIMA compra dela é junho: fora. Bruno dentro. Caio nunca comprou: fora.
    expect([...ids]).toEqual(["c2"]);
  });

  it("repassa busca, etiqueta e funil à leitura (mesmos filtros do servidor da tela)", async () => {
    const { db, consultas } = bancoFalso({
      contacts: [contato("c1", "Ana")],
      crm_leads: [],
      orders: [],
      crm_lead_links: [],
      crm_pipelines: [],
    });
    const comRpc = { ...(db as object), rpc: async () => ({ data: [], error: null }) } as never;
    await idsDeContatosNoIntervalo(comRpc, ORG, { busca: "ana", tag: "vip", de: "2026-01-01" });
    const deContatos = consultas.find((c) => c.tabela === "contacts")!;
    expect(deContatos.filtros.some((f) => f.startsWith("or:"))).toBe(true);
    expect(deContatos.filtros.some((f) => f.startsWith("contains:tags=vip"))).toBe(true);
  });

  // M3: a exportação descarta as tags da organização e os funis (só usa os ids dos contatos); não paga essas leituras.
  it("não lê o vocabulário de tags (RPC) nem a tabela de funis, que a exportação descarta", async () => {
    const { db, consultas } = bancoFalso({
      contacts: [contato("c1", "Ana")],
      crm_leads: [],
      orders: [pedido("o1", "c1", "2026-03-10T12:00:00Z")],
      crm_lead_links: [],
      crm_pipelines: [{ id: "f1", organization_id: ORG, name: "Vendas" }],
    });
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const comRpc = { ...(db as object), rpc } as never;
    const ids = await idsDeContatosNoIntervalo(comRpc, ORG, { de: "2026-03-01", ate: "2026-03-31" });
    expect([...ids]).toEqual(["c1"]);
    expect(rpc).not.toHaveBeenCalled();
    expect(consultas.map((c) => c.tabela)).not.toContain("crm_pipelines");
  });

  it("passou do teto de 20 mil contatos: falha com o erro tipado do teto (a rota responde 422)", async () => {
    const muitos = Array.from({ length: 20001 }, (_, i) => contato(`c${i}`, `Nome ${i}`));
    const db = banco({ contacts: muitos, orders: [] });
    await expect(idsDeContatosNoIntervalo(db, ORG, { de: "2026-03-01" })).rejects.toBeInstanceOf(LimiteDeLeituraExcedido);
  });
});
