import { describe, expect, it } from "vitest";

import { resumoDosNumeros } from "./ConnectionsClient";

const t = (texto: string) => texto;
const conexao = (status: string) => ({ status });

// Conexões dizia "2 números conectados." com os dois ainda "Conectando...".
// A frase conta só o que está conectado de fato (WORKING).
describe("o resumo do topo de Conexões", () => {
  it("sem conexão nenhuma", () => {
    expect(resumoDosNumeros([], t)).toBe("Nenhum número conectado ainda.");
  });

  it("duas conexões esperando o QR não são números conectados", () => {
    const frase = resumoDosNumeros([conexao("SCAN_QR_CODE"), conexao("STARTING")], t);
    expect(frase).not.toMatch(/^2 números conectados/);
    expect(frase).toBe("0 de 2 números conectados.");
  });

  it("parte conectada: diz quantos de quantos", () => {
    expect(resumoDosNumeros([conexao("WORKING"), conexao("FAILED"), conexao("STOPPED")], t)).toBe(
      "1 de 3 números conectados.",
    );
  });

  it("todas conectadas: a frase de sempre, no singular e no plural", () => {
    expect(resumoDosNumeros([conexao("WORKING")], t)).toBe("1 número conectado.");
    expect(resumoDosNumeros([conexao("WORKING"), conexao("WORKING")], t)).toBe("2 números conectados.");
  });
});
