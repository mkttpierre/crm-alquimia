/**
 * C2 (auditoria 3): lead que nunca recebeu nada do motor (entrou por anúncio ou checkout e escreveu
 * primeiro) não tem "último envio" para dar o chip. As respostas nasciam com `chip_id NULL`, nenhum chip as pegava e
 * a lead ficava parada sem aviso. Agora o chip vem da CONVERSA da mensagem; sem chip nenhum, nada entra na fila e o
 * operador é avisado para responder na mão.
 */
import { describe, expect, it, vi } from "vitest";

import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { criarJulgar } from "./jev";

const ORG = "44444444-4444-4444-8444-444444444444";
const AGORA = new Date("2026-10-14T13:00:00Z");
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };

function montar() {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, "real"), CONFIG_VENDA_EXEMPLO);
  const lead = repo.novoLead("l1");
  const atender = (texto: string, conversationId: string | null = "conv-1") =>
    atenderMensagem({ repo, agora: AGORA, ambiente: AMBIENTE, julgar: criarJulgar({ chave: null }) }, ORG, lead.id, {
      chave: `m-${texto}`,
      messageId: null,
      texto,
      midia: false,
      conversationId,
    });
  return { repo, lead, atender };
}

describe("C2: resposta sem chip não entra na fila para morrer", () => {
  it("irmão: com chip (pela conversa), as respostas nascem pendentes NAQUELE chip", async () => {
    const { repo, atender } = montar();
    repo.chipPorLead.set("l1", "chip-1");
    await atender("Quanto custa?");
    const pendentes = repo.envios.filter((e) => e.estado === "pendente");
    expect(pendentes.length).toBeGreaterThan(0);
    expect(pendentes.every((e) => e.chipId === "chip-1")).toBe(true);
  });

  it("o chip é pedido pela conversa da mensagem (não só pelo último envio)", async () => {
    const { repo, atender } = montar();
    const espia = vi.spyOn(repo, "chipDoLead");
    await atender("Quanto custa?", "conv-9");
    expect(espia).toHaveBeenCalledWith(ORG, "l1", "conv-9");
  });

  it("sem chip nenhum (modo real): nenhuma linha com chip_id NULL entra na fila, e o operador é avisado para responder na mão", async () => {
    const { repo, atender } = montar();
    const r = await atender("Quanto custa?");
    expect(repo.envios.filter((e) => e.estado === "pendente")).toEqual([]);
    expect(repo.avisos.some((a) => /sem chip/i.test(a.titulo) && a.leadId === "l1")).toBe(true);
    expect(r.resumo).toMatch(/sem chip/);
  });
});
