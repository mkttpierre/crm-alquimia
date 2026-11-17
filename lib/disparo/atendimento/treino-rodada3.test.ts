// @vitest-environment node
import { describe, expect, it } from "vitest";
import { atendimentoSchema } from "./config";
import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { criarJulgar } from "./jev";
import { kitDoTexto, lerMensagem } from "../leitura";

const ORG = "44444444-4444-4444-8444-444444444444";
let seq = 0;
function cenario() {
  const config = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO });
  const disparo = configDisparoExemplo(ORG);
  disparo.ritmo.limiteAutomaticasSeguidas = 10;
  const repo = new RepositorioEmMemoria(ORG, disparo, config);
  const lead = repo.novoLead(`r3-${++seq}`, {});
  repo.chipPorLead.set(lead.id, "chip");
  const deps = { repo, agora: new Date("2026-10-26T14:00:00Z"), ambiente: {}, julgar: criarJulgar({ chave: null }) };
  const diz = async (texto: string) => {
    const antes = repo.envios.length;
    await atenderMensagem(deps, ORG, lead.id, { chave: `t-${++seq}`, messageId: null, texto, midia: false });
    return repo.envios.slice(antes).map((x) => x.tipo);
  };
  const etapa = () => repo.conversas.get(lead.id)?.etapa;
  const avisou = (nivel: string) => repo.avisos.some((a) => a.nivel === nivel);
  return { repo, lead, diz, etapa, avisou };
}

describe("saúde não coberta vai ao operador antes de interesse, preço e funil", () => {
  const frases = [
    "tenho tireoide e tomo puran, interfere?",
    "estou gravida posso tomar?",
    "to amamentando, pode?",
    "sou gestante",
    "tomo remedio pra pressao baixa, posso tomar junto?",
    "uso medicamento controlado, tem problema?",
    "tenho alergia a corante, serve pra mim?",
    "fiz cirurgia semana passada, posso usar?",
    "tomo anticoagulante, pode misturar?",
    "tenho problema no rim, posso tomar?",
    "tive cancer, pode tomar?",
    "tenho problema no figado",
    "dá algum efeito colateral?",
  ];
  for (const f of frases) {
    it(`"${f}" não recebe texto automático e avisa o operador (abertura)`, async () => {
      const c = cenario();
      expect(await c.diz(f)).toEqual([]);
      expect(c.avisou("operador")).toBe(true);
    });
  }
  it("depois da tabela também", async () => {
    const c = cenario();
    await c.diz("quanto custa?");
    expect(await c.diz("tenho tireoide e tomo puran, interfere?")).toEqual([]);
    expect(c.avisou("operador")).toBe(true);
  });
  it("pergunta de produto 'isso é remédio?' não é relato de saúde", async () => {
    const c = cenario();
    expect((await c.diz("quero saber mais, isso é remédio?")).length).toBeGreaterThan(0);
  });
  it("objeção configurada de saúde continua vencendo", async () => {
    const c = cenario();
    expect((await c.diz("sou hipertensa, posso tomar?")).some((t) => t.startsWith("obj_saude"))).toBe(true);
  });
  it("escolha de kit junto com saúde registra e avisa a compra", async () => {
    const c = cenario();
    await c.diz("quanto custa?");
    await c.diz("quero o de 9 mas estou gravida, posso?");
    expect(c.avisou("compra")).toBe(true);
    expect(c.etapa()).toBe("pronto_fechar");
  });
});

describe("recusa encerra", () => {
  const recusas = [
    "Eu tenho ainda obrigada",
    "Não interesso muito obrigad",
    "Boa tarde hoje não brigado",
    "Não vou investir neste momento",
    "Não. Obrigada",
    "Infelizmente",
    "Não  quero  esse  produto.",
    "Agora ñ.",
    "agora nao obrigada",
    "nao tenho interesse",
    "ja tenho",
    "nao quero mais",
    "nao obrigado",
    "não me interessa",
    "pode tirar meu número",
  ];
  for (const f of recusas) {
    it(`"${f}" é recusa`, () => {
      expect(["nao_quer_mais", "parada"]).toContain(lerMensagem(f).intencao);
    });
  }
  const adiamentos = ["nao quero agora, so mes que vem", "agora não consigo, meu cartão vira dia 15", "não vou comprar agora, só no mês que vem", "agora nao, depois eu vejo", "infelizmente estou sem dinheiro, só mês que vem", "já tenho interesse, quanto custa?"];
  for (const f of adiamentos) {
    it(`"${f}" não é recusa`, () => {
      expect(["nao_quer_mais", "parada"]).not.toContain(lerMensagem(f).intencao);
    });
  }
  it("recusa seca encerra a conversa, sem texto nem aviso ao operador", async () => {
    const c = cenario();
    expect(await c.diz("Agora ñ.")).toEqual([]);
    expect(c.etapa()).toBe("perdido");
    expect(c.avisou("operador")).toBe(false);
  });
});

describe("escolha de kit", () => {
  const escolhas: [string, string][] = [
    ["o de 9", "9 meses"],
    ["quero 5 potes", "5 frascos"],
    ["manda o maior", "12 meses"],
    ["manda o kit maior", "12 meses"],
    ["vou levar o de 12", "12 meses"],
    ["fico com o de 7 meses", "7 meses"],
    ["o de nove", "9 meses"],
    ["quero o de doze", "12 meses"],
    ["pode ser o de doze msm", "12 meses"],
    ["vou levar 2", "2 meses"],
    ["3 poti", "3 frascos"],
    ["Bom dia! Eu gostaria de adquirir 3 meses de tratamento", "3 meses"],
    ["vai ser o de cinco", "5 meses"],
  ];
  for (const [f, kit] of escolhas) {
    it(`"${f}" escolhe ${kit}`, () => {
      const l = lerMensagem(f);
      expect(l.intencao).toBe("escolheu_kit");
      expect(l.kit).toBe(kit);
    });
  }
  const naoEscolhas = ["o de 9 custa 697 né? ainda vou pensar", "quanto custa o de 12?", "queria saber o valor do de 7 meses", "chega em 5 dias?", "tenho 2 filhos", "volto em 2 horas"];
  for (const f of naoEscolhas) {
    it(`"${f}" não é escolha de kit`, () => {
      expect(lerMensagem(f).intencao).not.toBe("escolheu_kit");
    });
  }
  it("kitDoTexto não confunde horas e dias com meses", () => {
    expect(kitDoTexto("chega em 5 dias")).toBeNull();
    expect(kitDoTexto("volto em 2 horas")).toBeNull();
  });
  it("kit com pedido de desconto continua indo ao operador sem virar compra (regra D5)", async () => {
    const c = cenario();
    await c.diz("quanto custa?");
    expect(await c.diz("quero 5, faz desconto?")).toEqual([]);
    expect(c.avisou("operador")).toBe(true);
    expect(c.avisou("compra")).toBe(false);
  });
  it("'tomo um comprimido' não é kit", () => {
    expect(kitDoTexto("Tomo um comprimido a noite, o sérum faço uso tbm")).toBeNull();
  });
  it("escolha por extenso depois da pergunta do kit avisa a compra", async () => {
    const c = cenario();
    await c.diz("quanto custa?");
    await c.diz("ok");
    await c.diz("pode ser o de doze msm");
    expect(c.avisou("compra")).toBe(true);
  });
});
