import { describe, expect, it } from "vitest";

import { META_MAXIMA_CENTS, calcularProgressoDaMeta, lerValorEmCents, metaMensalSchema } from "./meta-mensal";
import { duracaoLegivel } from "./duracao";
import {
  PERIODOS_DO_PAINEL,
  PERIODO_PADRAO_DO_PAINEL,
  diasDoMes,
  inicioDoDia,
  lerPeriodo,
  limitesDoPeriodo,
  periodoDeComparacao,
  primeiroDiaDoMes,
  resolverPeriodo,
  ultimoDiaDoMes,
} from "./periodos-do-painel";
import { periodoAnterior } from "./faturamento";

describe("períodos do painel", () => {
  const HOJE = "2026-11-16";

  it("⭐ as cinco opções resolvem para as datas certas", () => {
    expect(resolverPeriodo("hoje", HOJE)).toEqual({ chave: "hoje", desde: "2026-11-16", ate: "2026-11-16" });
    expect(resolverPeriodo("7d", HOJE)).toEqual({ chave: "7d", desde: "2026-11-10", ate: "2026-11-16" });
    expect(resolverPeriodo("mes", HOJE)).toEqual({ chave: "mes", desde: "2026-11-01", ate: "2026-11-16" });
    expect(resolverPeriodo("mes-passado", HOJE)).toEqual({ chave: "mes-passado", desde: "2026-10-01", ate: "2026-10-31" });
    expect(resolverPeriodo("90d", HOJE)).toEqual({ chave: "90d", desde: "2026-08-19", ate: "2026-11-16" });
  });

  it("o padrão é 'Este mês'", () => {
    expect(PERIODO_PADRAO_DO_PAINEL).toBe("mes");
    expect(lerPeriodo(undefined)).toBe("mes");
  });

  it("lerPeriodo fecha para o padrão: lixo, vazio, array e valor de outra tela", () => {
    expect(lerPeriodo("30d")).toBe("mes");
    expect(lerPeriodo("")).toBe("mes");
    expect(lerPeriodo("__proto__")).toBe("mes");
    expect(lerPeriodo(["7d", "90d"])).toBe("7d");
    for (const p of PERIODOS_DO_PAINEL) expect(lerPeriodo(p)).toBe(p);
  });

  it("'mês passado' em janeiro volta para dezembro do ano anterior", () => {
    expect(resolverPeriodo("mes-passado", "2027-01-05")).toEqual({ chave: "mes-passado", desde: "2026-12-01", ate: "2026-12-31" });
  });

  it("'mês passado' depois de um mês de 30 dias e em ano bissexto", () => {
    expect(resolverPeriodo("mes-passado", "2026-05-02")).toMatchObject({ desde: "2026-04-01", ate: "2026-04-30" });
    expect(resolverPeriodo("mes-passado", "2028-03-10")).toMatchObject({ desde: "2028-02-01", ate: "2028-02-29" });
  });

  it("o período anterior é o de mesmo tamanho na véspera (a régua do Faturamento)", () => {
    expect(periodoAnterior("2026-11-01", "2026-11-16")).toEqual({ desde: "2026-10-16", ate: "2026-10-31" });
    expect(periodoAnterior("2026-11-16", "2026-11-16")).toEqual({ desde: "2026-11-15", ate: "2026-11-15" });
  });

  it("calendário: dias do mês e extremos", () => {
    expect(diasDoMes("2026-02-10")).toBe(28);
    expect(diasDoMes("2028-02-10")).toBe(29);
    expect(diasDoMes("2026-12-31")).toBe(31);
    expect(primeiroDiaDoMes("2026-11-16")).toBe("2026-11-01");
    expect(ultimoDiaDoMes("2026-11-16")).toBe("2026-11-30");
  });
});

describe("com que período cada opção se compara", () => {
  const HOJE = "2026-11-16";
  const cmp = (chave: Parameters<typeof resolverPeriodo>[0], hoje = HOJE) => periodoDeComparacao(resolverPeriodo(chave, hoje));

  it("⭐ 'Este mês' compara com os MESMOS dias do mês anterior (01–16/11 contra 01–16/10)", () => {
    expect(cmp("mes")).toEqual({ desde: "2026-10-01", ate: "2026-10-16" });
  });

  it("'Este mês' corta no último dia do mês anterior quando ele é mais curto", () => {
    expect(cmp("mes", "2026-03-31")).toEqual({ desde: "2026-02-01", ate: "2026-02-28" });
    expect(cmp("mes", "2026-03-30")).toEqual({ desde: "2026-02-01", ate: "2026-02-28" });
    expect(cmp("mes", "2028-03-30")).toEqual({ desde: "2028-02-01", ate: "2028-02-29" });
    expect(cmp("mes", "2026-05-31")).toEqual({ desde: "2026-04-01", ate: "2026-04-30" });
  });

  it("'Este mês' no primeiro dia compara com o primeiro dia do mês anterior; em janeiro volta para dezembro", () => {
    expect(cmp("mes", "2026-11-01")).toEqual({ desde: "2026-10-01", ate: "2026-10-01" });
    expect(cmp("mes", "2027-01-16")).toEqual({ desde: "2026-12-01", ate: "2026-12-16" });
  });

  it("⭐ 'Mês passado' compara com o mês retrasado INTEIRO", () => {
    expect(cmp("mes-passado")).toEqual({ desde: "2026-09-01", ate: "2026-09-30" });
    expect(cmp("mes-passado", "2027-01-05")).toEqual({ desde: "2026-11-01", ate: "2026-11-30" });
    expect(cmp("mes-passado", "2028-03-10")).toEqual({ desde: "2028-01-01", ate: "2028-01-31" });
  });

  it("Hoje, 7 dias e 90 dias seguem com o período anterior de mesmo tamanho (a régua do Faturamento)", () => {
    for (const chave of ["hoje", "7d", "90d"] as const) {
      const p = resolverPeriodo(chave, HOJE);
      expect(periodoDeComparacao(p)).toEqual(periodoAnterior(p.desde, p.ate));
    }
    expect(cmp("hoje")).toEqual({ desde: "2026-11-15", ate: "2026-11-15" });
  });
});

describe("instantes de início de dia no fuso (para contar leads por data de criação)", () => {
  it("São Paulo é UTC−3: o dia 16 começa às 03:00Z", () => {
    expect(inicioDoDia("2026-11-16", "America/Sao_Paulo")).toBe("2026-11-16T03:00:00.000Z");
  });

  it("fuso com horário de verão: Nova York muda de −4 para −5 na virada de novembro", () => {
    expect(inicioDoDia("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z");
    expect(inicioDoDia("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00.000Z");
  });

  it("fuso inválido cai no de São Paulo em vez de lançar", () => {
    expect(inicioDoDia("2026-11-16", "Marte/Olympus")).toBe("2026-11-16T03:00:00.000Z");
  });

  it("limites do período: de meia-noite do primeiro dia até meia-noite do dia seguinte ao último (fim exclusivo)", () => {
    expect(limitesDoPeriodo("2026-11-01", "2026-11-16", "America/Sao_Paulo")).toEqual({
      de: "2026-11-01T03:00:00.000Z",
      ate: "2026-11-17T03:00:00.000Z",
    });
  });
});

describe("progresso da meta: quanto falta e o ritmo por dia", () => {
  it("⭐ a meio do mês: falta, ritmo necessário, ritmo atual e projeção", () => {
    // 16 de novembro (30 dias): 15 dias restantes, hoje incluído. 40% da meta.
    const m = calcularProgressoDaMeta({ metaCents: 1_000_000, realizadoCents: 400_000, hoje: "2026-11-16" });
    expect(m).toMatchObject({
      percentual: 40,
      falta_cents: 600_000,
      atingida: false,
      dias_restantes: 15,
      dias_no_mes: 30,
      ritmo_necessario_cents: 40_000, // 600.000 / 15
      ritmo_atual_cents: 25_000, // 400.000 / 16
      projecao_cents: 750_000, // 25.000 × 30
      no_ritmo: false,
    });
  });

  it("no ritmo: a projeção alcança a meta", () => {
    const m = calcularProgressoDaMeta({ metaCents: 600_000, realizadoCents: 400_000, hoje: "2026-11-16" });
    expect(m?.no_ritmo).toBe(true);
  });

  it("meta batida: falta zero, ritmo necessário zero, percentual passa de 100", () => {
    const m = calcularProgressoDaMeta({ metaCents: 100_000, realizadoCents: 150_000, hoje: "2026-11-10" });
    expect(m).toMatchObject({ atingida: true, falta_cents: 0, ritmo_necessario_cents: 0, percentual: 150 });
  });

  it("último dia do mês: um dia restante, e o ritmo necessário é tudo o que falta", () => {
    const m = calcularProgressoDaMeta({ metaCents: 1_000_000, realizadoCents: 900_000, hoje: "2026-11-30" });
    expect(m).toMatchObject({ dias_restantes: 1, ritmo_necessario_cents: 100_000 });
  });

  it("primeiro dia: o mês inteiro pela frente, sem divisão por zero", () => {
    const m = calcularProgressoDaMeta({ metaCents: 3_000_000, realizadoCents: 0, hoje: "2026-11-01" });
    expect(m).toMatchObject({ dias_restantes: 30, ritmo_necessario_cents: 100_000, ritmo_atual_cents: 0, projecao_cents: 0, percentual: 0 });
  });

  it("fevereiro bissexto tem 29 dias", () => {
    expect(calcularProgressoDaMeta({ metaCents: 1_000, realizadoCents: 0, hoje: "2028-02-10" })?.dias_no_mes).toBe(29);
  });

  it("sem meta, ou com meta inválida, não há progresso", () => {
    expect(calcularProgressoDaMeta({ metaCents: null, realizadoCents: 5, hoje: "2026-11-16" })).toBeNull();
    expect(calcularProgressoDaMeta({ metaCents: 0, realizadoCents: 5, hoje: "2026-11-16" })).toBeNull();
    expect(calcularProgressoDaMeta({ metaCents: -10, realizadoCents: 5, hoje: "2026-11-16" })).toBeNull();
  });
});

describe("o que o admin digita vira centavos", () => {
  it.each([
    ["50000", 5_000_000],
    ["50.000", 5_000_000],
    ["50.000,00", 5_000_000],
    ["50.000,5", 5_000_050],
    ["50,000.50", 5_000_050],
    ["1.234.567,89", 123_456_789],
    ["10,5", 1_050],
    ["10.50", 1_050],
    ["R$ 2.000,00", 200_000],
    ["  7  ", 700],
  ])("%s → %i centavos", (texto, cents) => {
    expect(lerValorEmCents(texto)).toEqual({ ok: true, cents });
  });

  it("vazio apaga a meta", () => {
    expect(lerValorEmCents("")).toEqual({ ok: true, cents: null });
    expect(lerValorEmCents("   ")).toEqual({ ok: true, cents: null });
  });

  it.each(["abc", "-5", "0", "0,00", "1,2,3x", "10,5555", "1e5", "1.5.5,555", ",5"])("recusa %s", (texto) => {
    expect(lerValorEmCents(texto)).toEqual({ ok: false });
  });

  it("recusa acima do teto do banco", () => {
    expect(lerValorEmCents("999999999999999")).toEqual({ ok: false });
    expect(lerValorEmCents(String(META_MAXIMA_CENTS / 100))).toEqual({ ok: true, cents: META_MAXIMA_CENTS });
  });
});

describe("o schema da Server Action da meta", () => {
  it("aceita centavos inteiros positivos e null (apagar)", () => {
    expect(metaMensalSchema.safeParse({ metaCents: 5_000_000 }).success).toBe(true);
    expect(metaMensalSchema.safeParse({ metaCents: null }).success).toBe(true);
  });

  it("recusa zero, negativo, fracionário, texto, acima do teto, ausente e campo extra", () => {
    for (const ruim of [{ metaCents: 0 }, { metaCents: -1 }, { metaCents: 1.5 }, { metaCents: "100" }, { metaCents: META_MAXIMA_CENTS + 1 }, {}, { metaCents: 100, organization_id: "x" }, { metaCents: 100, p_actor: "x" }]) {
      expect(metaMensalSchema.safeParse(ruim).success).toBe(false);
    }
  });
});

describe("duração legível", () => {
  const h = 3_600_000;
  it("menos de uma hora, horas até 2 dias, dias depois", () => {
    expect(duracaoLegivel(10 * 60_000)).toEqual({ tipo: "menos_de_uma_hora" });
    expect(duracaoLegivel(18 * h)).toEqual({ tipo: "horas", valor: 18 });
    expect(duracaoLegivel(47.96 * h)).toEqual({ tipo: "horas", valor: 48 });
    expect(duracaoLegivel(72 * h)).toEqual({ tipo: "dias", valor: 3 });
    expect(duracaoLegivel(Number.NaN)).toEqual({ tipo: "menos_de_uma_hora" });
  });
});
