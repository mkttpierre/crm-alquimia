/**
 * ORDEM do ponto de parada: o pacote de fechamento (2 áudios + pedido de nome,
 * endereço e pagamento) é enfileirado ANTES de a conversa ser pausada e de o
 * operador ser avisado — e a pausa, que vale na hora, não cancela o pacote já
 * decidido. O aviso ao celular vai depois do último envio do pacote.
 *
 * Duas provas:
 *  1. o atendimento inteiro contra o repositório em memória, conferindo a SEQUÊNCIA
 *     das chamadas e os horários que ele agendou (pausa humanizada pela duração do áudio);
 *  2. o que ele deixou na fila vai para o MOTOR (repositório em memória do motor,
 *     espiões no canal), que roda voltas até esvaziar: a ordem em que as coisas
 *     SAEM é pacote, pacote, pacote, aviso — mesmo com a conversa já pausada.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, motorEmMemoria } from "../apoio-do-motor-teste";
import { type EnvioDeAviso, type EnvioReal, type LeadDoDisparo, rodarDisparo } from "../motor";
import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { atendimentoSchema } from "./config";
import { criarJulgar } from "./jev";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-10-14T13:00:00Z");
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const CELULAR = "5511900000002";

const PARADA = {
  celular: CELULAR,
  aviso: "Respondeu {titulo}\nNome: {nome}\nWhatsApp: {telefone}",
  pontos: [
    { id: "escolheu_kit", evento: "escolheu_kit", titulo: "KIT ESCOLHIDO", etapa: "pronto_fechar", tag: "pronto-pra-fechar" },
    { id: "pediu_site", evento: "pediu_site", titulo: "PEDIU O SITE", tag: "pediu-o-site" },
  ],
};

let n = 0;
function cenario(modo: "simulado" | "real" = "real") {
  const config = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, parada: PARADA });
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, modo), config);
  const lead = repo.novoLead(`lead-o${++n}`);
  repo.chipPorLead.set(lead.id, "chip-1");
  const deps = { repo, agora: AGORA, ambiente: modo === "real" ? AMBIENTE : {}, julgar: criarJulgar({ chave: null }) };
  const diz = (texto: string) => atenderMensagem(deps, ORG, lead.id, { chave: `o${++n}`, messageId: null, texto, midia: false, conversationId: "conv-1" });
  return { repo, lead, diz };
}

describe("ponto de parada: 'quero fechar' sem a quantidade não para; a quantidade dita fecha o pacote e SÓ DEPOIS para", () => {
  it("'quero fechar' (ponto quer_fechar que só avisa, parar:false): sem pausa, sem card/tag, mas o operador é avisado; '12 meses': PT1, PT2, PT3 na ordem e só então parada e aviso", async () => {
    const config = atendimentoSchema.parse({
      ...CONFIG_VENDA_EXEMPLO,
      parada: { ...PARADA, pontos: [...PARADA.pontos, { id: "quer_fechar", evento: "quer_fechar", titulo: "QUER FECHAR", parar: false }] },
    });
    const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, "real"), config);
    const lead = repo.novoLead(`lead-q${++n}`);
    repo.chipPorLead.set(lead.id, "chip-1");
    const deps = { repo, agora: AGORA, ambiente: AMBIENTE, julgar: criarJulgar({ chave: null }) };
    const diz = (texto: string) => atenderMensagem(deps, ORG, lead.id, { chave: `q${++n}`, messageId: null, texto, midia: false, conversationId: "conv-1" });

    await diz("Quanto custa?");
    repo.operadorFalou.add(lead.id);
    const r1 = await diz("quero fechar");
    repo.operadorFalou.delete(lead.id);
    expect(r1.resumo).not.toContain("conversa pausada");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("pergunta_kit");
    expect(repo.paradas).toHaveLength(0);
    expect(repo.avisosAoCelular.map((a) => a.ponto)).toEqual(["quer_fechar"]);
    expect(repo.movimentosDeParada).toHaveLength(0);
    expect(repo.tags).toHaveLength(0);
    expect(repo.chamadas).not.toContain("pararConversa");

    const antes = repo.chamadas.length;
    const r2 = await diz("12 meses");
    expect(r2.resumo).toContain("parada: escolheu_kit");
    const novas = repo.chamadas.slice(antes);
    const fila = novas.filter((c) => c.startsWith("enfileirar:"));
    expect(fila).toHaveLength(3);
    const ultimaParte = novas.lastIndexOf(fila.at(-1)!);
    expect(novas.indexOf("pararConversa")).toBeGreaterThan(ultimaParte);
    expect(novas.indexOf("avisarCelular")).toBeGreaterThan(novas.indexOf("pararConversa"));
    const pacote = repo.enviosDo(lead.id).filter((e) => e.tipo.startsWith("fechamento"));
    expect(pacote.map((e) => e.midia?.nome ?? e.texto.slice(0, 20))).toEqual(["fechamento-1.opus", "fechamento-2.opus", "Para fechar, me pass"]);
    expect(pacote.map((e) => e.daParada)).toEqual([true, true, true]);
    expect(repo.paradas).toHaveLength(1);
    expect(repo.avisosAoCelular.map((a) => a.ponto)).toEqual(["quer_fechar", "escolheu_kit"]);
    expect(repo.tags).toEqual([{ leadId: lead.id, tag: "pronto-pra-fechar" }]);
  });
});

describe("ponto de parada: o pacote é enfileirado antes de pausar e avisar", () => {
  it("kit escolhido: 3 partes na fila, DEPOIS a pausa, o card, a etiqueta e o aviso — nessa ordem", async () => {
    const { repo, lead, diz } = cenario();
    const r = await diz("Quero o de 12 meses");
    expect(r.resumo).toContain("parada: escolheu_kit");

    const i = (c: string) => repo.chamadas.indexOf(c);
    const fila = repo.chamadas.filter((c) => c.startsWith("enfileirar:"));
    expect(fila).toHaveLength(3); // áudio PT1, áudio PT2, pedido de nome/endereço/pagamento
    const ultimaParte = repo.chamadas.lastIndexOf(fila.at(-1)!);
    expect(i("pararConversa")).toBeGreaterThan(ultimaParte);
    expect(i("moverParaEtapa")).toBeGreaterThan(ultimaParte);
    expect(i("aplicarTag")).toBeGreaterThan(ultimaParte);
    expect(i("avisarCelular")).toBeGreaterThan(i("pararConversa"));
    expect(i("avisarCelular")).toBeGreaterThan(ultimaParte);

    // O pacote está marcado como "da parada": a pausa que vem a seguir não o cancela.
    expect(repo.enviosDo(lead.id).map((e) => e.daParada)).toEqual([true, true, true]);
  });

  it("pausa humanizada entre as partes (29 a 34 s depois de áudio) e o aviso só depois da última", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quero o de 12 meses");
    const [pt1, pt2, pt3] = repo.enviosDo(lead.id);
    // pt1 e pt2 são áudios (de 47 s e 49 s): a parte seguinte sai de 29 a 34 s depois, sorteado, e não mais "áudio + 8 s"
    for (const [a, b] of [[pt1!, pt2!], [pt2!, pt3!]] as const) {
      expect(b.enviarApos.getTime() - a.enviarApos.getTime()).toBeGreaterThanOrEqual(29_000);
      expect(b.enviarApos.getTime() - a.enviarApos.getTime()).toBeLessThanOrEqual(34_000);
    }
    expect(pt1!.enviarApos.getTime()).toBeGreaterThan(AGORA.getTime()); // ninguém responde no mesmo segundo

    const aviso = repo.avisosAoCelular[0]!;
    expect(aviso).toMatchObject({ destino: CELULAR, ponto: "escolheu_kit", conversationId: "conv-1", chipId: "chip-1" });
    expect(aviso.enviarApos.getTime()).toBeGreaterThan(pt3!.enviarApos.getTime());
    expect(aviso.texto).toContain("KIT ESCOLHIDO");
  });

  it("a pausa vale na hora (a conversa fica silenciada), e é por isso que o pacote precisa de proteção", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quero o de 12 meses");
    expect(repo.paradas).toHaveLength(1);
    expect(repo.conversasDoLead.get(lead.id)![0]!.botSilencedUntil).toBe("infinity");
  });

  it("resposta de decisão que NÃO para a conversa não leva a marca", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quanto custa?");
    expect(repo.enviosDo(lead.id).length).toBeGreaterThan(0);
    expect(repo.enviosDo(lead.id).every((e) => e.daParada === false)).toBe(true);
    expect(repo.chamadas).not.toContain("pararConversa");
  });

  it("simulado: o aviso é registrado como simulado, o pacote nasce simulado e nada é pendente", async () => {
    const { repo, lead, diz } = cenario("simulado");
    await diz("Quero o de 12 meses");
    expect(repo.enviosDo(lead.id).every((e) => e.estado === "simulado")).toBe(true);
    expect(repo.avisosAoCelular[0]!.modo).toBe("simulado");
  });
});

// ------------------------------------------------------------------ do atendimento ao motor ----

function leadDoMotor(id: string, bloqueado = false): LeadDoDisparo {
  return { id, nome: "Maria Silva", telefone: "5511900000000", status: "open", bloqueado, anonimizado: false, grupo: null, campos: {} };
}

/** Passa para o motor o que o atendimento deixou (fila, avisos, quem está no comando) e roda voltas até esvaziar. */
async function motorDepois(repo: RepositorioEmMemoria, leadId: string, opcoes: { bloqueado?: boolean; voltas?: number } = {}) {
  const humano = new Map([[leadId, { forceHuman: repo.forceHuman.has(leadId), conversas: repo.conversasDoLead.get(leadId) ?? [] }]]);
  const config = { ...configDoMotor(ORG, "real"), fonteStageId: null };
  const m = motorEmMemoria(AGORA, config, [leadDoMotor(leadId, opcoes.bloqueado)], { humano });
  for (const [k, e] of repo.envios.filter((x) => x.estado === "pendente" && !x.cancelado).entries()) {
    m.envios.push({
      id: `e${k}`, leadId, chipId: "chip-1", tipo: e.tipo, origem: "auto", texto: e.texto, midia: e.midia?.nome ?? null, midiaId: e.midia?.id ?? null,
      enviarApos: e.enviarApos, estado: "pendente", tentativas: 0, criadoEm: AGORA, daParada: e.daParada === true,
    });
  }
  for (const [k, a] of repo.avisosAoCelular.entries()) {
    m.avisos.push({ id: `a${k}`, leadId, chipId: a.chipId, canalId: "sessao-1", destino: a.destino, texto: a.texto, enviarApos: a.enviarApos, tentativas: 0, estado: "pendente" });
  }
  const saiu: string[] = [];
  const enviarReal = vi.fn<EnvioReal>(async (p) => (saiu.push(`pacote:${p.midiaId ?? p.texto}`), { externalId: "w" }));
  const enviarAviso = vi.fn<EnvioDeAviso>(async (p) => (saiu.push(`aviso:${p.destino}`), { externalId: "w-aviso" }));
  for (let v = 0; v < (opcoes.voltas ?? 8); v++) {
    await rodarDisparo({ repo: m.repo, agora: new Date(AGORA.getTime() + 10 * 60_000 + v * 60_000), ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso });
  }
  return { ...m, saiu, enviarReal, enviarAviso };
}

describe("ponto de parada: do atendimento ao motor", () => {
  const AUDIO1 = "00000000-0000-4000-8000-000000000920";
  const AUDIO2 = "00000000-0000-4000-8000-000000000921";

  it("com a conversa JÁ pausada, o pacote sai inteiro e o aviso ao celular vai por último", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quero o de 12 meses");
    expect(repo.conversasDoLead.get(lead.id)![0]!.botSilencedUntil).toBe("infinity");
    const { saiu } = await motorDepois(repo, lead.id);
    expect(saiu).toEqual([`pacote:${AUDIO1}`, `pacote:${AUDIO2}`, "pacote:Para fechar, me passa os dados do pedido.", `aviso:${CELULAR}`]);
  });

  it("a lead escreve no meio do pacote ('ok', 'pode ser?'): o atendimento só registra e o pacote continua inteiro", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quero o de 12 meses");
    const r = await diz("ok, pode ser");
    expect(r.resultado).toBe("registrada");
    expect(r.resumo).toContain("humano no comando");
    expect(repo.envios.filter((e) => e.daParada).every((e) => !e.cancelado)).toBe(true);
    const { saiu } = await motorDepois(repo, lead.id);
    expect(saiu).toHaveLength(4);
    expect(saiu.at(-1)).toBe(`aviso:${CELULAR}`);
  });

  it("controle: sem a marca da parada (o veto antigo) o pacote seria derrubado pela própria pausa", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quero o de 12 meses");
    for (const e of repo.envios) e.daParada = false; // desarma a exceção
    const { saiu } = await motorDepois(repo, lead.id);
    expect(saiu).toEqual([`aviso:${CELULAR}`]); // o pacote foi vetado; só o aviso saiu
  });

  it("a lead pede para sair (opt-out marca o contato como bloqueado): o resto do pacote é cancelado", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quero o de 12 meses");
    const { saiu, envios } = await motorDepois(repo, lead.id, { bloqueado: true });
    expect(saiu.filter((s) => s.startsWith("pacote:"))).toEqual([]);
    expect(envios.every((e) => e.estado === "cancelado")).toBe(true);
  });

  it("o operador assume a conversa de fato no meio do pacote: o resto do pacote é cancelado", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quero o de 12 meses");
    repo.conversasDoLead.set(lead.id, [{ botSilencedUntil: "infinity", assigneeKind: "user", assignedToUserId: "u1" }]);
    const { saiu } = await motorDepois(repo, lead.id);
    expect(saiu.filter((s) => s.startsWith("pacote:"))).toEqual([]);
  });

  it("controle sem aviso configurado: o pacote sai e nenhum aviso sai", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quero o de 12 meses");
    repo.avisosAoCelular.length = 0;
    const { saiu, enviarAviso } = await motorDepois(repo, lead.id);
    expect(saiu).toHaveLength(3);
    expect(enviarAviso).not.toHaveBeenCalled();
  });
});
