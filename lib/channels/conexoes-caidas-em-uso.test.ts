import { describe, expect, it } from "vitest";

import { listarConexoesCaidas } from "@/lib/channels/health";

/**
 * A faixa vermelha do topo de /app avisava de TODA conexão não arquivada em
 * estado de falha, inclusive número velho que ninguém usa. Quem lê a faixa todo
 * dia aprende a ignorá-la, e no dia em que o chip do motor cai ela já não diz
 * nada. A faixa passa a mostrar só a conexão EM USO: chip do motor que não está
 * `desligado`, ou conexão com mensagem (entrada ou saída) nos últimos 7 dias.
 *
 * O dublê é um banco em memória que APLICA os filtros da consulta (eq, is, in,
 * neq, gte, limit): o teste mede o que a função devolve para um conjunto de
 * linhas, não quais métodos ela chamou.
 */

type Linha = Record<string, unknown>;
type Banco = Record<string, Linha[]>;

function clienteDe(banco: Banco, falham: string[] = []) {
  const consultas: string[] = [];
  const admin = {
    from(tabela: string) {
      consultas.push(tabela);
      const filtros: Array<(l: Linha) => boolean> = [];
      let limite: number | null = null;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
        is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
        in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
        gte: (c: string, v: string) => (filtros.push((l) => String(l[c]) >= v), q),
        limit: (n: number) => ((limite = n), q),
        then(ok: (r: { data: Linha[] | null; error: { message: string } | null }) => unknown) {
          if (falham.includes(tabela)) return Promise.resolve(ok({ data: null, error: { message: "db fora" } }));
          const linhas = (banco[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
          return Promise.resolve(ok({ data: limite === null ? linhas : linhas.slice(0, limite), error: null }));
        },
      };
      return q;
    },
  };
  return { admin: admin as never, consultas };
}

const ORG = "org-1";
const AGORA = new Date("2026-11-13T12:00:00.000Z");
const diasAtras = (d: number) => new Date(AGORA.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

function sessao(status: string, extra: Linha = {}): Linha {
  return {
    id: "sess-1",
    organization_id: ORG,
    display_name: "Vendas",
    phone_number: "5511999990000",
    status,
    archived_at: null,
    ...extra,
  };
}

function chip(estado: string, extra: Linha = {}): Linha {
  return { id: "chip-1", organization_id: ORG, channel_session_id: "sess-1", estado, ...extra };
}

function mensagem(dias: number, extra: Linha = {}): Linha {
  const quando = diasAtras(dias);
  return {
    id: `msg-${dias}`,
    organization_id: ORG,
    channel_session_id: "sess-1",
    direction: "inbound",
    type: "text",
    sent_at: quando,
    created_at: quando,
    ...extra,
  };
}

describe("faixa de desconectado só para conexão em uso", () => {
  it("nao_avisa_conexao_parada_sem_uso", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("FAILED")] });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toEqual([]);
  });

  it("avisa_chip_do_motor_caido", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("STOPPED")], disparo_chips: [chip("ativo")] });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toEqual([
      { id: "sess-1", apelido: "Vendas", status: "STOPPED" },
    ]);
  });

  it("avisa_conexao_com_mensagem_recente", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("FAILED")], messages: [mensagem(2)] });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toHaveLength(1);
  });

  it("avisa_conexao_com_mensagem_de_saida_recente", async () => {
    const { admin } = clienteDe({
      channel_sessions: [sessao("SCAN_QR_CODE")],
      messages: [mensagem(1, { direction: "outbound" })],
    });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toHaveLength(1);
  });

  it("ignora_mensagem_de_8_dias", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("FAILED")], messages: [mensagem(8)] });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toEqual([]);
  });

  it("nota de tela (type=system) recente não conta como uso", async () => {
    const { admin } = clienteDe({
      channel_sessions: [sessao("FAILED")],
      messages: [mensagem(1, { type: "system" })],
    });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toEqual([]);
  });

  it("avisa_chip_pausado_caido", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("FAILED")], disparo_chips: [chip("pausado")] });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toHaveLength(1);
  });

  it("avisa_chip_em_rampa_caido", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("FAILED")], disparo_chips: [chip("rampa")] });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toHaveLength(1);
  });

  it("nao_avisa_chip_desligado", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("FAILED")], disparo_chips: [chip("desligado")] });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toEqual([]);
  });

  it("chip e mensagem de OUTRA organização não contam", async () => {
    const { admin } = clienteDe({
      channel_sessions: [sessao("FAILED")],
      disparo_chips: [chip("ativo", { organization_id: "org-2" })],
      messages: [mensagem(1, { organization_id: "org-2" })],
    });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toEqual([]);
  });

  it("conexão saudável ou arquivada segue fora, mesmo em uso", async () => {
    const { admin } = clienteDe({
      channel_sessions: [
        sessao("WORKING"),
        sessao("FAILED", { id: "sess-2", archived_at: diasAtras(1) }),
      ],
      disparo_chips: [chip("ativo"), chip("ativo", { id: "chip-2", channel_session_id: "sess-2" })],
      messages: [mensagem(1), mensagem(1, { id: "m2", channel_session_id: "sess-2" })],
    });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toEqual([]);
  });

  it("muitas mensagens de uma conexão não escondem a outra", async () => {
    const muitas = Array.from({ length: 2000 }, (_, i) => mensagem(1, { id: `a-${i}` }));
    const { admin } = clienteDe({
      channel_sessions: [sessao("FAILED"), sessao("FAILED", { id: "sess-2", display_name: "Suporte" })],
      messages: [...muitas, mensagem(3, { id: "b-1", channel_session_id: "sess-2" })],
    });
    const caidas = await listarConexoesCaidas(admin, ORG, AGORA);
    expect(caidas.map((c) => c.id).sort()).toEqual(["sess-1", "sess-2"]);
  });

  it("leitura do motor falhou: na dúvida, a faixa aparece", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("FAILED")] }, ["disparo_chips"]);
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toHaveLength(1);
  });

  it("leitura das mensagens falhou: na dúvida, a faixa aparece", async () => {
    const { admin } = clienteDe({ channel_sessions: [sessao("FAILED")] }, ["messages"]);
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toHaveLength(1);
  });

  it("sem conexão caída, não consulta motor nem mensagens", async () => {
    const { admin, consultas } = clienteDe({ channel_sessions: [sessao("WORKING")] });
    expect(await listarConexoesCaidas(admin, ORG, AGORA)).toEqual([]);
    expect(consultas).toEqual(["channel_sessions"]);
  });
});
