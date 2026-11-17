// @vitest-environment node
/**
 * M2 (auditoria 3): quando a lead pede para parar, o atendimento grava `disparo_conversas.etapa =
 * 'nao_contatar'`, mas o lead não ganhava marca nenhuma: o `/funil-valores` (que só olha `lead.bloqueado`) e os toques
 * planejados depois (follow-up do kit, cadência reaberta) passavam. Agora a etapa marca o lead
 * (`custom_fields.nao_contatar = true`), e quem lê o lead aceita a marca como booleano ou texto ("true" de CSV).
 */
import { describe, expect, it } from "vitest";

import { leadDaLinha } from "../repositorio-supabase";
import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { criarJulgar } from "./jev";
import { naoContatarMarcado } from "./repositorio-supabase";

const ORG = "66666666-6666-4666-8666-666666666666";
const AGORA = new Date("2026-10-14T13:00:00Z");

function montar() {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, "real"), CONFIG_VENDA_EXEMPLO);
  repo.novoLead("l1");
  repo.chipPorLead.set("l1", "chip-1");
  const atender = (chave: string, texto: string) =>
    atenderMensagem({ repo, agora: AGORA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, julgar: criarJulgar({ chave: null }) }, ORG, "l1", {
      chave, messageId: null, texto, midia: false, conversationId: "conv-1",
    });
  return { repo, atender };
}

describe("M2: `nao_contatar` do atendimento marca o lead", () => {
  it("a lead pede para parar: a conversa vai a `nao_contatar` e o lead é marcado (o que o motor e o /funil-valores leem)", async () => {
    const m = montar();
    await m.atender("m1", "pare de me mandar mensagem");
    expect(m.repo.conversas.get("l1")!.etapa).toBe("nao_contatar");
    expect(m.repo.naoContatar.has("l1")).toBe(true);
  });

  it("irmão: conversa normal não marca", async () => {
    const m = montar();
    await m.atender("m1", "quanto custa?");
    expect(m.repo.naoContatar.has("l1")).toBe(false);
  });

  it("a marca vale como booleano e como texto (import de CSV grava \"true\")", () => {
    expect(naoContatarMarcado({ nao_contatar: true })).toBe(true);
    expect(naoContatarMarcado({ nao_contatar: "true" })).toBe(true);
    expect(naoContatarMarcado({ nao_contatar: " TRUE " })).toBe(true);
    expect(naoContatarMarcado({ nao_contatar: false })).toBe(false);
    expect(naoContatarMarcado({})).toBe(false);
    const contato = { name: "Ana", display_name: null, phone_number: "5511999990000", is_blocked: false, is_anonymized: false };
    expect(leadDaLinha({ id: "l", status: "open", custom_fields: { nao_contatar: "true" }, contact: contato }).bloqueado).toBe(true);
    expect(leadDaLinha({ id: "l", status: "open", custom_fields: {}, contact: contato }).bloqueado).toBe(false);
  });
});
