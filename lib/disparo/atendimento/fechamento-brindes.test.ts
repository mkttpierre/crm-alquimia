// @vitest-environment node
/**
 * Brinde por plano na campanha "Campanha Exemplo": enquanto `fechamento.brindes.ate` não passou,
 * o pacote de fechamento abre dizendo se os dois brindes (12 meses) ou o brinde único (outros planos) estão separados.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { planejar } from "./agente";
import { CONFIG_VENDA_EXEMPLO } from "./apoio-de-teste";
import { atendimentoSchema } from "./config";

const DOZE = "Os dois brindes já estão separados no seu nome.";
const OUTROS = "O seu brinde já está separado. Se preferir o de 12 meses, vão os dois.";

function com(ate: string) {
  const c = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, fechamento: { ...CONFIG_VENDA_EXEMPLO.fechamento, brindes: { ate, doze: DOZE, outros: OUTROS } } });
  return c as never;
}
const estado = { objecoesUsadas: [], fechamentoEnviado: false } as never;

afterEach(() => vi.useRealTimers());

describe("fechamento com brinde por plano", () => {
  it("12 meses: abre com os dois brindes", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-05T15:00:00-03:00"));
    const p = planejar(com("2026-11-07T03:00:00Z"), "quero o de 12 meses", estado) as { tipo: string; partes: { texto: string }[] };
    expect(p.tipo).toBe("fechamento");
    expect(p.partes[0]!.texto).toBe(DOZE);
    expect(p.partes).toHaveLength(CONFIG_VENDA_EXEMPLO.fechamento!.partes.length + 1);
  });
  it("outro plano: abre com o brinde único e a oferta do de 12 meses", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-05T15:00:00-03:00"));
    const p = planejar(com("2026-11-07T03:00:00Z"), "quero o de 7 meses", estado) as { partes: { texto: string }[] };
    expect(p.partes[0]!.texto).toBe(OUTROS);
  });
  it("depois do prazo: pacote de sempre, sem a frase", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-08T12:00:00-03:00"));
    const p = planejar(com("2026-11-07T03:00:00Z"), "quero o de 12 meses", estado) as { partes: unknown[] };
    expect(p.partes).toHaveLength(CONFIG_VENDA_EXEMPLO.fechamento!.partes.length);
  });
});
