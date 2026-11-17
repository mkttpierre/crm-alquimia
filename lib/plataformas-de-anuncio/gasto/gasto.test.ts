import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { criarFonteGoogleAds } from "./google";
import { criarFonteMetaAds, gastoEmCentavos, somarGasto, type DependenciasDoGastoMeta } from "./meta";
import {
  fontesDeGasto,
  intervaloDeGastoLido,
  lerGastoDasFontes,
  resumirAnuncios,
  somarSerieAte,
  type FonteDeGasto,
  type LeituraDeGasto,
  type PedidoDeGasto,
} from "./index";

// Tudo mockado: nenhum teste chama a plataforma de anúncios nem o banco.
const admin = {} as SupabaseClient;
const pedido: PedidoDeGasto = { organizationId: "org-1", de: "2026-11-01", ate: "2026-11-16", moeda: "BRL" };

function deps(over: Partial<DependenciasDoGastoMeta> = {}): DependenciasDoGastoMeta {
  return {
    lerCredencial: vi.fn(async () => ({ ok: true as const, credencial: { accessToken: "token-de-teste", contaPadrao: "act_111" } })),
    listarContas: vi.fn(async () => ({ ok: true as const, dados: [{ id: "act_111", nome: "Conta", moeda: "BRL", status: 1 }] })),
    lerInsights: vi.fn(async () => ({ ok: true as const, dados: [{ spend: "100.50" }, { spend: "49.5" }, {}] })),
    memorizar: async (_chave, _segundos, ler) => ler(),
    ...over,
  };
}

describe("gasto em centavos", () => {
  it("converte o texto da plataforma e trata ausência como zero", () => {
    expect(gastoEmCentavos("123.45")).toBe(12_345);
    expect(gastoEmCentavos("0.1")).toBe(10);
    expect(gastoEmCentavos(undefined)).toBe(0);
    expect(gastoEmCentavos("abc")).toBe(0);
    expect(gastoEmCentavos("-5")).toBe(0);
    expect(somarGasto([{ spend: "10.00" }, { spend: "5.55" }, {}])).toBe(1_555);
  });
});

describe("fonte Meta Ads", () => {
  it("⭐ conectada: soma o gasto das campanhas da conta padrão no período pedido", async () => {
    const d = deps();
    const l = await criarFonteMetaAds(admin, d).lerGasto(pedido);
    expect(l).toEqual({ estado: "conectada", plataforma: "meta_ads", gasto_cents: 15_000, moeda: "BRL" });
    expect(d.lerCredencial).toHaveBeenCalledWith(admin, "org-1", "meta_ads");
    expect(d.lerInsights).toHaveBeenCalledWith("token-de-teste", "act_111", "2026-11-01", "2026-11-16");
  });

  it("conta padrão sem o prefixo act_ ainda funciona", async () => {
    const d = deps({ lerCredencial: vi.fn(async () => ({ ok: true as const, credencial: { accessToken: "t", contaPadrao: "111" } })) });
    expect((await criarFonteMetaAds(admin, d).lerGasto(pedido)).estado).toBe("conectada");
    expect(d.lerInsights).toHaveBeenCalledWith("t", "act_111", expect.any(String), expect.any(String));
  });

  it("sem conexão guardada: não conectada, e não chama a plataforma", async () => {
    const d = deps({ lerCredencial: vi.fn(async () => ({ ok: false as const, motivo: "sem_conexao" as const })) });
    expect(await criarFonteMetaAds(admin, d).lerGasto(pedido)).toEqual({ estado: "nao_conectada", plataforma: "meta_ads" });
    expect(d.listarContas).not.toHaveBeenCalled();
    expect(d.lerInsights).not.toHaveBeenCalled();
  });

  it("cifra indisponível é problema da instalação: indisponível, não 'não conectada'", async () => {
    const d = deps({ lerCredencial: vi.fn(async () => ({ ok: false as const, motivo: "cifra_indisponivel" as const })) });
    expect(await criarFonteMetaAds(admin, d).lerGasto(pedido)).toEqual({ estado: "indisponivel", plataforma: "meta_ads", motivo: "cifra_indisponivel" });
  });

  it("conectada mas sem conta padrão escolhida", async () => {
    const d = deps({ lerCredencial: vi.fn(async () => ({ ok: true as const, credencial: { accessToken: "t", contaPadrao: null } })) });
    expect(await criarFonteMetaAds(admin, d).lerGasto(pedido)).toEqual({ estado: "sem_conta", plataforma: "meta_ads" });
    expect(d.lerInsights).not.toHaveBeenCalled();
  });

  it("⭐ conta em outra moeda NÃO entra na soma (R$ + US$ não é número de ninguém)", async () => {
    const d = deps({ listarContas: vi.fn(async () => ({ ok: true as const, dados: [{ id: "act_111", nome: "C", moeda: "USD", status: 1 }] })) });
    expect(await criarFonteMetaAds(admin, d).lerGasto(pedido)).toEqual({ estado: "moeda_diferente", plataforma: "meta_ads", moeda_da_conta: "USD" });
  });

  it("token que não alcança a conta padrão: permissão", async () => {
    const d = deps({ listarContas: vi.fn(async () => ({ ok: true as const, dados: [] })) });
    expect(await criarFonteMetaAds(admin, d).lerGasto(pedido)).toEqual({ estado: "indisponivel", plataforma: "meta_ads", motivo: "permissao_insuficiente" });
  });

  it("falha de leitura vira indisponível com o motivo, sem lançar", async () => {
    const insights = deps({ lerInsights: vi.fn(async () => ({ ok: false as const, falha: "limite_de_chamadas" as const, detalhe: "x" })) });
    expect(await criarFonteMetaAds(admin, insights).lerGasto(pedido)).toEqual({ estado: "indisponivel", plataforma: "meta_ads", motivo: "limite_de_chamadas" });
    const contas = deps({ listarContas: vi.fn(async () => ({ ok: false as const, falha: "token_invalido" as const, detalhe: "x" })) });
    expect(await criarFonteMetaAds(admin, contas).lerGasto(pedido)).toEqual({ estado: "indisponivel", plataforma: "meta_ads", motivo: "token_invalido" });
  });

  it("conta ativa sem veiculação: conectada com gasto zero", async () => {
    const d = deps({ lerInsights: vi.fn(async () => ({ ok: true as const, dados: [] })) });
    expect(await criarFonteMetaAds(admin, d).lerGasto(pedido)).toMatchObject({ estado: "conectada", gasto_cents: 0 });
  });
});

describe("achado 1: o gasto do Meta é guardado em cache, por organização, conta, período e moeda", () => {
  type Chamada = { chave: readonly string[]; segundos: number };

  function comCache() {
    const chamadas: Chamada[] = [];
    const guardado = new Map<string, unknown>();
    const memorizar: DependenciasDoGastoMeta["memorizar"] = async (chave, segundos, ler) => {
      chamadas.push({ chave, segundos });
      const k = JSON.stringify(chave);
      if (!guardado.has(k)) guardado.set(k, await ler());
      return guardado.get(k) as never;
    };
    return { chamadas, memorizar };
  }

  it("⭐ insights por 15 min e lista de contas por 1 h, com a chave carregando organização+conta+de+até+moeda", async () => {
    const { chamadas, memorizar } = comCache();
    await criarFonteMetaAds(admin, deps({ memorizar })).lerGasto(pedido);
    const insights = chamadas.find((c) => c.chave.includes("insights"));
    const contas = chamadas.find((c) => c.chave.includes("contas"));
    expect(insights?.segundos).toBe(15 * 60);
    expect(insights?.chave).toEqual(expect.arrayContaining(["org-1", "act_111", "2026-11-01", "2026-11-16", "BRL"]));
    expect(contas?.segundos).toBe(60 * 60);
    expect(contas?.chave).toEqual(expect.arrayContaining(["org-1"]));
  });

  describe("achado 2: a chave da lista de contas acompanha a conexão (conta padrão e impressão do token)", () => {
    const credencial = (accessToken: string, contaPadrao: string | null) => vi.fn(async () => ({ ok: true as const, credencial: { accessToken, contaPadrao } }));
    const impressao = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

    it("⭐ a chave leva a conta padrão e o prefixo do sha256 do token, nunca o token", async () => {
      const { chamadas, memorizar } = comCache();
      await criarFonteMetaAds(admin, deps({ memorizar })).lerGasto(pedido);
      const contas = chamadas.find((c) => c.chave.includes("contas"));
      expect(contas?.chave).toEqual(["gasto-meta", "contas", "org-1", "act_111", impressao("token-de-teste")]);
      expect(JSON.stringify(chamadas)).not.toContain("token-de-teste");
    });

    it("⭐ token novo (reconexão): a lista é lida de novo, em vez de servir a velha por até 1 h", async () => {
      const { memorizar } = comCache();
      const a = deps({ memorizar, lerCredencial: credencial("token-velho", "act_111") });
      await criarFonteMetaAds(admin, a).lerGasto(pedido);
      const b = deps({
        memorizar,
        lerCredencial: credencial("token-novo", "act_111"),
        listarContas: vi.fn(async () => ({ ok: true as const, dados: [{ id: "act_111", nome: "Conta", moeda: "BRL", status: 1 }] })),
      });
      await criarFonteMetaAds(admin, b).lerGasto(pedido);
      expect(a.listarContas).toHaveBeenCalledTimes(1);
      expect(b.listarContas).toHaveBeenCalledTimes(1);
      expect(b.listarContas).toHaveBeenCalledWith("token-novo");
    });

    it("⭐ conta padrão trocada com o mesmo token: a lista é lida de novo", async () => {
      const { chamadas, memorizar } = comCache();
      const d = deps({
        memorizar,
        lerCredencial: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, credencial: { accessToken: "t", contaPadrao: "act_111" } })
          .mockResolvedValueOnce({ ok: true, credencial: { accessToken: "t", contaPadrao: "act_222" } }),
        listarContas: vi.fn(async () => ({
          ok: true as const,
          dados: [
            { id: "act_111", nome: "A", moeda: "BRL", status: 1 },
            { id: "act_222", nome: "B", moeda: "BRL", status: 1 },
          ],
        })),
      });
      const fonte = criarFonteMetaAds(admin, d);
      await fonte.lerGasto(pedido);
      await fonte.lerGasto(pedido);
      expect(d.listarContas).toHaveBeenCalledTimes(2);
      const chavesDeContas = chamadas.filter((c) => c.chave.includes("contas")).map((c) => c.chave);
      expect(chavesDeContas[0]).not.toEqual(chavesDeContas[1]);
    });

    it("mesma conexão, mesma chave: a segunda abertura segue sem chamar a plataforma", async () => {
      const { memorizar } = comCache();
      const d = deps({ memorizar });
      const fonte = criarFonteMetaAds(admin, d);
      await fonte.lerGasto(pedido);
      await fonte.lerGasto({ ...pedido, ate: "2026-11-10" });
      expect(d.listarContas).toHaveBeenCalledTimes(1);
    });
  });

  it("⭐ a chave NÃO leva o token (segredo não entra em chave de cache)", async () => {
    const { chamadas, memorizar } = comCache();
    await criarFonteMetaAds(admin, deps({ memorizar })).lerGasto(pedido);
    expect(JSON.stringify(chamadas)).not.toContain("token-de-teste");
  });

  it("⭐ a segunda abertura com o mesmo pedido não chama a plataforma de novo", async () => {
    const { memorizar } = comCache();
    const d = deps({ memorizar });
    const fonte = criarFonteMetaAds(admin, d);
    const a = await fonte.lerGasto(pedido);
    const b = await fonte.lerGasto(pedido);
    expect(b).toEqual(a);
    expect(d.lerInsights).toHaveBeenCalledTimes(1);
    expect(d.listarContas).toHaveBeenCalledTimes(1);
  });

  it("período, organização ou moeda diferentes não se misturam", async () => {
    const { memorizar } = comCache();
    const d = deps({ memorizar });
    const fonte = criarFonteMetaAds(admin, d);
    await fonte.lerGasto(pedido);
    await fonte.lerGasto({ ...pedido, ate: "2026-11-10" });
    await fonte.lerGasto({ ...pedido, organizationId: "org-2" });
    expect(d.lerInsights).toHaveBeenCalledTimes(3);
  });

  it("⭐ falha da plataforma NÃO fica guardada: a próxima abertura tenta de novo", async () => {
    // Um cache que guarda o que a função devolve e NÃO guarda o que ela lança (o contrato do `unstable_cache`).
    const guardado = new Map<string, unknown>();
    const memorizar: DependenciasDoGastoMeta["memorizar"] = async (chave, _s, ler) => {
      const k = JSON.stringify(chave);
      if (!guardado.has(k)) guardado.set(k, await ler());
      return guardado.get(k) as never;
    };
    let falhar = true;
    const d = deps({
      memorizar,
      lerInsights: vi.fn(async () => (falhar ? { ok: false as const, falha: "limite_de_chamadas" as const, detalhe: "x" } : { ok: true as const, dados: [{ spend: "10.00" }] })),
    });
    const fonte = criarFonteMetaAds(admin, d);
    expect(await fonte.lerGasto(pedido)).toEqual({ estado: "indisponivel", plataforma: "meta_ads", motivo: "limite_de_chamadas" });
    falhar = false;
    expect(await fonte.lerGasto(pedido)).toMatchObject({ estado: "conectada", gasto_cents: 1_000 });
    expect(d.lerInsights).toHaveBeenCalledTimes(2);
  });

  it("a credencial é lida a cada vez (é barata e é ela que diz quem é a conta); só a plataforma passa pelo cache", async () => {
    const { memorizar } = comCache();
    const d = deps({ memorizar });
    const fonte = criarFonteMetaAds(admin, d);
    await fonte.lerGasto(pedido);
    await fonte.lerGasto(pedido);
    expect(d.lerCredencial).toHaveBeenCalledTimes(2);
  });
});

describe("achado 10: o gasto do Meta não inclui o dia de hoje (a plataforma ainda o fecha)", () => {
  it("⭐ intervaloDeGastoLido corta no dia de ontem quando o período chega a hoje", () => {
    expect(intervaloDeGastoLido("2026-11-01", "2026-11-16", "2026-11-16")).toEqual({ de: "2026-11-01", ate: "2026-11-15", sem_hoje: true });
    expect(intervaloDeGastoLido("2026-11-10", "2026-11-16", "2026-11-16")).toEqual({ de: "2026-11-10", ate: "2026-11-15", sem_hoje: true });
  });

  it("período que já terminou fica como está", () => {
    expect(intervaloDeGastoLido("2026-10-01", "2026-10-31", "2026-11-16")).toEqual({ de: "2026-10-01", ate: "2026-10-31", sem_hoje: false });
  });

  it("'Hoje' vira um intervalo vazio (de depois de até)", () => {
    const i = intervaloDeGastoLido("2026-11-16", "2026-11-16", "2026-11-16");
    expect(i.sem_hoje).toBe(true);
    expect(i.ate < i.de).toBe(true);
  });

  it("⭐ intervalo vazio: a fonte responde 'dia incompleto' SEM chamar a plataforma", async () => {
    const d = deps();
    const l = await criarFonteMetaAds(admin, d).lerGasto({ ...pedido, de: "2026-11-16", ate: "2026-11-15" });
    expect(l).toEqual({ estado: "dia_incompleto", plataforma: "meta_ads" });
    expect(d.listarContas).not.toHaveBeenCalled();
    expect(d.lerInsights).not.toHaveBeenCalled();
  });

  it("intervalo vazio sem conexão continua 'não conectada' (os cartões somem)", async () => {
    const d = deps({ lerCredencial: vi.fn(async () => ({ ok: false as const, motivo: "sem_conexao" as const })) });
    expect(await criarFonteMetaAds(admin, d).lerGasto({ ...pedido, de: "2026-11-16", ate: "2026-11-15" })).toEqual({ estado: "nao_conectada", plataforma: "meta_ads" });
  });

  it("⭐ 'dia incompleto' mantém os cartões visíveis, sem número, e diz isso", () => {
    const r = resumirAnuncios(
      [
        { estado: "dia_incompleto", plataforma: "meta_ads" },
        { estado: "nao_conectada", plataforma: "google_ads" },
      ],
      { total_cents: 9_000, vendas: 2 },
      { ate: "2026-11-15", sem_hoje: true },
    );
    expect(r.visivel).toBe(true);
    expect(r.gasto_cents).toBeNull();
    expect(r.roas).toBeNull();
    expect(r.custo_por_venda_cents).toBeNull();
    expect(r.sem_hoje).toBe(true);
  });

  it("o resumo guarda até onde o gasto foi lido", () => {
    const r = resumirAnuncios([{ estado: "conectada", plataforma: "meta_ads", gasto_cents: 100, moeda: "BRL" }], { total_cents: 300, vendas: 1 }, { ate: "2026-11-15", sem_hoje: true });
    expect(r).toMatchObject({ ate_lido: "2026-11-15", sem_hoje: true, roas: 3 });
    expect(resumirAnuncios([], { total_cents: 0, vendas: 0 })).toMatchObject({ ate_lido: null, sem_hoje: false });
  });

  it("⭐ faturamento e vendas para o ROAS são somados no MESMO intervalo do gasto (até ontem)", () => {
    const serie = [
      { dia: "2026-11-14", total_cents: 100, vendas: 1 },
      { dia: "2026-11-15", total_cents: 200, vendas: 2 },
      { dia: "2026-11-16", total_cents: 4_000, vendas: 9 },
    ];
    expect(somarSerieAte(serie, "2026-11-15")).toEqual({ total_cents: 300, vendas: 3 });
    expect(somarSerieAte(serie, "2026-11-16")).toEqual({ total_cents: 4_300, vendas: 12 });
    expect(somarSerieAte(serie, "2026-11-01")).toEqual({ total_cents: 0, vendas: 0 });
  });
});

describe("fonte Google Ads", () => {
  it("⭐ está 'não conectada', sem tocar em rede nem em banco, pronta para plugar", async () => {
    const f = criarFonteGoogleAds();
    expect(f.plataforma).toBe("google_ads");
    expect(await f.lerGasto(pedido)).toEqual({ estado: "nao_conectada", plataforma: "google_ads" });
  });

  it("a lista de fontes conhecidas tem as duas, na ordem do painel", () => {
    expect(fontesDeGasto(admin).map((f) => f.plataforma)).toEqual(["meta_ads", "google_ads"]);
  });
});

describe("ler todas as fontes", () => {
  const conectada = (plataforma: "meta_ads" | "google_ads", gasto_cents: number): FonteDeGasto => ({
    plataforma,
    lerGasto: async () => ({ estado: "conectada", plataforma, gasto_cents, moeda: "BRL" }),
  });

  it("uma fonte que LANÇA vira indisponível e não derruba as outras", async () => {
    const quebrada: FonteDeGasto = {
      plataforma: "google_ads",
      lerGasto: async () => {
        throw new Error("rede caiu com token-secreto");
      },
    };
    const r = await lerGastoDasFontes([conectada("meta_ads", 100), quebrada], pedido);
    expect(r).toEqual([
      { estado: "conectada", plataforma: "meta_ads", gasto_cents: 100, moeda: "BRL" },
      { estado: "indisponivel", plataforma: "google_ads", motivo: "transitorio" },
    ]);
    expect(JSON.stringify(r)).not.toContain("token-secreto");
  });
});

describe("gasto, ROAS e custo por venda", () => {
  const meta = (gasto: number): LeituraDeGasto => ({ estado: "conectada", plataforma: "meta_ads", gasto_cents: gasto, moeda: "BRL" });
  const google: LeituraDeGasto = { estado: "nao_conectada", plataforma: "google_ads" };

  it("⭐ Meta conectado + Google não conectado: os cartões aparecem com o gasto do Meta", () => {
    const r = resumirAnuncios([meta(20_000), google], { total_cents: 50_000, vendas: 4 });
    expect(r.visivel).toBe(true);
    expect(r.gasto_cents).toBe(20_000);
    expect(r.roas).toBe(2.5);
    expect(r.custo_por_venda_cents).toBe(5_000);
    expect(r.fontes_lidas).toBe(1);
  });

  it("⭐ nenhuma fonte conectada: os cartões SOMEM", () => {
    const r = resumirAnuncios([{ estado: "nao_conectada", plataforma: "meta_ads" }, google], { total_cents: 50_000, vendas: 4 });
    expect(r.visivel).toBe(false);
    expect(r.gasto_cents).toBeNull();
    expect(r.roas).toBeNull();
    expect(r.custo_por_venda_cents).toBeNull();
  });

  it("duas plataformas conectadas: o gasto é a soma", () => {
    const r = resumirAnuncios([meta(10_000), { estado: "conectada", plataforma: "google_ads", gasto_cents: 5_000, moeda: "BRL" }], { total_cents: 30_000, vendas: 3 });
    expect(r.gasto_cents).toBe(15_000);
    expect(r.roas).toBe(2);
    expect(r.custo_por_venda_cents).toBe(5_000);
  });

  it("conectado mas fora do ar: cartões ficam (com traço), sem inventar número", () => {
    const r = resumirAnuncios([{ estado: "indisponivel", plataforma: "meta_ads", motivo: "transitorio" }, google], { total_cents: 50_000, vendas: 4 });
    expect(r.visivel).toBe(true);
    expect(r.gasto_cents).toBeNull();
    expect(r.roas).toBeNull();
  });

  it("sem gasto não há ROAS; sem venda não há custo por venda", () => {
    expect(resumirAnuncios([meta(0), google], { total_cents: 9_000, vendas: 2 })).toMatchObject({ gasto_cents: 0, roas: null, custo_por_venda_cents: 0 });
    expect(resumirAnuncios([meta(5_000), google], { total_cents: 0, vendas: 0 })).toMatchObject({ roas: 0, custo_por_venda_cents: null });
  });

  it("ROAS com duas casas", () => {
    expect(resumirAnuncios([meta(30_000), google], { total_cents: 100_000, vendas: 1 }).roas).toBe(3.33);
  });
});
