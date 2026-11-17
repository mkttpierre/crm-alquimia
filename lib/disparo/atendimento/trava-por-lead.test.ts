/**
 * A3 (auditoria 3): duas mensagens seguidas da lead ("quanto custa?" e "me fala mais", 2 s de intervalo)
 * chegam em dois webhooks em paralelo. Sem trava por lead, as duas leituras liam a conversa antes de a outra gravar,
 * as duas decidiam mandar a tabela e a fila ficava com DOIS funis intercalados. Com a trava, a segunda espera a
 * primeira terminar e decide sobre o estado que ela deixou (cancelando o que a primeira agendou).
 */
import { describe, expect, it } from "vitest";

import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem, type DepsDoAtendimento } from "./atendimento";
import { criarJulgar } from "./jev";

const ORG = "55555555-5555-4555-8555-555555555555";
const AGORA = new Date("2026-10-14T13:00:00Z");

function montar() {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, "real"), CONFIG_VENDA_EXEMPLO);
  repo.novoLead("l1");
  repo.chipPorLead.set("l1", "chip-1");
  const deps: DepsDoAtendimento = {
    repo,
    agora: AGORA,
    ambiente: { DISPARO_REAL_LIBERADO: "sim" },
    julgar: criarJulgar({ chave: null }),
    dormir: () => new Promise((r) => setTimeout(r, 1)),
  };
  const atender = (chave: string, texto: string) => atenderMensagem(deps, ORG, "l1", { chave, messageId: null, texto, midia: false, conversationId: "conv-1" });
  const vivas = () => repo.envios.filter((e) => e.estado === "pendente" && !e.cancelado);
  return { repo, atender, vivas };
}

describe("A3: trava por lead no atendimento", () => {
  it("referência: UMA mensagem agenda um funil", async () => {
    const um = montar();
    await um.atender("m1", "quanto custa?");
    expect(um.vivas().length).toBeGreaterThan(0);
  });

  it("duas mensagens em paralelo: a fila termina com UM funil só (a segunda decide depois da primeira)", async () => {
    const um = montar();
    await um.atender("m1", "quanto custa?");
    const umFunil = um.vivas().length;

    const dois = montar();
    await Promise.all([dois.atender("m1", "quanto custa?"), dois.atender("m2", "quanto custa?")]);
    expect(dois.vivas().length).toBeLessThanOrEqual(umFunil);
    // A trava foi solta: nada fica preso para a próxima mensagem.
    expect(dois.repo.travas.size).toBe(0);
  });

  it("trava ocupada por tempo demais (outra leitura travada): nada é decidido no automático e o operador é avisado", async () => {
    const m = montar();
    m.repo.travas.set("l1", "outra-leitura");
    const r = await m.atender("m3", "quanto custa?");
    expect(r.resultado).toBe("registrada");
    expect(m.vivas()).toEqual([]);
    expect(m.repo.avisos.some((a) => a.leadId === "l1")).toBe(true);
  });
});
