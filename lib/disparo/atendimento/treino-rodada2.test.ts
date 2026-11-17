// @vitest-environment node
import { describe, expect, it } from "vitest";
import { atendimentoSchema } from "./config";
import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { criarJulgar } from "./jev";

const ORG = "33333333-3333-4333-8333-333333333333";
let seq = 0;
function cenario(opcoes: { cliente?: boolean; extra?: boolean } = {}) {
  const respostas = opcoes.extra ? { saudacao: [[{ texto: "Olá! Como posso ajudar?" }]], pagamento: [[{ texto: "Pagamento por Pix ou cartão." }]] } : {};
  const config = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, respostas: { ...CONFIG_VENDA_EXEMPLO.respostas, ...respostas }, objecoes: [...CONFIG_VENDA_EXEMPLO.objecoes, { id: "outro_produto", gatilho: "ja (estou usando|uso|tomo) um", jev: "outro produto", pergunta: "Outro produto?" }, { id: "boleto", gatilho: "boleto", jev: "boleto", pergunta: "Boleto." }] });
  const disparo = configDisparoExemplo(ORG); disparo.ritmo.limiteAutomaticasSeguidas = 10;
  const repo = new RepositorioEmMemoria(ORG, disparo, config);
  const lead = repo.novoLead(`treino-${++seq}`, { campos: opcoes.cliente ? { classe: "P1" } : {} });
  repo.chipPorLead.set(lead.id, "chip");
  const deps = { repo, agora: new Date("2026-10-26T14:00:00Z"), ambiente: {}, julgar: criarJulgar({ chave: null }) };
  const diz = async (texto: string) => { const antes = repo.envios.length; await atenderMensagem(deps, ORG, lead.id, { chave: `t-${++seq}`, messageId: null, texto, midia: false }); return repo.envios.slice(antes).map(x => x.tipo); };
  return { repo, lead, diz };
}

describe("treino de atendimento", () => {
  it("cliente identificado por classe falando de uso próprio recebe reposição, não objeção de outro produto", async () => {
    const c = cenario({ cliente: true });
    expect(await c.diz("já estou usando um bom tempo")).toContain("reposicao");
  });
  it("aceite antes dos preços conduz cliente antigo ao funil, sem perguntar kit", async () => {
    const c = cenario({ cliente: true }); const tipos = await c.diz("quero sim");
    expect(tipos.some(t => t.startsWith("tabela"))).toBe(true);
    expect(tipos).not.toContain("pergunta_kit");
    expect(tipos).not.toContain("explicacao");
  });
  it("aceite curto depois da tabela pergunta o kit", async () => {
    const c = cenario(); await c.diz("quanto custa?");
    expect(await c.diz("ok")).toContain("pergunta_kit");
  });
  it("saudação usa peça opcional só uma vez e depois vai ao operador", async () => {
    const c = cenario({ extra: true }); expect(await c.diz("boa tarde tudo bem?")).toContain("saudacao");
    expect(await c.diz("olá")).toEqual([]);
    expect(c.repo.avisos.some(a => a.nivel === "operador")).toBe(true);
  });
  it("sem peça, saudação vai ao operador", async () => {
    const c = cenario(); expect(await c.diz("oi")).toEqual([]);
    expect(c.repo.avisos.some(a => a.nivel === "operador")).toBe(true);
  });
  it("pagamento usa peça opcional; objeção configurada tem preferência", async () => {
    const a = cenario({ extra: true }); expect(await a.diz("aceita débito?")).toContain("pagamento");
    const b = cenario({ extra: true }); expect(await b.diz("aceita boleto?")).toContain("obj_boleto");
  });
  it("pagamento sem peça nem objeção vai ao operador", async () => {
    const c = cenario(); expect(await c.diz("aceita débito?")).toEqual([]);
    expect(c.repo.avisos.some(a => a.nivel === "operador")).toBe(true);
  });
});

it("emoji positivo depois da explicação e tabela pergunta o kit", async () => {
  const c = cenario(); await c.diz("quero saber mais");
  expect(await c.diz("👍")).toContain("pergunta_kit");
});

it("saudação com pergunta de preço segue para valores", async () => {
  const c = cenario({ extra: true });
  const tipos = await c.diz("boa tarde, quanto custa?");
  expect(tipos.some(t => t.startsWith("tabela"))).toBe(true);
  expect(tipos).not.toContain("saudacao");
});

it("bom dia com pergunta de cortesia é saudação e não elogio do produto", async () => {
  const c = cenario({ extra: true }); expect(await c.diz("bom dia, tudo bem?")).toContain("saudacao");
});

it("objeção de pagamento repetida é encaminhada, sem repetir outra peça", async () => {
  const c = cenario({ extra: true });
  expect(await c.diz("aceita boleto?")).toContain("obj_boleto");
  expect(await c.diz("aceita boleto?")).toEqual([]);
  expect(c.repo.avisos.some(a => a.nivel === "operador")).toBe(true);
});
