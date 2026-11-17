// @vitest-environment node
/**
 * Sequência do operador (`/funil-valores`): o operador escolhe UM atalho na caixa de conversa e as 7 mensagens do
 * funil de valores saem em ordem, com pausa entre elas. Aqui: o cálculo dos horários e o agendamento inteiro contra
 * um repositório em memória. Nada fala com canal; o que o motor faz com as linhas está em `../sequencia-no-motor.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { configDoMotor } from "../apoio-do-motor-teste";
import type { Chip } from "../fila";
import {
  agendarSequencia,
  cancelarSequencia,
  ErroDaSequencia,
  estimarSegundosDoAudio,
  montarPartesDaSequencia,
  planejarHorariosDoFunil,
  type EnvioDaSequencia,
  type FunilParaAgendar,
  type ModeloDaParte,
  type RepositorioSequencia,
} from "./sequencia-operador";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const USUARIO = "00000000-0000-4000-8000-0000000000u1";
const CONVERSA = "00000000-0000-4000-8000-0000000000v1";
const AGORA = new Date("2026-10-23T15:00:00Z");
const AMBIENTE_REAL = { DISPARO_REAL_LIBERADO: "sim" };

const OGG_64S = 600_142; // "Valores: áudio 1" (~64 s)
const OGG_28S = 261_573; // "Valores: áudio 2" (~28 s)
const JPG = 396_509;

const audio = (id: string, bytes: number) => ({ id, kind: "audio" as const, nome: id, tamanhoBytes: bytes });
const imagem = (id: string) => ({ id, kind: "image" as const, nome: id, tamanhoBytes: JPG });

/** Os 7 modelos do funil de valores de uma organização, na ordem. */
function modelosDoFunil(): ModeloDaParte[] {
  return [
    { atalho: "valores-1", titulo: "1/7", corpo: "Vou te explicar sobre os *PREÇOS* e nossos *TRATAMENTOS* (Prazo de entrega de 5 a 7 dias via Correios)👇", midia: null },
    { atalho: "valores-2", titulo: "2/7", corpo: "", midia: audio("m-a1", OGG_64S) },
    { atalho: "valores-3", titulo: "3/7", corpo: `🎁 *12 MESES DE TRATAMENTO*\n💰R$897,00 à vista\n👉 https://pagamento.exemplo/a/abc123${"\nlinha de preço".repeat(20)}`, midia: null },
    { atalho: "valores-4", titulo: "4/7", corpo: "", midia: imagem("m-tab") },
    { atalho: "valores-5", titulo: "5/7", corpo: "*Recomendo o tratamento de 12 MESES* para alcançar o melhor resultado.", midia: null },
    { atalho: "valores-6", titulo: "6/7", corpo: "", midia: audio("m-a2", OGG_28S) },
    { atalho: "valores-7", titulo: "7/7", corpo: "Qual tratamento deseja iniciar e ter o meu acompanhamento individual?", midia: null },
  ];
}

const chipVerde = (p: Partial<Chip> = {}): Chip => ({
  id: "chip-1", nome: "celular-a", estado: "rampa", saude: "verde", diaRampa: 5, proximoEnvioEm: null, pausadoAte: null, enviosDesdePausa: 0, pausaACada: 15, ...p,
});

type Opcoes = {
  modelos?: ModeloDaParte[];
  chip?: Chip | null;
  lead?: { nome: string | null; telefone: string | null; bloqueado?: boolean; anonimizado?: boolean } | null;
  ligado?: boolean;
  modo?: "simulado" | "real";
  proibidos?: { motivo: string; padrao: string }[];
  emAberto?: number;
  /** Lead que `garantirLead` cria quando a conversa não tem (null = não conseguiu criar). */
  leadCriado?: string | null;
};

/** O funil de valores como a migration 0248 o semeia: 3 s depois de passo sem áudio, 31 s depois de passo com áudio. */
function funilDeValores(modelos: ModeloDaParte[]): FunilParaAgendar {
  return {
    id: "funil-1",
    titulo: "Funil de valores",
    atalho: "funil-valores",
    passos: modelos.map((m, i) => ({
      modelo: m,
      atrasoMs: i === 0 ? 0 : modelos[i - 1]!.midia?.kind === "audio" ? 31_000 : 3_000,
      presenca: m.midia?.kind === "audio" ? ("gravando" as const) : ("digitando" as const),
      presencaMs: m.midia?.kind === "audio" ? 20_000 : 2_000,
    })),
  };
}

function repoEmMemoria(o: Opcoes = {}) {
  const gravados: EnvioDaSequencia[] = [];
  const cancelamentos: string[] = [];
  const config = { ...configDoMotor(ORG, o.modo ?? "real"), ligado: o.ligado ?? true, proibidos: o.proibidos ?? [] };
  const lead = o.lead === undefined ? { nome: "Maria Souza", telefone: "+5511999990000" } : o.lead;
  const leadsCriados: string[] = [];
  let leadAtual: string | null = lead ? "lead-1" : null;
  const repo: RepositorioSequencia = {
    config: async () => config,
    leadDaConversa: async () => leadAtual,
    lead: async (_org, id) =>
      id === "lead-1" && lead
        ? { id: "lead-1", status: "open", bloqueado: false, anonimizado: false, ...lead }
        : id && id === o.leadCriado
          ? { id, nome: "Contato novo", telefone: "+5511900000001", status: "open", bloqueado: false, anonimizado: false }
          : null,
    garantirLead: async () => {
      const criado = o.leadCriado ?? null;
      if (criado) {
        leadsCriados.push(criado);
        leadAtual = criado;
      }
      return criado;
    },
    chipDaConversa: async () => (o.chip === undefined ? chipVerde() : o.chip),
    funil: async (_org, _user, ref) => (ref.atalho === "funil-valores" || ref.funnelId === "funil-1" ? funilDeValores(o.modelos ?? modelosDoFunil()) : null),
    modeloPorId: async (_org, _user, id) => (o.modelos ?? modelosDoFunil()).find((m) => m.atalho === id) ?? null,
    emAberto: async () => o.emAberto ?? 0,
    enfileirar: async (_org, envios) => void gravados.push(...envios),
    cancelar: async (_org, _lead, motivo) => {
      cancelamentos.push(motivo);
      return gravados.filter((g) => g.estado === "pendente").length;
    },
  };
  return { repo, gravados, cancelamentos, leadsCriados };
}

const pedido = { conversationId: CONVERSA, usuarioId: USUARIO, atalho: "funil-valores" };
const rodar = (o: Opcoes = {}, ambiente: Record<string, string | undefined> = AMBIENTE_REAL, sortear = () => 0.5) => {
  const m = repoEmMemoria(o);
  return { ...m, promessa: agendarSequencia({ repo: m.repo, agora: AGORA, ambiente, sortear }, ORG, pedido) };
};

async function erroDe(p: Promise<unknown>): Promise<ErroDaSequencia> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ErroDaSequencia) return e;
    throw e;
  }
  throw new Error("esperava ErroDaSequencia e nada foi lançado");
}

describe("estimarSegundosDoAudio", () => {
  it("bate com os dois áudios do funil real (64 s e 28 s, ±2 s)", () => {
    expect(estimarSegundosDoAudio(OGG_64S)).toBeGreaterThanOrEqual(62);
    expect(estimarSegundosDoAudio(OGG_64S)).toBeLessThanOrEqual(67);
    expect(estimarSegundosDoAudio(OGG_28S)).toBeGreaterThanOrEqual(26);
    expect(estimarSegundosDoAudio(OGG_28S)).toBeLessThanOrEqual(30);
  });
});

describe("planejarHorariosDoFunil", () => {
  const T = AGORA.getTime();
  it("mantém passos sem espera nem presença em horários estritamente crescentes", () => {
    const h = planejarHorariosDoFunil(
      [{ atrasoMs: 0, presencaMs: 0 }, { atrasoMs: 0, presencaMs: 0 }], AGORA, () => 0,
    );
    expect(h.map((x) => x.enviarApos.getTime() - T)).toEqual([2000, 3000]);
  });
  it("a presença ocupa o FIM do atraso: chega no tempo programado, e a primeira começa de 2 a 5 s depois do clique", () => {
    const h = planejarHorariosDoFunil(
      [
        { atrasoMs: 0, presencaMs: 2000 },
        { atrasoMs: 3000, presencaMs: 2000 },
        { atrasoMs: 31000, presencaMs: 20000 },
      ],
      AGORA,
      () => 0,
    );
    expect(h.map((x) => x.enviarApos.getTime() - T)).toEqual([2000, 5000, 18000]);
    expect(h.map((x) => x.enviarApos.getTime() + x.presencaMs - T)).toEqual([4000, 7000, 38000]);
  });

  it("presença nunca passa de 25 s nem do atraso do passo", () => {
    const h = planejarHorariosDoFunil(
      [
        { atrasoMs: 0, presencaMs: 25000 },
        { atrasoMs: 1000, presencaMs: 20000 },
        { atrasoMs: 120000, presencaMs: 90000 },
      ],
      AGORA,
      () => 1,
    );
    expect(h.map((x) => x.presencaMs)).toEqual([25000, 1000, 25000]);
  });

  it("o primeiro horário é sorteado entre 2 e 5 s", () => {
    expect(planejarHorariosDoFunil([{ atrasoMs: 0, presencaMs: 0 }], AGORA, () => 1)[0]!.enviarApos.getTime() - T).toBe(5000);
  });
});

describe("montarPartesDaSequencia", () => {
  it("troca {{nome}} e {{primeiro_nome}} pelo contato, como o atalho comum", () => {
    const m = montarPartesDaSequencia([{ atalho: "a", titulo: "t", corpo: "Oi {{primeiro_nome}}, tudo bem?", midia: null }], "Maria Souza", []);
    expect(m).toMatchObject({ ok: true, partes: [{ texto: "Oi Maria, tudo bem?" }] });
  });

  it("variável sem valor NUNCA segue (iria `{{nome}}` ao cliente): erro nomeando o atalho", () => {
    const m = montarPartesDaSequencia([{ atalho: "valores-1", titulo: "t", corpo: "Oi {{nome}}", midia: null }], null, []);
    expect(m).toMatchObject({ ok: false });
    expect((m as { motivo: string }).motivo).toMatch(/valores-1/);
  });

  it("áudio com texto vira duas partes (áudio primeiro), porque o WhatsApp não tem legenda de áudio", () => {
    const m = montarPartesDaSequencia([{ atalho: "x", titulo: "t", corpo: "Ouça", midia: audio("m", OGG_28S) }], "Ana", []);
    expect(m).toMatchObject({ ok: true });
    if (!m.ok) return;
    expect(m.partes.map((p) => [p.texto, p.midia?.id ?? null])).toEqual([["", "m"], ["Ouça", null]]);
  });

  it("modelo sem texto e sem anexo é erro", () => {
    expect(montarPartesDaSequencia([{ atalho: "v", titulo: "t", corpo: "  ", midia: null }], "Ana", [])).toMatchObject({ ok: false });
  });

  it("aplica as regras proibidas da casa (a mesma conferência do motor)", () => {
    const m = montarPartesDaSequencia([{ atalho: "v", titulo: "t", corpo: "Aprovado pela Anvisa", midia: null }], "Ana", [{ motivo: "cita Anvisa", padrao: "anvisa" }] as never);
    expect(m).toMatchObject({ ok: false });
    expect((m as { motivo: string }).motivo).toMatch(/Anvisa/);
  });
});

describe("agendarSequencia: o caminho feliz (modo real)", () => {
  it("grava as 7 mensagens na ordem do funil, origem operador, pendentes, no chip da conversa, com horários crescentes", async () => {
    const { promessa, gravados } = rodar();
    const r = await promessa;

    expect(gravados).toHaveLength(7);
    expect(gravados.map((g) => g.tipo)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `funil_valores:${n}`));
    expect(gravados.every((g) => g.estado === "pendente" && g.chipId === "chip-1" && g.leadId === "lead-1")).toBe(true);
    expect(gravados.map((g) => g.midiaId)).toEqual([null, "m-a1", null, "m-tab", null, "m-a2", null]);
    expect(gravados[0]!.texto).toMatch(/PREÇOS/);
    expect(gravados[1]!.texto).toBe("");
    // A cadência vem dos passos do funil (3 s depois de texto/imagem, 31 s depois de áudio): é o intervalo entre as
    // CHEGADAS (enviar_apos + presença), não entre os inícios. O intervalo mínimo do chip (90 s) não entra.
    const chegada = (g: EnvioDaSequencia) => g.enviarApos.getTime() + g.presencaMs;
    const pausas = gravados.slice(1).map((g, i) => (chegada(g) - chegada(gravados[i]!)) / 1000);
    expect(pausas).toEqual([3, 31, 3, 3, 3, 31]);
    expect(gravados.map((g) => g.presenca)).toEqual(["digitando", "gravando", "digitando", "digitando", "digitando", "gravando", "digitando"]);

    expect(r).toMatchObject({ partes: 7, modo: "real", titulo: expect.stringMatching(/valores/i) });
    expect(r.primeiraEm).toEqual(gravados[0]!.enviarApos);
    expect(r.ultimaEm.getTime()).toBe(chegada(gravados[6]!));
    expect(r.duracaoSeg).toBe(Math.round((chegada(gravados[6]!) - AGORA.getTime()) / 1000));
    expect(r.duracaoSeg).toBe(80); // 3,5 s + 2 s de "digitando" até a primeira chegar + 74 s de pausas, arredondado
  });

  it("pelo id do funil dá o mesmo resultado que pelo atalho", async () => {
    const m = repoEmMemoria();
    await agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, { conversationId: CONVERSA, usuarioId: USUARIO, funnelId: "funil-1" });
    expect(m.gravados).toHaveLength(7);
  });

  it("uma mensagem avulsa (modelo de áudio) vira um envio só, com gravando", async () => {
    const m = repoEmMemoria();
    const r = await agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, { conversationId: CONVERSA, usuarioId: USUARIO, templateId: "valores-2" });
    expect(r.partes).toBe(1);
    expect(m.gravados).toHaveLength(1);
    expect(m.gravados[0]).toMatchObject({ midiaId: "m-a1", presenca: "gravando" });
  });
});

describe("agendarSequencia: a trava", () => {
  it("com a trava fechada (modo simulado) grava `simulado`: nada vai ao WhatsApp e o operador é avisado do ensaio", async () => {
    const { promessa, gravados } = rodar({ modo: "simulado" });
    const r = await promessa;
    expect(gravados).toHaveLength(7);
    expect(gravados.every((g) => g.estado === "simulado")).toBe(true);
    expect(gravados[0]!.motivo).toMatch(/simulado/i);
    expect(r.modo).toBe("simulado");
  });

  it("modo real sem DISPARO_REAL_LIBERADO no servidor também é ensaio", async () => {
    const { promessa, gravados } = rodar({}, {});
    expect((await promessa).modo).toBe("simulado");
    expect(gravados.every((g) => g.estado === "simulado")).toBe(true);
  });

  it("allowlist (DISPARO_SO_PARA) que não inclui o contato: recusa, nada gravado", async () => {
    const m = rodar({}, { DISPARO_REAL_LIBERADO: "sim", DISPARO_SO_PARA: "+5511911112222" });
    const e = await erroDe(m.promessa);
    expect(e.codigo).toBe("allowlist");
    expect(m.gravados).toHaveLength(0);
  });
});

describe("agendarSequencia: recusa e não grava NADA", () => {
  const recusa = async (o: Opcoes, codigo: string, mensagem?: RegExp) => {
    const m = rodar(o);
    const e = await erroDe(m.promessa);
    expect(e.codigo).toBe(codigo);
    if (mensagem) expect(e.message).toMatch(mensagem);
    expect(m.gravados).toHaveLength(0);
    return e;
  };

  it("conversa sem lead aberto e sem como criar um", () => recusa({ lead: null, leadCriado: null }, "sem_lead"));
  it("contato bloqueado", () => recusa({ lead: { nome: "M", telefone: "+5511999990000", bloqueado: true } }, "sem_lead", /bloquead/i));
  it("contato anonimizado", () => recusa({ lead: { nome: "M", telefone: "+5511999990000", anonimizado: true } }, "sem_lead"));
  it("contato sem telefone", () => recusa({ lead: { nome: "M", telefone: null } }, "sem_lead", /telefone/i));
  it("conversa que não sai por chip do motor (avisa para cair no envio comum)", async () => {
    const e = await recusa({ chip: null }, "chip", /chip/i);
    expect(e.detalhes).toMatchObject({ sem_chip_do_motor: true });
  });
  it("chip pausado: respeita e avisa, não burla", () => recusa({ chip: chipVerde({ estado: "pausado" }) }, "chip", /pausado/i));
  it("chip desligado", () => recusa({ chip: chipVerde({ estado: "desligado" }) }, "chip", /desligado/i));
  it("chip com saúde vermelha", () => recusa({ chip: chipVerde({ saude: "vermelho", saudeMotivo: "queda de conexão" }) }, "chip", /vermelh/i));
  it("chip em pausa até um horário futuro (o do chip-gama)", async () => {
    const e = await recusa({ chip: chipVerde({ pausadoAte: new Date("2026-10-24T19:25:00Z") }) }, "chip", /pausa/i);
    expect(e.status).toBe(409);
  });
  it("sequência já em andamento para o lead (duplo clique)", () => recusa({ emAberto: 3 }, "ja_agendada", /em andamento|já/i));
  it("texto que o verificador barra: diz qual parte", () =>
    recusa({ proibidos: [{ motivo: "cita Anvisa", padrao: "recomendo" }] }, "modelo", /valores-5/));
  it("sequência que não existe", async () => {
    const m = repoEmMemoria();
    const e = await erroDe(agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, { ...pedido, atalho: "nao-existe" }));
    expect(e.codigo).toBe("sequencia");
  });
});

describe("cancelarSequencia", () => {
  it("cancela as mensagens ainda por sair da lead da conversa e devolve quantas", async () => {
    const m = repoEmMemoria();
    await agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, pedido);
    const r = await cancelarSequencia({ repo: m.repo }, ORG, { conversationId: CONVERSA });
    expect(r.canceladas).toBe(7);
    expect(m.cancelamentos[0]).toMatch(/operador/i);
  });

  it("conversa sem lead: erro claro", async () => {
    const m = repoEmMemoria({ lead: null });
    expect((await erroDe(cancelarSequencia({ repo: m.repo }, ORG, { conversationId: CONVERSA }))).codigo).toBe("sem_lead");
  });
});

describe("agendarSequencia: envio manual do operador só exige chip saudável", () => {
  const NOITE = new Date("2026-10-23T23:30:00-03:00");
  it("fora da janela de resposta (23h30) agenda mesmo assim", async () => {
    const m = repoEmMemoria();
    await agendarSequencia({ repo: m.repo, agora: NOITE, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, pedido);
    expect(m.gravados.length).toBe(7);
    expect(m.gravados.every((g) => g.estado === "pendente")).toBe(true);
  });

  it("com o motor desligado recusa e diz por quê (o motor só roda organização ligada: nada sairia)", async () => {
    const m = repoEmMemoria({ ligado: false });
    const e = await erroDe(agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, pedido));
    expect(e.codigo).toBe("motor_desligado");
    expect(m.gravados).toHaveLength(0);
  });

  it("sem chip do motor, permite fallback mesmo com motor desligado", async () => {
    const m = repoEmMemoria({ ligado: false, chip: null });
    const e = await erroDe(agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, pedido));
    expect(e).toMatchObject({ codigo: "chip", detalhes: { sem_chip_do_motor: true } });
    expect(m.gravados).toHaveLength(0);
  });

  it("conversa sem lead: cria o lead e agenda para ele", async () => {
    const m = repoEmMemoria({ lead: null, leadCriado: "lead-novo" });
    await agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, pedido);
    expect(m.leadsCriados).toEqual(["lead-novo"]);
    expect(m.gravados.every((g) => g.leadId === "lead-novo")).toBe(true);
  });
});

describe("agendarSequencia: a mesma sequência não sai duas vezes por engano", () => {
  const comUltimo = (ultima: Date | null, o: Opcoes = {}) => {
    const m = repoEmMemoria(o);
    const pedidos: { prefixo: string; desde: Date }[] = [];
    m.repo.ultimoEnvioDaSequencia = async (_org, _lead, prefixo, desde) => {
      pedidos.push({ prefixo, desde });
      return ultima;
    };
    return { ...m, pedidos };
  };

  it("a mesma sequência saiu para a lead há 1 h: recusa com `ja_enviada` (409), dizendo quando, e nada é gravado", async () => {
    const m = comUltimo(new Date(AGORA.getTime() - 3600_000));
    const e = await erroDe(agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, pedido));
    expect(e.codigo).toBe("ja_enviada");
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/23\/10/);
    expect(e.detalhes).toMatchObject({ ultima_em: new Date(AGORA.getTime() - 3600_000).toISOString() });
    expect(m.gravados).toEqual([]);
    expect(m.pedidos[0]).toMatchObject({ prefixo: "funil_valores", desde: new Date(AGORA.getTime() - 24 * 3600_000) });
  });

  it("com a confirmação explícita do operador, agenda de novo", async () => {
    const m = comUltimo(new Date(AGORA.getTime() - 3600_000));
    await agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, { ...pedido, confirmar: true });
    expect(m.gravados).toHaveLength(7);
  });

  it("irmão: nada saiu nas últimas 24 h, agenda", async () => {
    const m = comUltimo(null);
    await agendarSequencia({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE_REAL, sortear: () => 0.5 }, ORG, pedido);
    expect(m.gravados).toHaveLength(7);
  });
});
