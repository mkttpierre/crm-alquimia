// @vitest-environment node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { collectExportData } from "@/lib/lgpd/export-collector";
import { renderLgpdPdf } from "@/lib/lgpd/pdf-renderer";

/**
 * O VALOR DE UM NEGÓCIO SIGILOSO NÃO SAI NA EXPORTAÇÃO LGPD.
 *
 * O relatório (data.json + report.pdf) vai ao TITULAR. Em negócio de `valor_sigiloso` o `value_cents` é a COMISSÃO do
 * operador (migration 0251): nem o JSON nem o PDF o levam. O resto do negócio (título, status, datas) continua lá: o titular
 * tem direito de saber que o negócio existe. Os demais campos de dinheiro do coletor (pedidos da loja) não são do negócio.
 *
 * O coletor roda de verdade, com um Supabase de mentira que devolve o que se pôs em cada tabela e anota as colunas pedidas.
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

const NEGOCIO_SIGILOSO = { id: "n1", pipeline_id: "p", stage_id: "s", title: "Venda — Maria", status: "won", value_cents: 49371, currency: "BRL", created_at: "2026-11-08T10:00:00Z", valor_sigiloso: true };
const NEGOCIO_COMUM = { id: "n2", pipeline_id: "p", stage_id: "s", title: "Negócio comum", status: "open", value_cents: 5000, currency: "BRL", created_at: "2026-11-01T10:00:00Z", valor_sigiloso: false };

const colunasPedidas: Record<string, string[]> = {};

function fakeAdmin(tabelas: Record<string, unknown[]>) {
  return {
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["eq", "or", "order", "limit", "range", "in"]) b[m] = () => b;
      b.select = (colunas: string) => {
        (colunasPedidas[tabela] ??= []).push(colunas);
        return b;
      };
      b.maybeSingle = async () => ({ data: (tabelas[tabela] ?? [])[0] ?? null, error: null });
      b.then = (res: (v: unknown) => unknown) => res({ data: tabelas[tabela] ?? [], error: null, count: (tabelas[tabela] ?? []).length });
      return b;
    },
  };
}

beforeEach(() => {
  for (const k of Object.keys(colunasPedidas)) delete colunasPedidas[k];
  vi.mocked(createAdminClient).mockReturnValue(
    fakeAdmin({
      organizations: [{ legal_name: "Empresa LTDA", display_name: "Empresa", dpo_email: "dpo@empresa.test" }],
      contacts: [{ id: CONTATO, name: "Maria", display_name: "Maria", email: null, phone_number: "+5511999990000", created_at: "2026-10-01T00:00:00Z" }],
      crm_leads: [NEGOCIO_SIGILOSO, NEGOCIO_COMUM],
      orders: [{ id: "o1", external_id: "100", external_provider: "nuvemshop", status: "paid", total_cents: 7000, currency: "BRL", ordered_at: "2026-11-03T00:00:00Z" }],
    }) as never,
  );
});

async function coletar() {
  return collectExportData({ organizationId: ORG, requestId: "req-1", contactId: CONTATO, externalCustomerId: null });
}

async function textoDoPdf(bytes: Uint8Array): Promise<string> {
  const fontes = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts").replaceAll("\\", "/") + "/";
  const tarefa = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: fontes });
  const doc = await tarefa.promise;
  try {
    const paginas: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const conteudo = await (await doc.getPage(n)).getTextContent();
      paginas.push(conteudo.items.map((i) => ("str" in i ? i.str : "")).join(" "));
    }
    return paginas.join("\n").replace(/\s+/g, " ");
  } finally {
    await tarefa.destroy();
  }
}

describe("exportação LGPD — negócio de valor sigiloso", () => {
  it("o JSON não leva o valor do negócio sigiloso, e leva o resto do negócio", async () => {
    const dados = await coletar();
    const sigiloso = dados.leads.find((l) => l.id === "n1")!;
    expect(sigiloso.value_cents).toBeNull();
    expect(sigiloso).toMatchObject({ title: "Venda — Maria", status: "won", currency: "BRL", created_at: "2026-11-08T10:00:00Z" });
    expect(JSON.stringify(dados)).not.toContain("49371");
    // a marca em si também não é entregue ao titular
    expect(JSON.stringify(dados)).not.toContain("valor_sigiloso");
  });

  it("negócio comum continua com o valor (o recurso não mudou para quem não usa produto interno)", async () => {
    const dados = await coletar();
    expect(dados.leads.find((l) => l.id === "n2")!.value_cents).toBe(5000);
  });

  it("falha fechado: negócio sem a marca na resposta (valor_sigiloso ausente) não entrega o valor", async () => {
    const { valor_sigiloso: _marca, ...semMarca } = NEGOCIO_SIGILOSO;
    void _marca;
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ organizations: [], contacts: [{ id: CONTATO }], crm_leads: [semMarca] }) as never);
    const dados = await coletar();
    expect(dados.leads[0]!.value_cents).toBeNull();
  });

  it("a consulta pede a marca junto com o valor (sem ela o banco recusaria e o negócio sumiria do relatório)", async () => {
    await coletar();
    expect(colunasPedidas.crm_leads?.[0]).toMatch(/valor_sigiloso/);
  });

  it("os itens e as atividades do negócio não entram no relatório (nenhum outro campo de dinheiro do negócio sai)", async () => {
    await coletar();
    expect(Object.keys(colunasPedidas)).not.toContain("crm_lead_items");
    for (const colunas of colunasPedidas.crm_lead_activities ?? []) expect(colunas).not.toMatch(/payload|cents|total/);
  });

  it("o PDF entregue ao titular não imprime o valor do negócio sigiloso, e imprime o do comum e o do pedido da loja", async () => {
    const dados = await coletar();
    const texto = await textoDoPdf(await renderLgpdPdf(dados));
    expect(texto).toContain("Venda — Maria");
    expect(texto).not.toMatch(/493[.,]71/);
    expect(texto).toContain("BRL 50.00");
    expect(texto).toContain("BRL 70.00");
  });
});
