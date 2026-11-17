import { describe, expect, it } from "vitest";
import { lerConfigTrava, MOTIVO_TRAVA_LEAD, TRAVA_PADRAO } from "./trava-nao-entregue";

describe("trava de não entregue: config", () => {
  it("sem nada no ritmo valem 24 h para marcar e 48 h para remover, ligada", () => {
    expect(lerConfigTrava(undefined)).toEqual(TRAVA_PADRAO);
    expect(lerConfigTrava(null)).toEqual({ ligado: true, horasMarcar: 24, horasRemover: 48, janelaDias: 7 });
  });
  it("só `ligado: false` desliga; outro valor estranho não", () => {
    expect(lerConfigTrava({ ligado: false }).ligado).toBe(false);
    expect(lerConfigTrava({ ligado: "não" }).ligado).toBe(true);
  });
  it("remover nunca vem antes de marcar e os limites seguram valores absurdos", () => {
    expect(lerConfigTrava({ horasMarcar: 36, horasRemover: 12 })).toMatchObject({ horasMarcar: 36, horasRemover: 36 });
    expect(lerConfigTrava({ horasMarcar: 0, janelaDias: 999 })).toMatchObject({ horasMarcar: 1, janelaDias: 30 });
    expect(lerConfigTrava({ horasMarcar: "24" })).toMatchObject({ horasMarcar: 24 });
  });
  it("o motivo começa com '1 tique', o padrão que os filtros de campanha já excluem", () => {
    expect(MOTIVO_TRAVA_LEAD).toMatch(/^1 tique/);
  });
});
