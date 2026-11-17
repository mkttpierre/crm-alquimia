import { afterEach, describe, expect, it, vi } from "vitest";

import { lerRitmo, RITMO_PADRAO } from "@/lib/disparo/config";
import { pausaPorChipMudoLigada } from "@/lib/disparo/sem-confirmacao";
import { lerConfigTrava, TRAVA_PADRAO } from "@/lib/disparo/trava-nao-entregue";

import { edicaoDaConfigSchema, papelNecessario } from "./esquemas";
import { diferencasDaConfig, mesclarRitmo } from "./estado";

/**
 * Motor configurável pela tela: o corpo do PATCH aceita o motor INTEIRO — qualquer campo do
 * ritmo, cadência, etapa de origem, mensagens, proibidos e modo —, sem deixar passar o que o motor não
 * aceitaria e sem nunca aceitar a organização do corpo.
 */

const valida = (corpo: unknown) => edicaoDaConfigSchema.safeParse(corpo).success;
const ETAPA = "77777777-7777-4777-8777-777777777777";

describe("edição completa do motor", () => {
  it("aceita_ritmo_parcial_e_valida_no_merge", () => {
    const parcial = {
      saude: { ligado: false },
      quarentena: { dias: 60 },
      feriados: ["2026-12-24"],
      rampa: [5, 8, 10],
      naoEntregue: { ligado: false },
      chipMudo: { pausa: true },
    };
    const r = edicaoDaConfigSchema.safeParse({ ritmo: parcial });
    expect(r.success).toBe(true);
    // O que não veio no corpo não ganha valor padrão: senão o PATCH apagaria o que está gravado.
    expect(r.data?.ritmo).toEqual(parcial);

    // A mescla é por seção: o que está gravado na seção e não veio na edição continua.
    const gravado = { intervaloNova: { min: 19, max: 23 }, saude: { horasSemEntrega: 8 } };
    expect(mesclarRitmo(gravado, { saude: { ligado: false } })).toEqual({
      intervaloNova: { min: 19, max: 23 },
      saude: { horasSemEntrega: 8, ligado: false },
    });
    // O conjunto mesclado passa de novo pelo `ritmoSchema`: um jsonb já quebrado não recebe mais nada por cima.
    expect(mesclarRitmo({ rampa: [] }, { maxAberturasHora: 5 })).toBeNull();
  });

  it("recusa_faixa_com_min_maior_que_max", () => {
    expect(valida({ ritmo: { intervaloNovaMaduro: { min: 20, max: 10 } } })).toBe(false);
    expect(valida({ ritmo: { pausaDomingo: { min: 30, max: 12 } } })).toBe(false);
    expect(valida({ ritmo: { intervaloInicioRampa: [{ min: 40, max: 20 }] } })).toBe(false);
    expect(valida({ ritmo: { intervaloNovaMaduro: { min: 10, max: 20 }, pausaDomingo: null } })).toBe(true);
  });

  it("recusa_rampa_vazia", () => {
    expect(valida({ ritmo: { rampa: [] } })).toBe(false);
    expect(valida({ ritmo: { rampasPorChip: { "chip-novo": [] } } })).toBe(false);
    expect(valida({ ritmo: { rampa: [10, 12, 14], diaMaduro: 3 } })).toBe(true);
  });

  it("recusa_bloco_com_fim_antes_do_inicio", () => {
    expect(valida({ ritmo: { janela: { domingo: [{ inicio: 600, fim: 500 }] } } })).toBe(false);
    expect(valida({ ritmo: { janela: { semana: [{ inicio: 480, fim: 1500 }] } } })).toBe(false);
    expect(valida({ ritmo: { janela: { domingo: [] } } })).toBe(true);
  });

  it("recusa_organization_id", () => {
    expect(valida({ organization_id: "22222222-2222-4222-8222-222222222222" })).toBe(false);
    expect(valida({ organization_id: "22222222-2222-4222-8222-222222222222", ligado: true })).toBe(false);
  });

  it("recusa_cadencia_desconhecida", () => {
    expect(valida({ cadencia: "nao_existe" })).toBe(false);
    expect(valida({ cadencia: "toString" })).toBe(false);
    expect(valida({ cadencia: "__proto__" })).toBe(false);
    expect(valida({ cadencia: "prospeccao_14_dias" })).toBe(true);
    expect(valida({ cadencia: "reativacao_3_toques" })).toBe(true);
  });

  it("modo_real_so_admin", () => {
    expect(valida({ modo: "real" })).toBe(true);
    expect(valida({ modo: "simulado" })).toBe(true);
    expect(valida({ modo: "producao" })).toBe(false);
    expect(papelNecessario({ modo: "real" })).toBe("admin");
    expect(papelNecessario({ modo: "simulado", ligado: true })).toBe("admin");
    expect(papelNecessario({ ritmo: { rampa: [5] }, modelos: { abertura: ["Oi"] }, fonte_stage_id: ETAPA })).toBe("manager");
    expect(papelNecessario({ perfil: "acelerado" })).toBe("manager");
  });

  it("perfil: só os três que existem", () => {
    expect(valida({ perfil: "conservador" })).toBe(true);
    expect(valida({ perfil: "recomendado", ritmo: { feriados: [] } })).toBe(true);
    expect(valida({ perfil: "turbo" })).toBe(false);
    expect(valida({ perfil: "personalizado" })).toBe(false);
  });

  it("recusa chave que o motor não conhece, no ritmo e dentro de uma seção", () => {
    expect(valida({ ritmo: { naoExiste: 1 } })).toBe(false);
    expect(valida({ ritmo: { saude: { naoExiste: 1 } } })).toBe(false);
    expect(valida({ ritmo: { saude: { bloqueio: { amarelo: 0.02, roxo: 1 } } } })).toBe(false);
    expect(valida({ ritmo: { janela: { semana: [], feriado: [] } } })).toBe(false);
    // Mapa livre (nome do chip, classe) não é chave desconhecida.
    expect(valida({ ritmo: { rampasPorChip: { "celular-a": [5, 8] }, limitePorClasseDia: { P3: 4 } } })).toBe(true);
  });

  it("mantém os limites da tela nos campos básicos", () => {
    expect(valida({ ritmo: { maxAberturasHora: 61 } })).toBe(false);
    expect(valida({ ritmo: { maxEnviosHora: 121 } })).toBe(false);
    expect(valida({ ritmo: { janela: { semana: Array(5).fill({ inicio: 480, fim: 600 }) } } })).toBe(false);
  });

  it("etapa de origem, mensagens e proibidos", () => {
    expect(valida({ fonte_stage_id: ETAPA })).toBe(true);
    expect(valida({ fonte_stage_id: null })).toBe(true);
    expect(valida({ fonte_stage_id: "etapa-1" })).toBe(false);
    expect(valida({ modelos: { abertura: ["Oi {nome}, tudo bem?", "Olá {nome}"], toque_2: [] } })).toBe(true);
    expect(valida({ modelos: { abertura: [123] } })).toBe(false);
    expect(valida({ proibidos: [{ padrao: "frete gr[aá]tis", motivo: "promessa de frete" }] })).toBe(true);
    expect(valida({ proibidos: [{ padrao: "(", motivo: "regex quebrada" }] })).toBe(false);
    expect(valida({ proibidos: [{ padrao: "", motivo: "vazio" }] })).toBe(false);
    // Ausentes ficam ausentes (nenhum default injetado).
    const r = edicaoDaConfigSchema.safeParse({ ligado: false });
    expect(r.data).toEqual({ ligado: false });
  });

  it("recusa corpo vazio", () => {
    expect(valida({})).toBe(false);
  });
});

describe("trava de não entregue e chip mudo viram campos do ritmo", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("o padrão do ritmo é o mesmo de antes: não entregue ligado, pausa por chip mudo desligada", () => {
    expect(RITMO_PADRAO.naoEntregue).toEqual(TRAVA_PADRAO);
    expect(RITMO_PADRAO.chipMudo).toEqual({ pausa: false });
  });

  it("sem a variável, vale o campo; com a variável, ela vence o banco", () => {
    vi.stubEnv("DISPARO_CHIP_MUDO_PAUSA", "");
    expect(pausaPorChipMudoLigada({ chipMudo: { pausa: true } })).toBe(true);
    expect(pausaPorChipMudoLigada({ chipMudo: { pausa: false } })).toBe(false);
    vi.stubEnv("DISPARO_CHIP_MUDO_PAUSA", "off");
    expect(pausaPorChipMudoLigada({ chipMudo: { pausa: true } })).toBe(false);
    vi.stubEnv("DISPARO_CHIP_MUDO_PAUSA", "on");
    expect(pausaPorChipMudoLigada({ chipMudo: { pausa: false } })).toBe(true);
  });
});

describe("correção R1: leitura tolerante dos blocos novos, edição estrita", () => {
  const antigo = {
    rampa: [5, 7, 9],
    janela: { semana: [{ inicio: 540, fim: 1020 }] },
    pausa: { min: 30, max: 50 },
    intervaloNova: { min: 12, max: 20 },
  };
  const preservado = (r: ReturnType<typeof lerRitmo>) => {
    expect(r.rampa).toEqual([5, 7, 9]);
    expect(r.janela.semana).toEqual([{ inicio: 540, fim: 1020 }]);
    expect(r.pausa).toEqual({ min: 30, max: 50 });
    expect(r.intervaloNova).toEqual({ min: 12, max: 20 });
  };

  it("naoEntregue com valor ruim: o resto do ritmo fica, e o bloco é lido como o worker o lê", () => {
    const ruins: unknown[] = [
      { horasMarcar: 0 },
      { horasMarcar: 500 },
      { janelaDias: 7.5 },
      { ligado: "false" },
      { horasMarcar: "24", horasRemover: Number.NaN },
      { horasMarcar: 36, horasRemover: 12 },
      null,
      "ligado",
      [],
    ];
    for (const ruim of ruins) {
      const r = lerRitmo({ ...antigo, naoEntregue: ruim });
      preservado(r);
      expect(r.naoEntregue).toEqual(lerConfigTrava(ruim));
    }
    expect(lerRitmo({ ...antigo, naoEntregue: { horasMarcar: 0 } }).naoEntregue).toEqual({ ...TRAVA_PADRAO, horasMarcar: 1 });
    expect(lerRitmo({ ...antigo, naoEntregue: { janelaDias: 7.5 } }).naoEntregue).toEqual({ ...TRAVA_PADRAO, janelaDias: 8 });
    expect(lerRitmo({ ...antigo, naoEntregue: { ligado: "false" } }).naoEntregue.ligado).toBe(true);
    expect(lerRitmo({ ...antigo, naoEntregue: null }).naoEntregue).toEqual(TRAVA_PADRAO);
    expect(lerRitmo({ ...antigo, naoEntregue: { ligado: false } }).naoEntregue).toEqual({ ...TRAVA_PADRAO, ligado: false });
  });

  it("chipMudo com valor ruim: só `true` liga, e o resto do ritmo fica", () => {
    for (const ruim of [{ pausa: "sim" }, { pausa: 1 }, null, "on", []]) {
      const r = lerRitmo({ ...antigo, chipMudo: ruim });
      preservado(r);
      expect(r.chipMudo).toEqual({ pausa: false });
    }
    expect(lerRitmo({ ...antigo, chipMudo: { pausa: true } }).chipMudo).toEqual({ pausa: true });
  });

  it("a edição pela tela é estrita nos dois blocos (422, não grampo silencioso)", () => {
    for (const ruim of [{ horasMarcar: 0 }, { horasMarcar: 500 }, { janelaDias: 7.5 }, { ligado: "false" }, { horasMarcar: 30, horasRemover: 20 }, { xyz: 1 }, null]) {
      expect(valida({ ritmo: { naoEntregue: ruim } }), JSON.stringify(ruim)).toBe(false);
    }
    expect(valida({ ritmo: { naoEntregue: { ligado: false, horasMarcar: 12, horasRemover: 36, janelaDias: 3 } } })).toBe(true);
    expect(valida({ ritmo: { chipMudo: { pausa: "sim" } } })).toBe(false);
    expect(valida({ ritmo: { chipMudo: null } })).toBe(false);
    expect(valida({ ritmo: { chipMudo: { pausa: true } } })).toBe(true);
  });

  it("proibidos: padrão de até 200 caracteres e sem quantificador aninhado", () => {
    const proibido = (padrao: string) => valida({ proibidos: [{ padrao, motivo: "teste" }] });
    expect(proibido("a".repeat(200))).toBe(true);
    expect(proibido("a".repeat(201))).toBe(false);
    for (const perigoso of ["(x+)+", "(a*)*", "(?:ab+){2,}", "(a{2,})*", "frete (gr[aá]tis+)+"]) {
      expect(proibido(perigoso), perigoso).toBe(false);
    }
    for (const ok of ["frete gr[aá]tis", "(oi|olá)", "pre(ç|c)o+", "(\\d+)", "\\(x+\\)+"]) {
      expect(proibido(ok), ok).toBe(true);
    }
  });

  it("modelos: a chave tem o formato de disparo_envios.tipo", () => {
    expect(valida({ modelos: { abertura: ["Oi"], "abertura:pele": ["Oi"], toque_2: [] } })).toBe(true);
    for (const tipo of ["Abertura", "a", "toque-2", "toque 2", "x".repeat(41), "aberturá"]) {
      expect(valida({ modelos: { [tipo]: ["Oi"] } }), tipo).toBe(false);
    }
  });
});

describe("mescla profunda nas seções (correção R1 das telas)", () => {
  it("mudar um subcampo de uma seção não apaga os irmãos, nem dentro de um objeto aninhado", () => {
    const gravado = { saude: { horasSemEntrega: 8, bloqueio: { amarelo: 0.03, vermelho: 0.06 } }, quarentena: { dias: 60 } };
    expect(mesclarRitmo(gravado, { saude: { bloqueio: { amarelo: 0.04 } } })).toEqual({
      saude: { horasSemEntrega: 8, bloqueio: { amarelo: 0.04, vermelho: 0.06 } },
      quarentena: { dias: 60 },
    });
    expect(mesclarRitmo(gravado, { quarentena: { ligado: false } })).toMatchObject({ quarentena: { dias: 60, ligado: false } });
  });

  it("mapas livres dentro das seções são trocados inteiros (dá para tirar uma chave)", () => {
    const gravado = { filtroAbertura: { porChipOrigem: true, camposIguais: { d1_pronto: "true", porta: "x" } }, lembretes: { tetoDia: { audio: 5, ligacao: 3 } } };
    const novo = mesclarRitmo(gravado, { filtroAbertura: { camposIguais: { d1_pronto: "true" } }, lembretes: { tetoDia: { audio: 4 } } });
    expect(novo).toEqual({ filtroAbertura: { porChipOrigem: true, camposIguais: { d1_pronto: "true" } }, lembretes: { tetoDia: { audio: 4 } } });
  });
});

describe("auditoria: antes e depois só do que mudou", () => {
  it("lista só os campos e as seções que mudaram de valor (ausente vira null)", () => {
    const antes = { ligado: true, cadencia: "reativacao_3_toques", ritmo: { rampa: [10, 12], saude: { ligado: true } }, modelos: { abertura: ["Oi"] } };
    const depois = { ligado: true, cadencia: "prospeccao_14_dias", ritmo: { rampa: [10, 12], saude: { ligado: false } }, modelos: { abertura: ["Oi"], toque_2: ["E aí?"] } };
    expect(diferencasDaConfig(antes, depois)).toEqual({
      antes: { cadencia: "reativacao_3_toques", ritmo: { saude: { ligado: true } }, modelos: { toque_2: null } },
      depois: { cadencia: "prospeccao_14_dias", ritmo: { saude: { ligado: false } }, modelos: { toque_2: ["E aí?"] } },
    });
    expect(diferencasDaConfig(antes, antes)).toEqual({ antes: {}, depois: {} });
  });
});
