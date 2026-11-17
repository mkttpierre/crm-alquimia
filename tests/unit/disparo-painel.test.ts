import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { edicaoDaConfigSchema, papelNecessario } from "@/lib/disparo-painel/esquemas";
import { horaParaMinutos, mesclarRitmo, minutosParaHora, montarEstado } from "@/lib/disparo-painel/estado";

/**
 * A tela do motor (`/app/disparo`) edita o motor inteiro, mas não vira o envio real sozinha:
 * `modo` só com papel admin, a segunda chave (`DISPARO_REAL_LIBERADO`) fica fora de qualquer rota, e a
 * organização nunca vem do corpo. Os casos da edição completa moram em `lib/disparo-painel/edicao-completa.test.ts`.
 */

const SEGUNDA_10H = new Date("2026-10-12T13:00:00Z"); // 10h em São Paulo, feriado nacional
const TERCA_10H = new Date("2026-10-13T13:00:00Z"); // 10h em São Paulo, dia útil
const DOMINGO_15H = new Date("2026-10-18T18:00:00Z"); // 15h em São Paulo, fora da janela de domingo

const linha = (modo: string, extra: Record<string, unknown> = {}) => ({
  ligado: true,
  modo,
  teto_diario: null,
  cadencia: "reativacao_3_toques",
  ritmo: {},
  atendimento: {},
  ...extra,
});

describe("edição da config: a tela não vira o motor para real sozinha", () => {
  it("`modo` é aceito no corpo só como simulado ou real, e só o admin o aplica", () => {
    expect(edicaoDaConfigSchema.safeParse({ modo: "real" }).success).toBe(true);
    expect(edicaoDaConfigSchema.safeParse({ modo: "ligado" }).success).toBe(false);
    expect(papelNecessario({ modo: "real" })).toBe("admin");
    expect(papelNecessario({ ligado: true })).toBe("manager");
  });

  it("recusa organization_id (a organização vem da sessão) e cadência que não existe", () => {
    expect(edicaoDaConfigSchema.safeParse({ organization_id: "x", ligado: false }).success).toBe(false);
    expect(edicaoDaConfigSchema.safeParse({ cadencia: "nao_existe" }).success).toBe(false);
  });

  it("recusa chave desconhecida dentro do ritmo", () => {
    expect(edicaoDaConfigSchema.safeParse({ ritmo: { naoExiste: [] } }).success).toBe(false);
    expect(edicaoDaConfigSchema.safeParse({ ritmo: { janela: { semana: [], feriado: [] } } }).success).toBe(false);
  });

  it("recusa corpo vazio", () => {
    expect(edicaoDaConfigSchema.safeParse({}).success).toBe(false);
  });

  it("aceita pausa, teto (inclusive null) e ritmo básico", () => {
    expect(edicaoDaConfigSchema.safeParse({ ligado: false }).success).toBe(true);
    expect(edicaoDaConfigSchema.safeParse({ teto_diario: null }).success).toBe(true);
    expect(
      edicaoDaConfigSchema.safeParse({
        teto_diario: 12,
        ritmo: {
          janela: { sabado: [{ inicio: 480, fim: 720 }] },
          intervaloNova: { min: 12, max: 20 },
          maxAberturasHora: 5,
        },
      }).success,
    ).toBe(true);
  });

  it("recusa faixa com máximo menor que o mínimo e bloco com fim antes do início", () => {
    expect(edicaoDaConfigSchema.safeParse({ ritmo: { pausa: { min: 30, max: 20 } } }).success).toBe(false);
    expect(edicaoDaConfigSchema.safeParse({ ritmo: { janela: { semana: [{ inicio: 600, fim: 500 }] } } }).success).toBe(false);
  });

  it("a rota exige admin para o modo e nunca toca em DISPARO_REAL_LIBERADO", () => {
    const raiz = join(__dirname, "..", "..");
    const semComentario = (txt: string) =>
      txt.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    const codigo = semComentario(readFileSync(join(raiz, "app/api/v1/disparo/config/route.ts"), "utf8"));
    // A edição (papel do modo, gravação, auditoria) mora em operacoes.ts, a MESMA que o MCP usa.
    const operacoes = semComentario(readFileSync(join(raiz, "lib/disparo-painel/operacoes.ts"), "utf8"));
    expect(codigo).not.toMatch(/DISPARO_REAL_LIBERADO/);
    expect(operacoes).not.toMatch(/process\.env\.DISPARO_REAL_LIBERADO|DISPARO_REAL_LIBERADO\s*=/);
    // Na TELA, o modo passa por requireRole("admin") (authz.denied, mensagem e MFA), antes de qualquer leitura.
    expect(codigo).toMatch(/papelNecessario\(edicao\.data\) === "admin"/);
    expect(codigo).toMatch(/requireRole\("admin"/);
    // O MCP (sem requireRole) cai na mesma regra dentro de operacoes.ts, pelo papel do token.
    expect(operacoes).toMatch(/ROLE_RANK\[papel\] < ROLE_RANK\[papelNecessario\(edicao\)\]/);
    // O papel que a rota passa é o da sessão validada, e a organização também — nunca do corpo.
    expect(codigo).toMatch(/papel: org\.role/);
    expect(codigo).toMatch(/orgId: org\.orgId/);
    expect(operacoes).toMatch(/\.eq\("organization_id", orgId\)/);
    expect(codigo).toMatch(/requireRole\("manager"/);
    // O único `modo` que a rota escreve por conta própria é o da criação, e é `simulado`.
    expect(codigo.match(/\bmodo:\s*"[a-z]+"/g)?.filter((m) => !m.includes("simulado")) ?? []).toEqual([]);

    // A gaveta "Personalizar" edita só o ritmo: o modo é do card Modo, que só quem pode trocar usa.
    const gaveta = readFileSync(join(raiz, "app/app/disparo/_components/SegurancaDeEnvio.tsx"), "utf8");
    expect(gaveta).not.toMatch(/\bmodo:/);
    const card = readFileSync(join(raiz, "app/app/disparo/_components/ModoDoMotor.tsx"), "utf8");
    expect(card).toMatch(/podeTrocar/);
    expect(card).not.toMatch(/process\.env/);
  });
});

describe("estado do motor: a trava dupla à vista", () => {
  it("simulado na organização: simulado, com a explicação, qualquer que seja o servidor", () => {
    for (const ambiente of [{}, { DISPARO_REAL_LIBERADO: "sim" }]) {
      const e = montarEstado(linha("simulado"), TERCA_10H, ambiente);
      expect(e.modo).toBe("simulado");
      expect(e.modo_efetivo).toBe("simulado");
      expect(e.chave_da_organizacao).toBe(false);
      expect(e.motivo_simulado).toBe("modo simulado na organização");
    }
  });

  it("real na organização mas servidor fechado: continua simulado", () => {
    const e = montarEstado(linha("real"), TERCA_10H, {});
    expect(e.modo).toBe("real");
    expect(e.modo_efetivo).toBe("simulado");
    expect(e.chave_da_organizacao).toBe(true);
    expect(e.chave_do_servidor).toBe(false);
  });

  it("só `sim` exato abre a segunda chave (nada de `true`, `1` ou espaço)", () => {
    for (const v of ["true", "1", "SIM", " sim", ""]) {
      expect(montarEstado(linha("real"), TERCA_10H, { DISPARO_REAL_LIBERADO: v }).modo_efetivo).toBe("simulado");
    }
    const aberto = montarEstado(linha("real"), TERCA_10H, { DISPARO_REAL_LIBERADO: "sim" });
    expect(aberto.modo_efetivo).toBe("real");
    expect(aberto.chave_do_servidor).toBe(true);
  });

  it("o estado carrega só booleanos da trava, nunca o valor da variável", () => {
    const e = montarEstado(linha("real"), TERCA_10H, { DISPARO_REAL_LIBERADO: "sim", OUTRA_COISA: "segredo" });
    expect(JSON.stringify(e)).not.toContain("segredo");
    expect(typeof e.chave_do_servidor).toBe("boolean");
  });

  it("modo desconhecido no banco cai em simulado (fail-closed)", () => {
    expect(montarEstado(linha("qualquer"), TERCA_10H, { DISPARO_REAL_LIBERADO: "sim" }).modo_efetivo).toBe("simulado");
  });

  it("janela de hoje: dia útil dentro, feriado sem janela, domingo à tarde fora", () => {
    const util = montarEstado(linha("simulado"), TERCA_10H, {});
    expect(util.hoje.janela).toEqual([{ inicio: 480, fim: 1140 }]);
    expect(util.hoje.dentro_da_janela).toBe(true);
    expect(util.hoje.feriado).toBe(false);

    const feriado = montarEstado(linha("simulado"), SEGUNDA_10H, {});
    expect(feriado.hoje.feriado).toBe(true);
    expect(feriado.hoje.janela).toEqual([]);
    expect(feriado.hoje.dentro_da_janela).toBe(false);

    const domingo = montarEstado(linha("simulado"), DOMINGO_15H, {});
    expect(domingo.hoje.dentro_da_janela).toBe(false);
  });

  it("ritmo vigente vem do jsonb com os padrões do motor por baixo", () => {
    const e = montarEstado(
      linha("simulado", { ritmo: { intervaloNova: { min: 19, max: 23 } }, teto_diario: 10 }),
      TERCA_10H,
      {},
    );
    expect(e.ritmo.intervalo_nova).toEqual({ min: 19, max: 23 });
    expect(e.ritmo.max_aberturas_hora).toBe(6);
    expect(e.teto_diario).toBe(10);
  });

  it("atendimento ligado só quando o jsonb tem conteúdo", () => {
    expect(montarEstado(linha("simulado"), TERCA_10H, {}).atendimento_ligado).toBe(false);
    expect(montarEstado(linha("simulado", { atendimento: { perfil: "venda" } }), TERCA_10H, {}).atendimento_ligado).toBe(true);
  });
});

describe("mesclarRitmo", () => {
  it("mescla no que está gravado sem apagar o resto do jsonb", () => {
    const gravado = { pausa: { min: 15, max: 30 }, rampa: [5, 7], janela: { semana: [{ inicio: 480, fim: 720 }] } };
    const novo = mesclarRitmo(gravado, { janela: { sabado: [{ inicio: 480, fim: 600 }] } });
    expect(novo).toMatchObject({
      rampa: [5, 7],
      pausa: { min: 15, max: 30 },
      janela: { semana: [{ inicio: 480, fim: 720 }], sabado: [{ inicio: 480, fim: 600 }] },
    });
  });

  it("aceita gravado vazio ou lixo e devolve só a edição", () => {
    expect(mesclarRitmo({}, { maxEnviosHora: 8 })).toEqual({ maxEnviosHora: 8 });
    expect(mesclarRitmo(null, { maxEnviosHora: 8 })).toEqual({ maxEnviosHora: 8 });
    expect(mesclarRitmo([1, 2], { maxEnviosHora: 8 })).toEqual({ maxEnviosHora: 8 });
  });

  it("recusa o que o motor não aceitaria (jsonb gravado inválido)", () => {
    expect(mesclarRitmo({ rampa: [] }, { maxEnviosHora: 8 })).toBeNull();
  });
});

describe("horário", () => {
  it("ida e volta entre HH:MM e minutos", () => {
    expect(minutosParaHora(480)).toBe("08:00");
    expect(minutosParaHora(1140)).toBe("19:00");
    expect(horaParaMinutos("08:30")).toBe(510);
    expect(horaParaMinutos("24:00")).toBe(1440);
    expect(horaParaMinutos("25:00")).toBeNull();
    expect(horaParaMinutos("8h")).toBeNull();
    expect(horaParaMinutos("")).toBeNull();
  });
});

describe("estado: terceira trava DISPARO_SO_PARA", () => {
  it("não definida: destinos_permitidos é null", () => {
    expect(montarEstado(linha("real"), TERCA_10H, {}).destinos_permitidos).toBeNull();
  });

  it("definida: só a contagem, nunca os números", () => {
    const e = montarEstado(linha("real"), TERCA_10H, { DISPARO_SO_PARA: "+5511999990000,+5521988887777" });
    expect(e.destinos_permitidos).toBe(2);
    expect(JSON.stringify(e)).not.toContain("999990000");
  });
});
