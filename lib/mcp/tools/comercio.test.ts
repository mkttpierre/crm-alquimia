import { describe, expect, it } from "vitest";

import { crmSearchProducts } from "./comercio";
import type { McpContext } from "../types";

/** Só o formato do campo que este arquivo mede — não o contrato inteiro. */
interface RespostaBusca {
  produtos: Array<{ preco: string }>;
}

/**
 * O PREÇO QUE O AGENTE COTA AO CLIENTE — NA CONVENÇÃO DA MOEDA DA LOJA.
 *
 * `precoLegivel()` era uma SEXTA cópia de formatador de dinheiro, não
 * declarada no comentário de `lib/money.ts` que lista as cinco conhecidas — e
 * a mais grave das seis: é o texto que `crm_search_products` devolve ao
 * agente, que é quem fala com o cliente por WhatsApp. A pantalla de Produtos
 * já mostrava `$249.90` para uma loja em MXN; o agente, com `precoLegivel`,
 * continuava dizendo `MXN 249,90` — o mesmo defeito que a migration 0208
 * documenta ter corrigido, sobrevivendo no único canal que fala com o
 * cliente de verdade.
 */

function ctxCom(produtos: Array<Record<string, unknown>>): McpContext {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    range: async () => ({ data: produtos, error: null, count: produtos.length }),
  };
  return {
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
    apiTokenId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: () => query } as any,
  } as McpContext;
}


/** O `Intl` emite NBSP (U+00A0) ou narrow NBSP (U+202F) entre símbolo e número. */
const semNbsp = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

const PRODUTO_MXN = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "IP15",
  nome: "iPhone 15",
  descricao: null,
  marca: null,
  categoria: null,
  preco_cents: 24990,
  moeda: "MXN",
  controla_estoque: false,
  quantidade: 0,
  ativo: true,
};

describe("crm_search_products — preço na convenção da moeda", () => {
  it("cota o preço em MXN como um comerciante mexicano lê, não em pt-BR", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([PRODUTO_MXN]),
    )) as RespostaBusca;

    expect(resultado.produtos).toHaveLength(1);
    // Ponto decimal e cifrão — não `MXN 249,90`, que era o que precoLegivel()
    // devolvia (vírgula decimal brasileira com o código colado na frente).
    expect(resultado.produtos[0]!.preco).toBe("$249.90");
    expect(resultado.produtos[0]!.preco).not.toContain("MXN 249,90");
  });

  it("continua certo em BRL — a troca não pode mudar o que já funcionava", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([{ ...PRODUTO_MXN, moeda: "BRL" }]),
    )) as RespostaBusca;

    expect(semNbsp(resultado.produtos[0]!.preco)).toBe("R$ 249,90");
  });
});

/**
 * PRODUTO INTERNO NÃO SAI PELO MCP. O preço de um plano interno é a COMISSÃO do operador: se o agente o cotasse ao lead,
 * o operador estaria dizendo ao cliente quanto ganha na venda. O filtro tem de estar na CONSULTA (o `ctx.supabase` aqui é
 * service role, sem RLS) e não só numa limpeza depois.
 */
describe("crm_search_products — produto interno não vaza", () => {
  function ctxEspiao(linhas: Array<Record<string, unknown>>) {
    const igualdades: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (coluna: string, valor: unknown) => {
        igualdades.push([coluna, valor]);
        return query;
      },
      order: () => query,
      // Um banco de mentira que honra o filtro pedido: só devolve o que passa pelos `.eq` recebidos.
      range: async () => {
        const filtradas = linhas.filter((l) => igualdades.every(([c, v]) => !(c in l) || l[c] === v));
        return { data: filtradas, error: null, count: filtradas.length };
      },
    };
    const ctx = {
      organizationId: "22222222-2222-4222-8222-222222222222",
      role: "agent",
      actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
      apiTokenId: "33333333-3333-4333-8333-333333333333",
      requestId: "44444444-4444-4444-8444-444444444444",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { from: () => query } as any,
    } as McpContext;
    return { ctx, igualdades };
  }

  const PUBLICO = { ...PRODUTO_MXN, moeda: "BRL", codigo: "MARCA-LOJA", nome: "Marca Loja", so_interno: false };
  const INTERNO = { ...PRODUTO_MXN, moeda: "BRL", id: "99999999-9999-4999-8999-999999999999", codigo: "marca (1mes)", nome: "1 MES (BETA) comissao", preco_cents: 12000, so_interno: true };

  it("a consulta pede so_interno = false", async () => {
    const { ctx, igualdades } = ctxEspiao([PUBLICO]);
    await crmSearchProducts.handler({ termo: "marca", limite: 8, somente_disponiveis: true }, ctx);
    expect(igualdades).toContainEqual(["so_interno", false]);
  });

  it("não devolve o produto interno nem o preço dele, mesmo com o mesmo termo", async () => {
    const { ctx } = ctxEspiao([PUBLICO, INTERNO]);
    const resposta = (await crmSearchProducts.handler({ termo: "marca", limite: 8, somente_disponiveis: true }, ctx)) as RespostaBusca;
    expect(resposta.produtos).toHaveLength(1);
    expect(JSON.stringify(resposta)).not.toContain("comissao");
    expect(JSON.stringify(resposta)).not.toContain("120,00");
  });
});
