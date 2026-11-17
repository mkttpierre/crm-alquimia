import { describe, expect, it, vi } from "vitest";

import { configDoMotor, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import { rodarDisparo, type LeadDoDisparo } from "./motor";
import { CONFIG_VENDA_EXEMPLO, RepositorioEmMemoria } from "./atendimento/apoio-de-teste";
import { atendimentoSchema } from "./atendimento/config";
import { conversaNova } from "./atendimento/estado";
import { conferirRetornoReserva, registrarRetornoReservaEnviado } from "./atendimento/retorno-reserva";

const ORG = "00000000-0000-4000-8000-000000000009";
const AGORA = new Date("2026-11-05T12:00:00Z");
const lead: LeadDoDisparo = { id: "lead-1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

function cenario(agora = AGORA) {
  const config = { ...configDoMotor(ORG, "real"), fonteStageId: null };
  const at = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, retornoReserva: { ligado: true }, parada: { celular: "5511999999999", pontos: [] } });
  const atendimento = new RepositorioEmMemoria(ORG, config, at);
  atendimento.leads.set(lead.id, { ...lead, campos: {} });
  atendimento.conversas.set(lead.id, { ...conversaNova(), ultimaAutoEm: null, dados: { ...conversaNova().dados, retornoEm: "2026-11-05T12:00:00.000Z" } });
  const m = motorEmMemoria(agora, config, [{ ...lead, campos: {} }]);
  m.repo.situacaoDoKit = async () => ({ cliente: false, metodoPago: false, precisaOperador: false, quarentenaAte: null });
  m.repo.conferirRetornoReserva = (org, envio, agora) => conferirRetornoReserva(atendimento, org, envio, agora);
  m.repo.retornoReservaEnviado = (org, envio, agora, modo) => registrarRetornoReservaEnviado(atendimento, org, envio, agora, modo);
  const enviarReal = vi.fn(async () => ({ externalId: "msg-retorno" }));
  const rodar = async (enviarApos = agora) => {
    await m.repo.enfileirar(ORG, { leadId: lead.id, chipId: "chip-1", tipo: "retorno_reserva", origem: "auto", texto: "Olá Maria, tudo bem? Seu pedido está reservado.", enviarApos });
    return rodarDisparo({ repo: m.repo, agora, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0, enviarReal, enviarAviso: SEM_AVISO });
  };
  return { ...m, atendimento, config, enviarReal, rodar };
}

describe("retorno da reserva: motor", () => {
  it("só depois do envio marca quente, emite evento e avisa o celular pelo ponto de compra", async () => {
    const c = cenario();
    await c.rodar();
    expect(c.enviarReal).toHaveBeenCalledTimes(1);
    expect(c.envios[0]?.estado).toBe("enviado");
    expect(c.atendimento.conversas.get(lead.id)).toMatchObject({ quente: true, precisaOperador: true, etapa: "pronto_fechar" });
    expect(c.atendimento.eventosRetorno).toEqual([{ leadId: lead.id, envioId: "envio-1", evento: "retorno_reserva_enviado" }]);
    expect(c.atendimento.avisosAoCelular).toHaveLength(1);
    expect(c.atendimento.avisos.filter((a) => a.nivel === "compra")).toHaveLength(1);
    await registrarRetornoReservaEnviado(c.atendimento, ORG, c.envios[0]!, AGORA, "real");
    expect(c.atendimento.eventosRetorno).toHaveLength(1);
    expect(c.atendimento.avisosAoCelular).toHaveLength(1);
  });
  it.each(["bloqueado", "nao_contatar", "comprou", "humano", "quarentena", "limite", "config_desligada", "reserva_cancelada"])("não envia: %s", async (caso) => {
    const c = cenario();
    if (caso === "bloqueado") (await c.repo.lead(ORG, lead.id))!.bloqueado = true;
    if (caso === "nao_contatar") (await c.repo.lead(ORG, lead.id))!.campos.nao_contatar = true;
    if (caso === "comprou") c.atendimento.conversas.get(lead.id)!.etapa = "fechado";
    if (caso === "humano") c.humano.set(lead.id, { forceHuman: true, conversas: [] });
    if (caso === "quarentena") c.repo.situacaoDoKit = async () => ({ cliente: false, metodoPago: false, precisaOperador: false, quarentenaAte: new Date("2026-11-06T12:00:00Z") });
    if (caso === "limite") c.repo.origensRecentes = async () => ["auto", "auto"];
    if (caso === "config_desligada" && c.atendimento.atendimento?.perfil === "venda") c.atendimento.atendimento.retornoReserva.ligado = false;
    if (caso === "reserva_cancelada") c.atendimento.conversas.get(lead.id)!.dados.retornoEm = null;
    await c.rodar();
    expect(c.enviarReal).not.toHaveBeenCalled();
    expect(c.envios[0]?.estado).toBe("cancelado");
    expect(c.envios[0]?.motivo).toBeTruthy();
    expect(c.atendimento.avisosAoCelular).toHaveLength(0);
  });
  it.each(["domingo fechado", "saúde vermelha", "fora da janela"])("espera sem enviar: %s", async (caso) => {
    const c = cenario(caso === "fora da janela" ? new Date("2026-11-05T23:00:00Z") : caso === "domingo fechado" ? new Date("2026-11-08T12:00:00Z") : AGORA);
    if (caso === "saúde vermelha") c.chip.saude = "vermelho";
    if (caso === "domingo fechado") c.config.ritmo.janela = { ...c.config.ritmo.janela, domingo: [] };
    await c.rodar();
    expect(c.enviarReal).not.toHaveBeenCalled();
    expect(c.envios[0]?.estado).toBe("pendente");
  });
  it("erro do canal não marca quente nem emite aviso de compra", async () => {
    const c = cenario();
    c.enviarReal.mockRejectedValueOnce(new Error("falha temporária"));
    await c.rodar();
    expect(c.envios[0]?.estado).toBe("pendente");
    expect(c.atendimento.conversas.get(lead.id)?.quente).toBe(false);
    expect(c.atendimento.avisosAoCelular).toHaveLength(0);
  });
  it("mensagem comum depois da reserva não apaga o retorno; recusa cancela", async () => {
    const c = cenario();
    c.repo.respostasDesde = async () => ["obrigada, até lá"];
    await c.rodar();
    expect(c.enviarReal).toHaveBeenCalledTimes(1);
    const recusou = cenario();
    recusou.repo.respostasDesde = async () => ["não quero mais"];
    await recusou.rodar();
    expect(recusou.enviarReal).not.toHaveBeenCalled();
    expect(recusou.envios[0]?.motivo).toMatch(/parar/);
  });
});

describe("retorno: cancelamento antes da data e concorrência", () => {
  it.each(["comprou", "parou", "humano", "operador respondeu"])("cancela a reserva futura no próximo ciclo: %s", async (caso) => {
    const c = cenario(new Date("2026-10-29T12:00:00Z"));
    if (caso === "comprou") c.atendimento.conversas.get(lead.id)!.etapa = "fechado";
    if (caso === "parou") c.atendimento.conversas.get(lead.id)!.etapa = "nao_contatar";
    if (caso === "humano") c.atendimento.forceHuman.add(lead.id);
    if (caso === "operador respondeu") c.atendimento.operadorFalou.add(lead.id);
    await c.rodar(AGORA);
    expect(c.envios[0]?.estado).toBe("cancelado");
    expect(c.envios[0]?.motivo).toMatch(/compra|encerrado|humano|operador/);
    expect(c.enviarReal).not.toHaveBeenCalled();
  });
  it("não envia enquanto a leitura da lead está remarcando a reserva", async () => {
    const c = cenario();
    c.repo.tomarTravaDoLead = async () => false;
    c.repo.soltarTravaDoLead = async () => undefined;
    await c.rodar();
    expect(c.envios[0]?.estado).toBe("pendente");
    expect(c.enviarReal).not.toHaveBeenCalled();
  });
});

describe("retorno não faz parte da resposta imediata antiga", () => {
  it.each(["resposta vencida", "lead respondeu"])("preserva a reserva futura quando cancela: %s", async (caso) => {
    const agora = new Date("2026-10-29T12:00:00Z");
    const c = cenario(agora);
    await c.repo.enfileirar(ORG, { leadId: lead.id, chipId: "chip-1", tipo: "entrega", origem: "auto", texto: "Chega em cinco dias.", enviarApos: new Date(agora.getTime() - (caso === "resposta vencida" ? 3 * 60 * 60 * 1000 : 60_000)) });
    if (caso === "lead respondeu") c.repo.respostasDesde = async () => ["obrigada"];
    await c.rodar(AGORA);
    expect(c.envios[0]?.estado).toBe("cancelado");
    expect(c.envios[1]?.estado).toBe("pendente");
    expect(c.enviarReal).not.toHaveBeenCalled();
  });
});
