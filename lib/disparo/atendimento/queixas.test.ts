/**
 * Respostas às opções de queixa (retomada): a abertura do braço A do teste A/B pergunta o que
 * mais incomoda (atrasos, custos, suporte, prazos) e a lead responde com uma palavra. Antes disto, "atrasos" caía
 * em "não consegui ler" (operador), "nada não" virava recusa (e a oferta do Método) e "integracao" ia ao desvio sem
 * resposta. Agora a casa declara `queixas` (gatilho → resposta), e a decisão responde UMA vez, só no braço A, só
 * antes da tabela. Preço, escolha de kit e "quero fechar" vencem a queixa; parada dura vence tudo.
 * Textos fictícios: os da casa vivem no banco.
 */
import { describe, expect, it } from "vitest";

import { CONFIG_METODO_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { atendimentoSchema, conferirReferencias, errosDaConfig, type ConfigAtendimento } from "./config";
import { criarJulgar } from "./jev";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-10-14T13:00:00Z"); // quarta, 10h em São Paulo

const QUEIXAS = [
  { id: "integracao", gatilho: "integracao|produto|integr|a integracao", resposta: "queixa_integracao", operador: true, motivo: "perguntou da integração" },
  { id: "nada", gatilho: "^(nada|nenhum[a]?|nenhuma delas|nao tenho (nada|nenhum)|nada nao|nada nao.{0,40})$", resposta: "queixa_nada" },
  { id: "atrasos", gatilho: "\\batraso", resposta: "queixa_atrasos" },
  { id: "custos", gatilho: "\\bcusto|gasto(s)? alto(s)?", resposta: "queixa_custos" },
  { id: "suporte", gatilho: "\\bsuporte|atendiment", resposta: "queixa_suporte" },
  { id: "prazos", gatilho: "\\bprazo", resposta: "queixa_prazos" },
];

const RESPOSTAS_QUEIXA = {
  queixa_integracao: [[{ texto: "Sobre a integração eu mesma te explico agora." }]],
  queixa_nada: [[{ texto: "Que bom{virg_nome}! Fico por aqui se precisar." }]],
  queixa_atrasos: [[{ texto: "Atraso é o que mais me perguntam. Posso te mandar os valores?" }]],
  queixa_custos: [[{ texto: "O custo se paga rápido. Posso te mandar os valores?" }]],
  queixa_suporte: [[{ texto: "Suporte melhora com o tempo. Posso te mandar os valores?" }]],
  queixa_prazos: [[{ texto: "Prazo tem cuidado próprio. Posso te mandar os valores?" }]],
};

const base = CONFIG_METODO_EXEMPLO as Extract<ConfigAtendimento, { perfil: "venda" }>;
const CONFIG_QUEIXAS = atendimentoSchema.parse({ ...base, respostas: { ...base.respostas, ...RESPOSTAS_QUEIXA }, queixas: QUEIXAS });

const BRACO_A = { classe: "frio", trilha: "morna", ab_teste: "1211", ab_braco: "A", ab_grupo: "frio" };

let n = 0;
function cenario(campos: Record<string, unknown> = BRACO_A, config: ConfigAtendimento = CONFIG_QUEIXAS) {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), config);
  const lead = repo.novoLead(`lead-q${++n}`, { campos });
  repo.chipPorLead.set(lead.id, "chip-ensaio");
  repo.operadorFalou.add(lead.id);
  const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }), sortear: () => 0.5 };
  const diz = (texto: string) => atenderMensagem(deps, ORG, lead.id, { chave: `m${++n}`, messageId: null, texto, midia: false, conversationId: "conv-1" });
  const tipos = () => repo.enviosDo(lead.id).map((e) => e.tipo);
  const queixasEnviadas = () => tipos().filter((t) => t.startsWith("queixa_"));
  return { repo, lead, diz, tipos, queixasEnviadas, conversa: () => repo.conversas.get(lead.id)! };
}

describe("queixas: cada opção recebe a sua resposta, uma vez", () => {
  it.each([
    ["atrasos", "atrasos", "queixa_atrasos"],
    ["Custos", "custos", "queixa_custos"],
    ["os gastos altos", "custos", "queixa_custos"],
    ["suporte", "suporte", "queixa_suporte"],
    ["prazos", "prazos", "queixa_prazos"],
  ])("'%s' no braço A responde %s", async (texto, id, resposta) => {
    const c = cenario();
    const r = await c.diz(texto);
    expect(r.resultado).toBe("decidida");
    expect(c.queixasEnviadas()).toEqual([resposta]);
    expect(c.tipos().some((t) => t.startsWith("tabela"))).toBe(false);
    expect(c.conversa().dados.queixa).toBe(id);
    expect(c.conversa().etapa).toBe("qualificando");
    expect(c.conversa().precisaOperador).toBe(false);
    // Queixa não é objeção: não gasta o limite de objeções.
    expect(c.conversa().dados.objecoesRespondidas).toEqual([]);
  });

  it("a segunda queixa não recebe resposta de queixa de novo", async () => {
    const c = cenario();
    await c.diz("atrasos");
    await c.diz("custos também");
    expect(c.queixasEnviadas()).toEqual(["queixa_atrasos"]);
    expect(c.conversa().dados.queixa).toBe("atrasos");
  });

  it("'sim' depois da queixa segue o caminho de sempre: explicação e tabela", async () => {
    const c = cenario();
    await c.diz("atrasos");
    await c.diz("sim, pode me contar");
    expect(c.tipos().some((t) => t.startsWith("explicacao"))).toBe(true);
    expect(c.tipos().some((t) => t.startsWith("tabela"))).toBe(true);
  });
});

describe("queixas: precedências", () => {
  it("'Nada não, obrigada' no braço A responde queixa_nada e NÃO oferece o Método nem encerra", async () => {
    const c = cenario();
    await c.diz("Nada não, obrigada");
    expect(c.queixasEnviadas()).toEqual(["queixa_nada"]);
    expect(c.tipos().some((t) => t.startsWith("metodo_oferta"))).toBe(false);
    expect(c.conversa().dados.metodo.oferecido).toBe(false);
    expect(c.conversa().etapa).toBe("qualificando");
  });

  it("'não quero, pare' segue parada dura: encerra e nada sai", async () => {
    const c = cenario();
    await c.diz("não quero, pare de me mandar mensagem");
    expect(c.tipos()).toHaveLength(0);
    expect(c.conversa().etapa).toBe("nao_contatar");
  });

  it("'e a integração?' responde e passa ao operador (antes do desvio da casa)", async () => {
    const c = cenario();
    await c.diz("e a integração?");
    expect(c.queixasEnviadas()).toEqual(["queixa_integracao"]);
    expect(c.conversa().precisaOperador).toBe(true);
    expect(c.conversa().motivoOperador).toBe("perguntou da integração");
    expect(c.repo.avisos.some((a) => a.nivel === "operador")).toBe(true);
    expect(c.conversa().dados.queixa).toBe("integracao");
  });

  it("'atrasos, quanto custa?' vai para o preço: a tabela vence a queixa", async () => {
    const c = cenario();
    await c.diz("atrasos, quanto custa?");
    expect(c.queixasEnviadas()).toEqual([]);
    expect(c.tipos().some((t) => t.startsWith("tabela"))).toBe(true);
    expect(c.conversa().dados.queixa).toBeNull();
  });

  it("escolher o kit vence a queixa", async () => {
    const c = cenario();
    await c.diz("quero o de 12 meses pra mancha");
    expect(c.queixasEnviadas()).toEqual([]);
    expect(c.conversa().etapa).toBe("pronto_fechar");
  });

  it("braço B não usa queixa", async () => {
    const c = cenario({ ...BRACO_A, ab_braco: "B" });
    await c.diz("atrasos");
    expect(c.queixasEnviadas()).toEqual([]);
    expect(c.conversa().dados.queixa).toBeNull();
  });

  it("lead fora do teste não usa queixa", async () => {
    const c = cenario({ classe: "frio", trilha: "morna" });
    await c.diz("atrasos");
    expect(c.queixasEnviadas()).toEqual([]);
  });

  it("quem já viu a tabela não usa queixa", async () => {
    const c = cenario();
    await c.diz("quanto custa?");
    await c.diz("atrasos");
    expect(c.queixasEnviadas()).toEqual([]);
    expect(c.conversa().dados.queixa).toBeNull();
  });

  it("queixa com relato de saúde vai ao operador sem resposta automática", async () => {
    const c = cenario();
    await c.diz("atrasos, mas estou grávida");
    expect(c.queixasEnviadas()).toEqual([]);
    expect(c.conversa().precisaOperador).toBe(true);
  });

  it("config sem queixas: tudo como antes (atrasos vai ao operador)", async () => {
    const c = cenario(BRACO_A, CONFIG_METODO_EXEMPLO);
    await c.diz("atrasos");
    expect(c.queixasEnviadas()).toEqual([]);
    expect(c.conversa().precisaOperador).toBe(true);
  });
});

describe("queixas: conferência da config", () => {
  it("a config de exemplo passa sem erro", () => {
    expect(errosDaConfig(CONFIG_QUEIXAS)).toEqual([]);
  });

  it("resposta inexistente, gatilho que não compila e id repetido são erro", () => {
    const ruim = atendimentoSchema.parse({
      ...CONFIG_QUEIXAS,
      queixas: [
        { id: "atrasos", gatilho: "\\batraso", resposta: "nao_existe" },
        { id: "custos", gatilho: "(", resposta: "queixa_custos" },
        { id: "custos", gatilho: "custo", resposta: "queixa_custos" },
      ],
    });
    const erros = conferirReferencias(ruim);
    expect(erros.some((e) => /queixas\.atrasos.*nao_existe/.test(e))).toBe(true);
    expect(erros.some((e) => /queixas\.custos: gatilho não compila/.test(e))).toBe(true);
    expect(erros.some((e) => /queixas: id repetido/.test(e))).toBe(true);
  });

  it("config antiga, sem a chave, lê queixas vazio", () => {
    const c = atendimentoSchema.parse(CONFIG_METODO_EXEMPLO) as Extract<ConfigAtendimento, { perfil: "venda" }>;
    expect(c.queixas).toEqual([]);
  });
});
