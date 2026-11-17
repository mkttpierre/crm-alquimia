/**
 * A carga da personalização da barra: DUAS leituras independentes.
 *
 *  - os nomes (`organizations.nomes_da_barra`) são da ORGANIZAÇÃO e se leem pelo id
 *    dela, sem depender do vínculo de ninguém — é o que faz o modo suporte (sem
 *    vínculo próprio) ver os nomes que o admin do cliente deu;
 *  - a preferência (`user_organizations.preferencias_da_barra`) é da PESSOA, e sem
 *    pessoa (`userId` nulo, o suporte) não há o que ler;
 *  - as duas rodam em paralelo e cada uma cai para o padrão SOZINHA: a que falha não
 *    leva a outra junto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Resposta = { data: unknown; error: { code: string; message: string } | null };

const { chamadas, respostas, avisos } = vi.hoisted(() => ({
  chamadas: [] as Array<{
    tabela: string;
    colunas: string;
    filtros: Array<[string, string, unknown]>;
  }>,
  respostas: {} as Record<string, () => Promise<Resposta>>,
  avisos: [] as Array<{ msg: string; ctx: unknown }>,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (msg: string, ctx: unknown) => avisos.push({ msg, ctx }),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(tabela: string) {
      const registro = { tabela, colunas: "", filtros: [] as Array<[string, string, unknown]> };
      const b = {
        select(colunas: string) {
          registro.colunas = colunas;
          return b;
        },
        eq(coluna: string, valor: unknown) {
          registro.filtros.push(["eq", coluna, valor]);
          return b;
        },
        is(coluna: string, valor: unknown) {
          registro.filtros.push(["is", coluna, valor]);
          return b;
        },
        maybeSingle() {
          chamadas.push(registro);
          return respostas[tabela]!();
        },
      };
      return b;
    },
  }),
}));

import { carregarPersonalizacaoDaBarra } from "@/lib/navigation/personalizar-carregar";

const ORG = "org-1";
const USER = "user-1";

beforeEach(() => {
  chamadas.length = 0;
  avisos.length = 0;
  respostas.organizations = async () => ({
    data: { nomes_da_barra: { "/app/inbox": "Conversas" } },
    error: null,
  });
  respostas.user_organizations = async () => ({
    data: { preferencias_da_barra: { ocultos: ["/app/leads"], ordem: ["/app/agenda"] } },
    error: null,
  });
});

describe("carregarPersonalizacaoDaBarra", () => {
  it("⭐ lê os nomes direto de organizations pelo id da organização, e a preferência do vínculo da pessoa", async () => {
    const r = await carregarPersonalizacaoDaBarra(USER, ORG);
    expect(r).toEqual({
      preferencias: { ocultos: ["/app/leads"], ordem: ["/app/agenda"] },
      nomes: { "/app/inbox": "Conversas" },
    });
    const org = chamadas.find((c) => c.tabela === "organizations")!;
    expect(org.colunas).toBe("nomes_da_barra");
    expect(org.filtros).toEqual([["eq", "id", ORG]]);
    const vinculo = chamadas.find((c) => c.tabela === "user_organizations")!;
    expect(vinculo.colunas).toBe("preferencias_da_barra");
    expect(vinculo.filtros).toEqual([
      ["eq", "user_id", USER],
      ["eq", "organization_id", ORG],
      ["is", "revoked_at", null],
    ]);
  });

  it("⭐ sem pessoa (modo suporte) não toca user_organizations e devolve os nomes da organização", async () => {
    const r = await carregarPersonalizacaoDaBarra(null, ORG);
    expect(chamadas.map((c) => c.tabela)).toEqual(["organizations"]);
    expect(r.nomes).toEqual({ "/app/inbox": "Conversas" });
    expect(r.preferencias).toEqual({ ocultos: [], ordem: [] });
  });

  it("os nomes não dependem de haver vínculo: pessoa sem linha em user_organizations ainda recebe os nomes", async () => {
    respostas.user_organizations = async () => ({ data: null, error: null });
    const r = await carregarPersonalizacaoDaBarra(USER, ORG);
    expect(r.nomes).toEqual({ "/app/inbox": "Conversas" });
    expect(r.preferencias).toEqual({ ocultos: [], ordem: [] });
  });

  it("⭐ as duas leituras saem juntas: a segunda começa antes de a primeira responder", async () => {
    let solta!: () => void;
    const segura = new Promise<void>((ok) => (solta = ok));
    respostas.organizations = async () => {
      await segura;
      return { data: { nomes_da_barra: {} }, error: null };
    };
    const pronta = carregarPersonalizacaoDaBarra(USER, ORG);
    // Com a leitura dos nomes presa, a da preferência já tem de ter sido disparada.
    await Promise.resolve();
    await Promise.resolve();
    expect(chamadas.map((c) => c.tabela).sort()).toEqual(["organizations", "user_organizations"]);
    solta();
    await pronta;
  });

  it("⭐ cada leitura cai para o padrão sozinha: erro nos nomes não leva a preferência, e vice-versa", async () => {
    respostas.organizations = async () => ({
      data: null,
      error: { code: "42703", message: "coluna ausente" },
    });
    let r = await carregarPersonalizacaoDaBarra(USER, ORG);
    expect(r.nomes).toEqual({});
    expect(r.preferencias).toEqual({ ocultos: ["/app/leads"], ordem: ["/app/agenda"] });

    respostas.organizations = async () => ({
      data: { nomes_da_barra: { "/app/inbox": "Conversas" } },
      error: null,
    });
    respostas.user_organizations = async () => ({
      data: null,
      error: { code: "42703", message: "coluna ausente" },
    });
    r = await carregarPersonalizacaoDaBarra(USER, ORG);
    expect(r.nomes).toEqual({ "/app/inbox": "Conversas" });
    expect(r.preferencias).toEqual({ ocultos: [], ordem: [] });
    expect(avisos.length).toBe(2);
  });

  it("exceção de transporte também cai para o padrão, sem lançar", async () => {
    respostas.organizations = async () => {
      throw new Error("rede caiu");
    };
    const r = await carregarPersonalizacaoDaBarra(USER, ORG);
    expect(r.nomes).toEqual({});
    expect(r.preferencias).toEqual({ ocultos: ["/app/leads"], ordem: ["/app/agenda"] });
  });

  it("lixo gravado é normalizado, não repassado", async () => {
    respostas.organizations = async () => ({
      data: { nomes_da_barra: { "/app/inbox": 5, "/app/leads": "  Clientes  " } },
      error: null,
    });
    respostas.user_organizations = async () => ({
      data: { preferencias_da_barra: { ocultos: "x", ordem: [1, "/app/agenda"] } },
      error: null,
    });
    const r = await carregarPersonalizacaoDaBarra(USER, ORG);
    expect(r).toEqual({
      nomes: { "/app/leads": "Clientes" },
      preferencias: { ocultos: [], ordem: ["/app/agenda"] },
    });
  });
});
