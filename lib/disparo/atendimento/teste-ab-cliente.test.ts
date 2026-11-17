/**
 * Teste A/B da abertura (retomada): lead sorteado no teste (`custom_fields.ab_teste` preenchido)
 * NÃO é cliente, mesmo com classe P1-P4, `produto_origem` ou trilha de cliente. O produto P4 (P4, trilha `posvenda`) e o
 * antigo P2 entram no teste como gente que ainda não conhece o Produto A: recebem a explicação antes da tabela, não
 * recebem a resposta de reposição e ganham os toques do kit. Sem `ab_teste`, tudo segue como antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { TIPO_TOQUE_DO_KIT } from "../kit-followup";
import { repositorioSupabase } from "../repositorio-supabase";
import { CONFIG_METODO_EXEMPLO, CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import type { ConfigVenda } from "./config";
import { criarJulgar } from "./jev";
import { ehCliente, noTesteAB } from "./venda";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-10-14T13:00:00Z"); // quarta, 10h em São Paulo

const PRODUTO_P4 = { classe: "P4", grupo_base: "P4_produto_gip", produto_origem: "PAGO PRODUTO_P4", trilha: "posvenda" };
const NO_TESTE = { ab_teste: "1211", ab_braco: "B", ab_grupo: "produto" };

let n = 0;
function cenario(campos: Record<string, unknown>, config = CONFIG_METODO_EXEMPLO) {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), config);
  const lead = repo.novoLead(`lead-ab${++n}`, { campos });
  repo.chipPorLead.set(lead.id, "chip-ensaio");
  const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }), sortear: () => 0.5 };
  const diz = (texto: string) => atenderMensagem(deps, ORG, lead.id, { chave: `m${++n}`, messageId: null, texto, midia: false, conversationId: "conv-1" });
  const tipos = () => repo.enviosDo(lead.id).map((e) => e.tipo);
  return { repo, lead, diz, tipos };
}

describe("ehCliente com o teste A/B", () => {
  const c = CONFIG_VENDA_EXEMPLO as ConfigVenda;
  const lead = (campos: Record<string, unknown>) => ({ id: "l", nome: null, telefone: null, campos });

  it("P4 do produto, P2 e trilha de cliente são cliente sem ab_teste", () => {
    expect(ehCliente(c, lead(PRODUTO_P4))).toBe(true);
    expect(ehCliente(c, lead({ classe: "P2", produto_origem: "produto_a" }))).toBe(true);
    expect(ehCliente(c, lead({ trilha: "posvenda" }))).toBe(true);
  });

  it("com ab_teste preenchido, nenhum deles é cliente", () => {
    expect(ehCliente(c, lead({ ...PRODUTO_P4, ...NO_TESTE }))).toBe(false);
    expect(ehCliente(c, lead({ classe: "P2", produto_origem: "produto_a", ab_teste: "1211" }))).toBe(false);
    expect(ehCliente(c, lead({ trilha: "posvenda", ab_teste: "1211" }))).toBe(false);
  });

  it("quem comprou depois de sorteado volta a ser cliente (compras_aprovadas com 'aprovada')", () => {
    // Formato gravado pela integração de pagamento da organização: { [transação]: "aprovada" }.
    expect(ehCliente(c, lead({ ...PRODUTO_P4, ...NO_TESTE, compras_aprovadas: { "TX-1": "aprovada" } }))).toBe(true);
    expect(noTesteAB({ ...NO_TESTE, compras_aprovadas: { "TX-1": "reembolsada", "TX-2": "aprovada" } })).toBe(false);
    // Compra desfeita (reembolso) não conta: segue no teste.
    expect(noTesteAB({ ...NO_TESTE, compras_aprovadas: { "TX-1": "reembolsada" } })).toBe(true);
    expect(noTesteAB({ ...NO_TESTE, compras_aprovadas: "lixo" })).toBe(true);
  });

  it("ab_teste vazio ou só espaços não tira ninguém de cliente", () => {
    expect(ehCliente(c, lead({ ...PRODUTO_P4, ab_teste: "" }))).toBe(true);
    expect(ehCliente(c, lead({ ...PRODUTO_P4, ab_teste: "  " }))).toBe(true);
    expect(ehCliente(c, lead({ ...PRODUTO_P4, ab_teste: null }))).toBe(true);
  });
});

describe("atendimento: lead do teste A/B não é tratado como cliente", () => {
  it("P4 com ab_teste que diz 'sim' recebe a explicação, a tabela e os toques do kit", async () => {
    const { repo, lead, diz, tipos } = cenario({ ...PRODUTO_P4, ...NO_TESTE });
    await diz("sim, pode me contar");
    expect(tipos().some((t) => t.startsWith("explicacao"))).toBe(true);
    expect(tipos().some((t) => t.startsWith("tabela"))).toBe(true);
    expect(tipos()).not.toContain("reposicao");
    expect(repo.enviosDo(lead.id).filter((e) => TIPO_TOQUE_DO_KIT.test(e.tipo)).length).toBeGreaterThan(0);
  });

  it("P4 com ab_teste que fala bem 'do tratamento' NÃO recebe a resposta de reposição", async () => {
    const { diz, tipos } = cenario({ ...PRODUTO_P4, ...NO_TESTE });
    await diz("estou tomando e gostando, quero saber mais");
    expect(tipos()).not.toContain("reposicao");
    expect(tipos().some((t) => t.startsWith("tabela"))).toBe(true);
  });

  it("sem ab_teste o P4 segue cliente: reposição, sem explicação e sem toques do kit", async () => {
    const a = cenario(PRODUTO_P4);
    await a.diz("estou tomando e gostando, quero saber mais");
    expect(a.tipos().at(-1)).toBe("reposicao");

    const b = cenario(PRODUTO_P4);
    await b.diz("sim, pode me contar");
    expect(b.tipos().some((t) => t.startsWith("tabela"))).toBe(true);
    expect(b.tipos().some((t) => t.startsWith("explicacao"))).toBe(false);
    expect(b.repo.enviosDo(b.lead.id).filter((e) => TIPO_TOQUE_DO_KIT.test(e.tipo))).toHaveLength(0);
  });
});

describe("situacaoDoKit com o teste A/B (conferência do motor na hora de enviar o toque)", () => {
  /** Cliente falso: cada `from(tabela)` devolve a resposta daquela tabela. */
  const db = (custom_fields: Record<string, unknown>) =>
    ({
      from(tabela: string) {
        const resp: Record<string, unknown> = {
          crm_leads: { custom_fields },
          disparo_conversas: null,
          disparo_config: { atendimento: CONFIG_VENDA_EXEMPLO },
          disparo_quarentena: null,
        };
        const proxy: unknown = new Proxy(
          {},
          {
            get(_a, nome: string) {
              if (nome === "then") return (ok: (v: unknown) => unknown) => ok({ data: resp[tabela] ?? null, error: null, count: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
    }) as unknown as SupabaseClient;

  it("trilha de cliente sem ab_teste: cliente (o toque é cancelado)", async () => {
    expect((await repositorioSupabase(db({ trilha: "posvenda" })).situacaoDoKit!(ORG, "l1")).cliente).toBe(true);
  });

  it("trilha de cliente com ab_teste: não é cliente (o toque sai)", async () => {
    expect((await repositorioSupabase(db({ ...PRODUTO_P4, ...NO_TESTE })).situacaoDoKit!(ORG, "l1")).cliente).toBe(false);
  });

  it("trilha de cliente com ab_teste e compra aprovada: cliente (o toque é cancelado)", async () => {
    const campos = { ...PRODUTO_P4, ...NO_TESTE, compras_aprovadas: { "TX-1": "aprovada" } };
    expect((await repositorioSupabase(db(campos)).situacaoDoKit!(ORG, "l1")).cliente).toBe(true);
  });
});
