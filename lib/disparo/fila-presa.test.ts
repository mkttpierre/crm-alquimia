// @vitest-environment node
/**
 * E4 (confirmado em produção): fila presa em chip parado. 67 envios vencidos estavam parados em chips com
 * conexão STOPPED ou saúde vermelha: `vencidos` filtra por chip e a realocação só cuida de linha sem chip, então nada
 * os move — e ninguém sabia. NÃO se move fila entre chips (vale a regra de `chip_origem`): só leitura
 * e UM aviso na Central por organização, atualizado no lugar, que fecha quando a fila anda.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import type { ConfigDisparo } from "./config";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo } from "./motor";
import { H, MIN } from "./ritmo";

const ORG = "00000000-0000-4000-8000-0000000000f4";
const AGORA = new Date("2026-10-23T12:00:00-03:00");
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const LEAD: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

const vencido = (id: string, haMin: number, chipId = "chip-1"): LinhaEnvio => ({
  id, leadId: `lead-${id}`, chipId, tipo: "toque_2", origem: "motor", texto: "Oi, passando de novo.", midia: null, midiaId: null,
  enviarApos: new Date(AGORA.getTime() - haMin * MIN), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - 3 * 24 * H), daParada: false,
});

function montar(fila: LinhaEnvio[], modo: "real" | "simulado" = "real") {
  const config: ConfigDisparo = { ...configDoMotor(ORG, modo), fonteStageId: null };
  const m = motorEmMemoria(AGORA, config, [LEAD]);
  m.envios.push(...fila);
  m.chip.nome = "chip-gama";
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid" }));
  const rodar = (agora = AGORA) => rodarDisparo({ repo: m.repo, agora, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  const abertos = () => m.avisosVivos.filter((a) => a.aberto && /presos em chip parado/.test(a.titulo));
  return { ...m, enviarReal, rodar, abertos };
}

describe("fila vencida presa em chip parado vira aviso, nunca muda de chip", () => {
  it("chip vermelho com 3 envios vencidos há horas: um aviso dizendo quantos, em qual chip, por quê e desde quando; nada sai nem muda de chip", async () => {
    const m = montar([vencido("a", 120), vencido("b", 90), vencido("c", 60)]);
    Object.assign(m.chip, { saude: "vermelho", pausadoAte: new Date(AGORA.getTime() + 24 * H) });
    await m.rodar();
    expect(m.enviarReal).not.toHaveBeenCalled();
    expect(m.envios.map((e) => [e.chipId, e.estado])).toEqual([["chip-1", "pendente"], ["chip-1", "pendente"], ["chip-1", "pendente"]]);
    const [aviso, ...outros] = m.abertos();
    expect(outros).toHaveLength(0);
    expect(aviso!.corpo).toMatch(/chip-gama/);
    expect(aviso!.corpo).toMatch(/3 envios vencidos/);
    expect(aviso!.corpo).toMatch(/saúde vermelha/);
    expect(aviso!.corpo).toMatch(/desde 23\/10 10:00/); // o mais antigo, no horário local
    expect(aviso!.corpo).toMatch(/não os passa para outro chip/);
  });

  it("voltas seguintes não empilham: o mesmo aviso, atualizado quando o número muda", async () => {
    const m = montar([vencido("a", 120), vencido("b", 90)]);
    m.chip.saude = "vermelho";
    await m.rodar();
    await m.rodar(new Date(AGORA.getTime() + MIN));
    expect(m.avisosVivos).toHaveLength(1);
    m.envios.push(vencido("c", 45));
    await m.rodar(new Date(AGORA.getTime() + 2 * MIN));
    expect(m.avisosVivos).toHaveLength(1);
    expect(m.abertos()[0]!.corpo).toMatch(/3 envios vencidos/);
  });

  it("a fila andou (o chip voltou e mandou, ou o operador cancelou): o aviso fecha sozinho", async () => {
    const m = montar([vencido("a", 120)]);
    m.chip.saude = "vermelho";
    await m.rodar();
    expect(m.abertos()).toHaveLength(1);
    m.envios[0]!.estado = "cancelado";
    await m.rodar(new Date(AGORA.getTime() + MIN));
    expect(m.abertos()).toHaveLength(0);
  });

  it("conexão STOPPED com o chip verde (organização em modo real): também é chip parado", async () => {
    const m = montar([vencido("a", 120)]);
    m.conexao.valor = "STOPPED";
    m.chip.proximoEnvioEm = new Date(AGORA.getTime() + 60 * MIN); // a vez não chegou: a fila só espera
    await m.rodar();
    expect(m.abertos()[0]!.corpo).toMatch(/conexão STOPPED/);
  });

  it("chip desligado, que nem entra na volta, também aparece", async () => {
    const m = montar([vencido("x", 300, "chip-2")]);
    m.outrosChips.push({ id: "chip-2", nome: "chip-frio", estado: "desligado", saude: "verde", pausadoAte: null, conexao: "WORKING" });
    await m.rodar();
    expect(m.abertos()[0]!.corpo).toMatch(/chip-frio \(chip desligado\): 1 envio vencido/);
  });

  it("irmão: chip parado com fila vencida há menos de 30 min ainda não avisa", async () => {
    const m = montar([vencido("a", 10)]);
    m.chip.saude = "vermelho";
    await m.rodar();
    expect(m.abertos()).toHaveLength(0);
  });

  it("irmão: chip de pé com fila vencida (esperando o ritmo) não é fila presa", async () => {
    const m = montar([vencido("a", 120)]);
    m.chip.proximoEnvioEm = new Date(AGORA.getTime() + 60 * MIN);
    await m.rodar();
    expect(m.abertos()).toHaveLength(0);
  });

  it("irmão: em modo simulado a conexão não segura nada (o ensaio não fala com o canal)", async () => {
    const m = montar([vencido("a", 120)], "simulado");
    m.conexao.valor = null;
    m.chip.proximoEnvioEm = new Date(AGORA.getTime() + 60 * MIN);
    await m.rodar();
    expect(m.abertos()).toHaveLength(0);
  });
});
