/**
 * O motor respeita quem está no comando: lead com humano (force_human, conversa
 * pausada, dono humano) não recebe toque de cadência nem resposta pendente. É o
 * mesmo veto do atendimento (`atendimento/humano.ts`). Cada caso que veta tem o
 * irmão que passa, na mesma montagem — senão o veto verde poderia ser vacuidade.
 *
 * Exceção provada aqui: o pacote do ponto de parada (`daParada`) ignora só a PAUSA
 * que o próprio ponto pôs; quem assumiu de fato ainda o cala.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import type { SituacaoHumana } from "./atendimento/humano";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo } from "./motor";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const AGORA = new Date("2026-10-07T10:00:00-03:00"); // quarta, dentro da janela
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const livre = { botSilencedUntil: null, assigneeKind: null, assignedToUserId: null };
const silenciada = { ...livre, botSilencedUntil: "infinity" };

const lead = (id: string): LeadDoDisparo => ({
  id, nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {},
});
const comHumano = (leadId: string, s: { forceHuman?: boolean; conversas?: readonly SituacaoHumana["conversas"][number][] }) =>
  new Map<string, SituacaoHumana>([[leadId, { forceHuman: s.forceHuman ?? false, conversas: [...(s.conversas ?? [])] }]]);

function linha(p: Partial<LinhaEnvio> & Pick<LinhaEnvio, "id" | "leadId" | "tipo" | "origem">): LinhaEnvio {
  return {
    chipId: "chip-1", texto: "Oi", midia: null, midiaId: null, enviarApos: new Date(AGORA.getTime() - 60_000),
    estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - 3_600_000), daParada: false, ...p,
  };
}

/** Uma volta do motor em modo real, com as duas chaves viradas e um espião no canal. */
async function volta(humano: Map<string, SituacaoHumana>, fila: LinhaEnvio[], leads = [lead("l1")], fonte = false) {
  const config = { ...configDoMotor(ORG, "real"), fonteStageId: fonte ? "stage-1" : null };
  const m = motorEmMemoria(AGORA, config, leads, { humano });
  m.envios.push(...fila);
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid-1" }));
  const resumo = await rodarDisparo({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  return { ...m, enviarReal, resumo };
}

describe("motor: abertura", () => {
  it("irmão: sem ninguém no comando, a abertura sai", async () => {
    const { enviarReal, envios } = await volta(new Map(), [], [lead("l1")], true);
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(envios.find((e) => e.tipo === "abertura")!.estado).toBe("enviado");
  });

  it("force_human: a abertura é cancelada com o motivo, nada vai ao canal", async () => {
    const { enviarReal, envios } = await volta(comHumano("l1", { forceHuman: true }), [], [lead("l1")], true);
    expect(enviarReal).not.toHaveBeenCalled();
    expect(envios.find((e) => e.tipo === "abertura")).toMatchObject({ estado: "cancelado", motivo: "humano no comando (force_human)" });
  });
});

describe("motor: toque de cadência pendente", () => {
  const toque = () => linha({ id: "t2", leadId: "l1", tipo: "toque_2", origem: "motor" });

  it("irmão: sem ninguém no comando, o toque sai", async () => {
    const { enviarReal, envios } = await volta(new Map(), [toque()]);
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(envios[0]!.estado).toBe("enviado");
  });

  it.each([
    ["force_human", { forceHuman: true }, "force_human"],
    ["conversa pausada (infinity)", { conversas: [silenciada] }, "conversa_silenciada"],
    ["silêncio no futuro", { conversas: [{ ...livre, botSilencedUntil: "2026-10-07T11:00:00-03:00" }] }, "conversa_silenciada"],
    ["dono humano", { conversas: [{ ...livre, assigneeKind: "user", assignedToUserId: "u1" }] }, "conversa_de_humano"],
  ] as const)("%s: o toque é cancelado, com o motivo, e nada vai ao canal", async (_n, s, motivo) => {
    const { enviarReal, envios } = await volta(comHumano("l1", s), [toque()]);
    expect(enviarReal).not.toHaveBeenCalled();
    expect(envios[0]).toMatchObject({ estado: "cancelado", motivo: `humano no comando (${motivo})` });
  });

  it("silêncio que já venceu não segura ninguém", async () => {
    const { enviarReal } = await volta(comHumano("l1", { conversas: [{ ...livre, botSilencedUntil: "2026-10-07T09:00:00-03:00" }] }), [toque()]);
    expect(enviarReal).toHaveBeenCalledTimes(1);
  });

  it("o veto cancela o resto da cadência pendente do lead, mas não a de outro lead", async () => {
    const { envios } = await volta(
      comHumano("l1", { forceHuman: true }),
      [
        toque(),
        linha({ id: "t3", leadId: "l1", tipo: "toque_3", origem: "motor", enviarApos: new Date(AGORA.getTime() + 86_400_000) }),
        linha({ id: "o2", leadId: "l2", tipo: "toque_2", origem: "motor", enviarApos: new Date(AGORA.getTime() + 86_400_000) }),
      ],
      [lead("l1"), lead("l2")],
    );
    expect(envios.find((e) => e.id === "t3")!.estado).toBe("cancelado");
    expect(envios.find((e) => e.id === "o2")!.estado).toBe("pendente");
  });
});

describe("motor: resposta automática pendente", () => {
  const resposta = (p: Partial<LinhaEnvio> = {}) => linha({ id: "r1", leadId: "l1", tipo: "entrega", origem: "auto", texto: "Chega em 5 dias", ...p });

  it("irmão: sem ninguém no comando, a resposta sai", async () => {
    const { enviarReal } = await volta(new Map(), [resposta()]);
    expect(enviarReal).toHaveBeenCalledTimes(1);
  });

  it("conversa pausada: a resposta que não é do ponto de parada não sai", async () => {
    const { enviarReal, envios } = await volta(comHumano("l1", { conversas: [silenciada] }), [resposta()]);
    expect(enviarReal).not.toHaveBeenCalled();
    expect(envios[0]).toMatchObject({ estado: "cancelado", motivo: "humano no comando (conversa_silenciada)" });
  });
});

describe("motor: pacote do ponto de parada (daParada)", () => {
  const pacote = () => [
    linha({ id: "p1", leadId: "l1", tipo: "fechamento:seq", origem: "auto", texto: "", midiaId: "audio-1", daParada: true, enviarApos: new Date(AGORA.getTime() - 120_000) }),
    linha({ id: "p2", leadId: "l1", tipo: "fechamento:seq", origem: "auto", texto: "Me passa seu nome completo", daParada: true, enviarApos: new Date(AGORA.getTime() - 60_000) }),
  ];

  it("a pausa que o próprio ponto pôs NÃO cancela o pacote: ele sai", async () => {
    const { enviarReal, envios } = await volta(comHumano("l1", { conversas: [silenciada] }), pacote());
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(enviarReal.mock.calls[0]![0].midiaId).toBe("audio-1");
    expect(envios.find((e) => e.id === "p1")!.estado).toBe("enviado");
    expect(envios.find((e) => e.id === "p2")!.estado).toBe("pendente"); // a segunda parte espera a próxima volta
  });

  it("veto de outra resposta na mesma volta poupa o pacote (cancela só a fila comum)", async () => {
    const { envios } = await volta(comHumano("l1", { conversas: [silenciada] }), [
      linha({ id: "r0", leadId: "l1", tipo: "entrega", origem: "auto", enviarApos: new Date(AGORA.getTime() - 180_000) }),
      ...pacote(),
    ]);
    expect(envios.find((e) => e.id === "r0")!.estado).toBe("cancelado");
    expect(envios.filter((e) => e.daParada).map((e) => e.estado)).not.toContain("cancelado");
  });

  it.each([
    ["force_human", { forceHuman: true }],
    ["dono humano", { conversas: [{ ...livre, assigneeKind: "user", assignedToUserId: "u1" }] }],
  ] as const)("quem assumiu de fato (%s) cala também o pacote, e o resto dele é cancelado", async (_n, s) => {
    const { enviarReal, envios } = await volta(comHumano("l1", s), pacote());
    expect(enviarReal).not.toHaveBeenCalled();
    expect(envios.map((e) => e.estado)).toEqual(["cancelado", "cancelado"]);
  });
});
