/**
 * Uma pessoa no comando cala o atendimento (force_human, conversa pausada, dono
 * humano). Regra pura + atendimento inteiro contra o repositório em memória.
 * Cada caso de "cala" tem o irmão "responde" na mesma montagem.
 */
import { describe, expect, it } from "vitest";

import { CONFIG_PROSPECCAO_EXEMPLO, CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import type { ConfigAtendimento } from "./config";
import { vetoHumano } from "./humano";
import { criarJulgar } from "./jev";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-10-14T13:00:00Z");
const livre = { botSilencedUntil: null, assigneeKind: null, assignedToUserId: null };

describe("vetoHumano (regra pura)", () => {
  it("ninguém no comando: null (com e sem conversa)", () => {
    expect(vetoHumano({ forceHuman: false, conversas: [] }, AGORA)).toBeNull();
    expect(vetoHumano({ forceHuman: false, conversas: [{ ...livre, assigneeKind: "ai" }] }, AGORA)).toBeNull();
  });
  it("force_human vence, até sem conversa", () => {
    expect(vetoHumano({ forceHuman: true, conversas: [] }, AGORA)?.motivo).toBe("force_human");
  });
  it("silêncio no futuro e 'infinity' calam; silêncio vencido não", () => {
    expect(vetoHumano({ forceHuman: false, conversas: [{ ...livre, botSilencedUntil: "2026-10-14T13:05:00Z" }] }, AGORA)?.motivo).toBe("conversa_silenciada");
    expect(vetoHumano({ forceHuman: false, conversas: [{ ...livre, botSilencedUntil: "infinity" }] }, AGORA)?.motivo).toBe("conversa_silenciada");
    expect(vetoHumano({ forceHuman: false, conversas: [{ ...livre, botSilencedUntil: "2026-10-14T12:55:00Z" }] }, AGORA)).toBeNull();
  });
  it("dono humano cala (assignee_kind=user ou assigned_to_user_id)", () => {
    expect(vetoHumano({ forceHuman: false, conversas: [{ ...livre, assigneeKind: "user" }] }, AGORA)?.motivo).toBe("conversa_de_humano");
    expect(vetoHumano({ forceHuman: false, conversas: [{ ...livre, assignedToUserId: "u1" }] }, AGORA)?.motivo).toBe("conversa_de_humano");
  });
  it("qualquer conversa do contato basta", () => {
    expect(vetoHumano({ forceHuman: false, conversas: [livre, { ...livre, botSilencedUntil: "infinity" }] }, AGORA)?.motivo).toBe("conversa_silenciada");
  });
});

function cenario(config: ConfigAtendimento = CONFIG_VENDA_EXEMPLO) {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), config);
  const lead = repo.novoLead("lead-h");
  repo.chipPorLead.set(lead.id, "chip");
  let n = 0;
  const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) };
  const diz = (texto: string) => atenderMensagem(deps, ORG, lead.id, { chave: `h${++n}`, messageId: null, texto, midia: false });
  return { repo, lead, diz };
}

describe("atendimento com humano no comando", () => {
  it("irmão: sem humano, 'Quanto custa?' recebe o funil de valores", async () => {
    const { repo, lead, diz } = cenario();
    const r = await diz("Quanto custa?");
    expect(r.resultado).toBe("decidida");
    expect(repo.enviosDo(lead.id).length).toBeGreaterThan(0);
  });

  it.each([
    ["force_human", (r: RepositorioEmMemoria, id: string) => r.forceHuman.add(id)],
    ["conversa pausada (interruptor pause-ai)", (r: RepositorioEmMemoria, id: string) => r.conversasDoLead.set(id, [{ botSilencedUntil: "infinity", assigneeKind: null, assignedToUserId: null }])],
    ["dono humano", (r: RepositorioEmMemoria, id: string) => r.conversasDoLead.set(id, [{ botSilencedUntil: null, assigneeKind: "user", assignedToUserId: "u1" }])],
  ])("%s: nada sai, nada é decidido, a leitura fica registrada", async (_n, ligar) => {
    const { repo, lead, diz } = cenario();
    ligar(repo, lead.id);
    const r = await diz("Quanto custa?");
    expect(r.resultado).toBe("registrada");
    expect(r.resumo).toContain("humano no comando");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(repo.avisos).toHaveLength(0);
    expect(repo.conversas.has(lead.id)).toBe(false);
    expect([...repo.leituras.values()][0]!.decisao).toContain("só registrado");
  });

  it("o que estava na fila automática não sai mais", async () => {
    const { repo, lead, diz } = cenario();
    repo.pendentesDoMotor.push({ leadId: lead.id, estado: "pendente" });
    repo.forceHuman.add(lead.id);
    await diz("oi");
    expect(repo.pendentesDoMotor[0]!.estado).toBe("cancelado");
  });

  it("reativar (solta as travas) volta a responder", async () => {
    const { repo, lead, diz } = cenario();
    repo.conversasDoLead.set(lead.id, [{ botSilencedUntil: "infinity", assigneeKind: null, assignedToUserId: null }]);
    expect((await diz("Quanto custa?")).resultado).toBe("registrada");
    repo.conversasDoLead.delete(lead.id);
    expect((await diz("Quanto custa mesmo?")).resultado).toBe("decidida");
  });

  it("vale também para o perfil prospecção", async () => {
    const { repo, lead, diz } = cenario(CONFIG_PROSPECCAO_EXEMPLO);
    repo.forceHuman.add(lead.id);
    const r = await diz("quero saber mais");
    expect(r.resultado).toBe("registrada");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });
});
