import { describe, expect, it } from "vitest";

import { lerRitmo, RITMO_PADRAO, type Ritmo } from "@/lib/disparo/config";
import { MIN, relogio } from "@/lib/disparo/ritmo";

import { simularDia } from "./simular-dia";

/** Terça-feira comum (17/11/2026), 6h em São Paulo: antes da janela abrir. */
const TERCA = new Date("2026-11-17T09:00:00Z");
const DOMINGO = new Date("2026-11-22T12:00:00Z");
const FERIADO = new Date("2026-11-20T12:00:00Z"); // Consciência Negra, na lista de feriados nacionais

const minutoLocal = (d: Date, r: Ritmo) => relogio(d, r.fusoMinutos).minuto;

describe("simularDia: o dia do motor, sem enviar nada", () => {
  it("respeita a janela: todo envio cai dentro de um bloco do dia", () => {
    const ritmo = lerRitmo({ janela: { semana: [{ inicio: 9 * 60, fim: 12 * 60 }, { inicio: 14 * 60, fim: 18 * 60 }] } });
    const s = simularDia(ritmo, [{ nome: "a", diaRampa: 11 }], TERCA, 7);
    expect(s.totalNovas).toBeGreaterThan(0);
    for (const e of s.porChip[0]!.envios) {
      const m = minutoLocal(e, ritmo);
      expect((m >= 540 && m < 720) || (m >= 840 && m < 1080)).toBe(true);
    }
    expect(s.primeira).toEqual(s.porChip[0]!.envios[0]);
    expect(s.ultima).toEqual(s.porChip[0]!.envios.at(-1));
  });

  it("domingo sem bloco, feriado e dia sem janela: vazio", () => {
    const semDomingo = lerRitmo({ janela: { domingo: [] } });
    expect(simularDia(semDomingo, [{ nome: "a", diaRampa: 5 }], DOMINGO, 1).totalNovas).toBe(0);
    expect(simularDia(RITMO_PADRAO, [{ nome: "a", diaRampa: 5 }], FERIADO, 1).totalNovas).toBe(0);
    const semSemana = lerRitmo({ janela: { semana: [] } });
    const vazio = simularDia(semSemana, [{ nome: "a", diaRampa: 5 }], TERCA, 1);
    expect(vazio).toMatchObject({ totalNovas: 0, primeira: null, ultima: null, pausasLongas: 0 });
    expect(vazio.porChip[0]!.envios).toEqual([]);
  });

  it("teto de aberturas pela rampa do chip (inclusive rampa própria)", () => {
    const ritmo = lerRitmo({ rampasPorChip: { frio: [2, 3] } });
    const s = simularDia(ritmo, [{ nome: "dia1", diaRampa: 1 }, { nome: "dia4", diaRampa: 4 }, { nome: "frio", diaRampa: 1 }], TERCA, 3);
    const [dia1, dia4, frio] = s.porChip;
    expect(dia1!.envios.length).toBeLessThanOrEqual(10);
    expect(dia4!.envios).toHaveLength(17); // 11 h de janela cabem as 17 do dia 4
    expect(frio!.envios).toHaveLength(2);
    expect(s.totalNovas).toBe(dia1!.envios.length + 17 + 2);
  });

  it("intervalo entre novas nunca abaixo do piso; nunca mais aberturas por hora que o máximo", () => {
    for (const semente of [1, 2, 3, 42, 999]) {
      const s = simularDia(RITMO_PADRAO, [{ nome: "a", diaRampa: 11 }, { nome: "b", diaRampa: 20, maduro: true }], TERCA, semente);
      for (const c of s.porChip) {
        c.envios.forEach((e, i) => {
          if (i > 0) expect(e.getTime() - c.envios[i - 1]!.getTime()).toBeGreaterThanOrEqual(RITMO_PADRAO.intervaloNovaPisoMin * MIN);
          const naHora = c.envios.filter((x) => x.getTime() <= e.getTime() && x.getTime() > e.getTime() - 60 * MIN);
          expect(naHora.length).toBeLessThanOrEqual(RITMO_PADRAO.maxAberturasHora);
        });
      }
    }
  });

  it("pausas longas contadas e dentro da faixa do ritmo", () => {
    const s = simularDia(RITMO_PADRAO, [{ nome: "a", diaRampa: 6 }], TERCA, 11);
    const pausas = s.porChip[0]!.pausas;
    expect(s.pausasLongas).toBe(pausas.length);
    expect(pausas.length).toBeGreaterThan(0);
    for (const p of pausas) {
      const min = (p.fim.getTime() - p.inicio.getTime()) / MIN;
      expect(min).toBeGreaterThanOrEqual(RITMO_PADRAO.pausa.min);
      expect(min).toBeLessThanOrEqual(RITMO_PADRAO.pausa.max);
    }
  });

  it("mesma semente, mesmo resultado; outra semente, outro dia", () => {
    const chips = [{ nome: "a", diaRampa: 8 }];
    const a = simularDia(RITMO_PADRAO, chips, TERCA, 123);
    expect(simularDia(RITMO_PADRAO, chips, TERCA, 123)).toEqual(a);
    expect(simularDia(RITMO_PADRAO, chips, TERCA, 124)).not.toEqual(a);
  });

  it("chip parado não manda nada e diz por quê (pausado, desligado, vermelho, em pausa)", () => {
    const s = simularDia(
      RITMO_PADRAO,
      [
        { nome: "pausado", diaRampa: 5, estado: "pausado" },
        { nome: "desligado", diaRampa: 5, estado: "desligado" },
        { nome: "vermelho", diaRampa: 5, saude: "vermelho" },
        { nome: "em pausa", diaRampa: 5, pausadoAte: new Date(TERCA.getTime() + 3 * 60 * MIN) },
        { nome: "pausa vencida", diaRampa: 5, pausadoAte: new Date(TERCA.getTime() - MIN) },
      ],
      TERCA,
      5,
    );
    const porNome = Object.fromEntries(s.porChip.map((c) => [c.nome, c]));
    expect(porNome.pausado).toMatchObject({ envios: [], parado: "chip pausado" });
    expect(porNome.desligado).toMatchObject({ envios: [], parado: "chip desligado" });
    expect(porNome.vermelho).toMatchObject({ envios: [], parado: "saúde vermelha: parado" });
    expect(porNome["em pausa"]).toMatchObject({ envios: [], parado: "chip em pausa" });
    expect(porNome["pausa vencida"]!.parado).toBeNull();
    expect(porNome["pausa vencida"]!.envios.length).toBeGreaterThan(0);
    expect(s.totalNovas).toBe(porNome["pausa vencida"]!.envios.length);
  });

  it("chip em rampa que ainda não abriu o dia simula com o degrau que o motor vai usar hoje", () => {
    const ontem = new Date(TERCA.getTime() - 24 * 60 * MIN);
    const hojeCedo = new Date(TERCA.getTime() + 60 * MIN);
    const s = simularDia(
      RITMO_PADRAO,
      [
        { nome: "sobe", diaRampa: 3, estado: "rampa", proximoEnvioEm: ontem, mandouRecente: true },
        { nome: "sem envio recente", diaRampa: 3, estado: "rampa", proximoEnvioEm: ontem, mandouRecente: false },
        { nome: "ja abriu", diaRampa: 3, estado: "rampa", proximoEnvioEm: hojeCedo, mandouRecente: true },
        { nome: "ativo", diaRampa: 3, estado: "ativo", proximoEnvioEm: ontem, mandouRecente: true },
        { nome: "amarelo", diaRampa: 3, estado: "rampa", saude: "amarelo", proximoEnvioEm: ontem, mandouRecente: true },
      ],
      TERCA,
      9,
    );
    const porNome = Object.fromEntries(s.porChip.map((c) => [c.nome, c]));
    expect(porNome.sobe).toMatchObject({ diaRampa: 4 });
    expect(porNome.sobe!.envios).toHaveLength(17); // rampa do dia 4
    for (const nome of ["sem envio recente", "ja abriu", "ativo", "amarelo"]) {
      expect(porNome[nome]!.diaRampa, nome).toBe(3);
      expect(porNome[nome]!.envios, nome).toHaveLength(14); // rampa do dia 3
    }
  });
});
