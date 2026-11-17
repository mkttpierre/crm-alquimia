import { describe, expect, it } from "vitest";

import { lerRitmo, RITMO_PADRAO, ritmoSchema } from "./config";
import { aplicarPerfil, PERFIS, PERFIS_DE_RITMO, perfilDoRitmo } from "./perfis";

describe("perfis de ritmo (conservador, recomendado, acelerado)", () => {
  it("cada perfil passa no ritmoSchema, sozinho e aplicado sobre o padrão", () => {
    for (const p of PERFIS) {
      expect(ritmoSchema.safeParse(PERFIS_DE_RITMO[p]).success).toBe(true);
      expect(ritmoSchema.safeParse({ ...RITMO_PADRAO, ...PERFIS_DE_RITMO[p] }).success).toBe(true);
    }
  });

  it("os valores combinados com o dono", () => {
    expect(PERFIS_DE_RITMO.conservador).toEqual({
      rampa: [6, 8, 10, 12, 14, 16, 18, 20, 22, 24],
      intervaloNova: { min: 15, max: 25 },
      intervaloNovaMaduro: { min: 12, max: 20 },
      intervaloNovaPisoMin: 15,
      pausa: { min: 25, max: 45 },
      pausaACada: { min: 4, max: 6 },
      maxAberturasHora: 4,
      maxEnviosHora: 8,
    });
    expect(PERFIS_DE_RITMO.acelerado).toEqual({
      rampa: [14, 17, 20, 24, 28, 32, 36, 40],
      intervaloNova: { min: 8, max: 12 },
      intervaloNovaMaduro: { min: 8, max: 10 },
      intervaloNovaPisoMin: 8,
      pausa: { min: 15, max: 30 },
      pausaACada: { min: 7, max: 12 },
      maxAberturasHora: 8,
      maxEnviosHora: 16,
    });
    const r = PERFIS_DE_RITMO.recomendado;
    expect(r).toEqual({
      rampa: RITMO_PADRAO.rampa,
      intervaloNova: RITMO_PADRAO.intervaloNova,
      intervaloNovaMaduro: RITMO_PADRAO.intervaloNovaMaduro,
      intervaloNovaPisoMin: RITMO_PADRAO.intervaloNovaPisoMin,
      pausa: RITMO_PADRAO.pausa,
      pausaACada: RITMO_PADRAO.pausaACada,
      maxAberturasHora: RITMO_PADRAO.maxAberturasHora,
      maxEnviosHora: RITMO_PADRAO.maxEnviosHora,
    });
  });

  it("RITMO_PADRAO é 'recomendado'", () => {
    expect(perfilDoRitmo(RITMO_PADRAO)).toBe("recomendado");
  });

  it("reconhece cada perfil e devolve 'personalizado' ao mudar um campo", () => {
    for (const p of PERFIS) {
      const ritmo = lerRitmo({ ...PERFIS_DE_RITMO[p] });
      expect(perfilDoRitmo(ritmo)).toBe(p);
      expect(perfilDoRitmo({ ...ritmo, maxEnviosHora: ritmo.maxEnviosHora + 1 })).toBe("personalizado");
      expect(perfilDoRitmo({ ...ritmo, rampa: [...ritmo.rampa, 50] })).toBe("personalizado");
    }
  });

  it("campos fora do perfil não mudam o reconhecimento (compara só o que os perfis definem)", () => {
    expect(perfilDoRitmo({ ...RITMO_PADRAO, feriados: [], fatorTotal: 3 })).toBe("recomendado");
  });

  it("aplicar = mescla parcial no ritmo gravado, validada; o resto do gravado fica", () => {
    const gravado = { feriados: ["2026-12-24"], janela: { domingo: [] }, maxEnviosHora: 30 };
    const novo = aplicarPerfil(gravado, "conservador");
    expect(novo).toMatchObject({ feriados: ["2026-12-24"], janela: { domingo: [] }, maxEnviosHora: 8, intervaloNovaPisoMin: 15 });
    expect(perfilDoRitmo(lerRitmo(novo))).toBe("conservador");
    // Gravado já inválido: aplicar não cobre o defeito, devolve null.
    expect(aplicarPerfil({ intervaloInicioRampa: [{ min: 40, max: 20 }] }, "acelerado")).toBeNull();
  });
});
