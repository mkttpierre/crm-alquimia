/**
 * D5 (desconto/piso de preço) e D4 (pontos de parada), no atendimento inteiro contra
 * o repositório em memória, sem Jev e com a trava fechada.
 */
import { describe, expect, it } from "vitest";

import { lerMensagem, pedeDesconto } from "../leitura";
import { CONFIG_PROSPECCAO_EXEMPLO, CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { atendimentoSchema, errosDaConfig, type ConfigAtendimento } from "./config";
import { criarJulgar } from "./jev";
import { avisoDoPonto, motivoForaDaTabela, pontosAcionados, valoresDoTexto } from "./parada";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-10-14T13:00:00Z");

const PARADA = {
  celular: "5511999990000",
  aviso: "Respondeu {titulo}\nNome: {nome}\nWhatsApp: {telefone}",
  pontos: [
    { id: "kit", evento: "escolheu_kit", titulo: "KIT", etapa: "pronto_fechar", tag: "pronto-pra-fechar" },
    { id: "fechar", evento: "quer_fechar", titulo: "FECHAR", tag: "pronto-pra-fechar" },
    { id: "site", evento: "pediu_site", titulo: "SITE", tag: "pediu-site" },
    { id: "desconto", evento: "pede_desconto", titulo: "DESCONTO", tag: "negociar" },
    { id: "limite", evento: "excedeu_limite", titulo: "LIMITE" },
    { id: "endereco", padrao: "\\bcep\\b|\\brua\\b|\\bavenida\\b", titulo: "ENDERECO", tag: "deu-endereco" },
  ],
};

function comParada(base: ConfigAtendimento, parada: unknown = PARADA): ConfigAtendimento {
  return atendimentoSchema.parse({ ...base, parada });
}

let n = 0;
function cenario(config: ConfigAtendimento = comParada(CONFIG_VENDA_EXEMPLO), modo: "simulado" | "real" = "simulado") {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, modo), config);
  const lead = repo.novoLead(`lead-p${++n}`);
  repo.chipPorLead.set(lead.id, "chip");
  const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) };
  const diz = (texto: string | null, conversationId: string | null = "conv-1") =>
    atenderMensagem(deps, ORG, lead.id, { chave: `p${++n}`, messageId: null, texto, midia: false, conversationId });
  return { repo, lead, diz, conversa: () => repo.conversas.get(lead.id)! };
}

describe("D5: pedido de desconto é do operador", () => {
  const PEDIDOS = [
    "tem desconto?",
    "faz mais barato pra mim?",
    "tem cupom?",
    "consegue fazer por 500?",
    "dá pra fazer um precinho melhor?",
    "vamos negociar o valor",
    "qual o último preço?",
    "tem desconto no pix?",
    "fecho o de 12 meses se fizer por 800",
    "pode baixar o valor?",
  ];
  it.each(PEDIDOS)("a leitura por regras vê desconto: %s", (t) => {
    expect(pedeDesconto(t)).toBe(true);
    expect(lerMensagem(t).intencao).toBe("pede_desconto");
  });

  it.each(["quanto custa?", "achei caro", "tem mais barato?", "quero o de 12 meses", "quero comprar", "qual o valor do frete?", "aceita pix?", "parcela em quantas vezes?"])(
    "não confunde com desconto: %s",
    (t) => expect(pedeDesconto(t)).toBe(false),
  );

  it("nada sai, ninguém desce a escada, o operador é avisado e o atendimento para", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("Quanto custa?");
    const antes = repo.enviosDo(lead.id).length;
    repo.operadorFalou.add(lead.id); // zera as automáticas seguidas: o limite não é o motivo
    const r = await diz("faz mais barato pra mim?");
    expect(repo.enviosDo(lead.id)).toHaveLength(antes);
    expect(conversa().dados.degrau).toBe(0);
    expect(conversa().precisaOperador).toBe(true);
    expect(r.resumo).toContain("pro operador (pediu desconto");
    expect(repo.avisos.some((a) => a.titulo.includes("pediu desconto"))).toBe(true);
    // ponto de parada "desconto": pausa a conversa, etiqueta e avisa o celular
    expect(repo.paradas).toHaveLength(1);
    expect(repo.tags).toEqual([{ leadId: lead.id, tag: "negociar" }]);
    expect(repo.avisosAoCelular).toHaveLength(1);
    expect(repo.avisosAoCelular[0]!.texto).toBe("Respondeu DESCONTO\nNome: Maria Silva\nWhatsApp: 5511900000000");
    expect(repo.avisosAoCelular[0]!.destino).toBe("5511999990000");
  });

  it("vale mesmo sem nenhum ponto configurado (o piso é do código, não da config)", async () => {
    const { repo, lead, diz } = cenario(CONFIG_VENDA_EXEMPLO);
    const r = await diz("tem desconto?");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(r.resumo).toContain("pro operador");
    expect(repo.avisos).toHaveLength(1);
    expect(repo.paradas).toHaveLength(0);
  });

  it("vale quando o lead escolhe kit E pede desconto: não vira compra", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("fecho o de 12 meses se fizer por 800");
    expect(repo.avisos.filter((a) => a.nivel === "compra")).toHaveLength(0);
    expect(conversa().etapa).not.toBe("pronto_fechar");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });
});

describe("D5: nenhum texto automático cita valor fora da tabela", () => {
  const kits = CONFIG_VENDA_EXEMPLO.perfil === "venda" ? CONFIG_VENDA_EXEMPLO.kits : [];

  it("valoresDoTexto lê R$ e parcelas", () => {
    expect(valoresDoTexto("R$897,00 à vista e 12x 92,77 no cartão; R$ 1.200 e R$50")).toEqual([89700, 120000, 5000, 9277]);
  });
  it("valor da tabela passa; valor fora, não", () => {
    expect(motivoForaDaTabela("12 meses: R$ 900", kits)).toBeNull();
    expect(motivoForaDaTabela("por R$ 800 eu fecho", kits)).toContain("valor fora da tabela: 800,00");
    expect(motivoForaDaTabela("sem nenhum valor", kits)).toBeNull();
  });
  it("palavras de desconto são barradas no texto", () => {
    for (const t of ["tenho um desconto pra você", "uso o cupom X", "preço especial hoje", "último preço"]) {
      expect(motivoForaDaTabela(t, kits), t).toContain("desconto");
    }
  });
  it("resposta da config com valor fora da tabela é barrada e vai para o operador (piso em código)", async () => {
    const ruim = atendimentoSchema.parse({
      ...CONFIG_VENDA_EXEMPLO,
      respostas: { ...CONFIG_VENDA_EXEMPLO.respostas, tabela: [[{ texto: "Faço o de 12 meses por R$ 600 só pra você" }]] },
    });
    const { repo, lead, diz } = cenario(ruim);
    const r = await diz("Quanto custa?");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(r.resumo).toContain("valor fora da tabela");
  });
  it("a tabela da casa (valores dos kits) sai normalmente", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quanto custa?");
    expect(repo.enviosDo(lead.id).length).toBeGreaterThan(0);
  });
});

describe("D4: pontos de parada", () => {
  it("pontosAcionados casa por evento e por padrão (texto normalizado)", () => {
    const parada = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, parada: PARADA }).parada;
    expect(pontosAcionados(parada, ["pediu_site"], "oi").map((p) => p.id)).toEqual(["site"]);
    expect(pontosAcionados(parada, [], "Moro na Rua das Flores, 10").map((p) => p.id)).toEqual(["endereco"]);
    expect(pontosAcionados(parada, [], "oi tudo bem")).toEqual([]);
  });

  it("avisoDoPonto usa o formato da casa", () => {
    const parada = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, parada: { ...PARADA, aviso: "🌸Respondeu {titulo}🌸\n✅ MARCA A ✅\nNome: {nome}\nWhatsApp: {telefone}" } }).parada;
    const lead = { id: "l", nome: "Ana", telefone: "5511911112222", campos: {} };
    expect(avisoDoPonto(parada, parada.pontos[0]!, lead, "x")).toBe("🌸Respondeu KIT🌸\n✅ MARCA A ✅\nNome: Ana\nWhatsApp: 5511911112222");
  });

  it("escolheu o kit: pacote de fechamento sai, o card vai para a etapa, tag, celular e a conversa PARA", async () => {
    const { repo, lead, diz } = cenario();
    const r = await diz("quero o de 9 meses");
    expect(r.resumo).toContain("parada: kit");
    expect(repo.enviosDo(lead.id).length).toBeGreaterThan(0); // o pacote de fechamento da mesma decisão
    expect(repo.paradas).toEqual([expect.objectContaining({ leadId: lead.id, conversationId: "conv-1" })]);
    expect(repo.movimentosDeParada).toEqual([{ leadId: lead.id, pipeline: null, etapa: "pronto_fechar", pontoId: "kit" }]);
    expect(repo.tags).toEqual([{ leadId: lead.id, tag: "pronto-pra-fechar" }]);
    expect(repo.avisosAoCelular).toHaveLength(1);
    // o aviso de compra da decisão já abriu a Central: não abre um segundo
    expect(repo.avisos).toHaveLength(1);
    expect(repo.avisos[0]!.nivel).toBe("compra");
  });

  it("depois de parar, nova mensagem do lead só é registrada (a pausa é a mesma do pause-ai)", async () => {
    const { repo, lead, diz } = cenario();
    await diz("quero o de 9 meses");
    const envios = repo.enviosDo(lead.id).length;
    const r = await diz("obrigada!");
    expect(r.resultado).toBe("registrada");
    expect(r.resumo).toContain("humano no comando");
    expect(repo.enviosDo(lead.id)).toHaveLength(envios);
    // o operador devolve (reactivate-bot): o atendimento volta a olhar a mensagem
    repo.conversasDoLead.delete(lead.id);
    expect((await diz("e o prazo de entrega?")).resultado).toBe("decidida");
  });

  it("pediu o site: links saem, para e avisa", async () => {
    const { repo, diz } = cenario();
    await diz("quero o de 9 meses"); // define o kit
    const outro = cenario();
    await outro.diz("me manda o link do site do de 7 meses");
    expect(outro.repo.paradas).toHaveLength(1);
    expect(outro.repo.tags[0]!.tag).toBe("pediu-site");
    expect(repo.paradas).toHaveLength(1);
  });

  it("deu o endereço (padrão de texto): para e etiqueta, mesmo sem evento", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quanto custa?");
    repo.operadorFalou.add(lead.id);
    await diz("minha rua é a Rua das Flores");
    expect(repo.tags.map((t) => t.tag)).toContain("deu-endereco");
    expect(repo.paradas).toHaveLength(1);
    // a decisão foi operador (sem aviso de compra): o ponto abriu o aviso na Central
    expect(repo.avisos.length).toBeGreaterThan(0);
  });

  it("excedeu as respostas automáticas seguidas: para e avisa", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quanto custa?");
    await diz("e a entrega, quanto tempo leva?");
    const antes = repo.paradas.length;
    await diz("vou pensar"); // 3ª automática seguida (limite do ritmo padrão = 2)
    expect(repo.paradas.length).toBeGreaterThan(antes);
    expect(repo.enviosDo(lead.id).length).toBeGreaterThan(0);
  });

  it("em simulado o aviso ao celular só é registrado; o lead nunca recebe o aviso", async () => {
    const { repo, lead, diz } = cenario();
    await diz("tem cupom?");
    expect(repo.avisosAoCelular[0]!.modo).toBe("simulado");
    expect(repo.enviosDo(lead.id).some((e) => e.texto.includes("Respondeu"))).toBe(false);
  });

  it("sem celular configurado não notifica, mas para e avisa a Central", async () => {
    const { repo, diz } = cenario(comParada(CONFIG_VENDA_EXEMPLO, { ...PARADA, celular: null, pontos: PARADA.pontos.map((p) => ({ ...p, notificar: false })) }));
    await diz("tem cupom?");
    expect(repo.avisosAoCelular).toHaveLength(0);
    expect(repo.paradas).toHaveLength(1);
    expect(repo.avisos.length).toBeGreaterThan(0);
  });

  it("falha de um efeito não derruba os outros (card não moveu, aviso ao celular sai)", async () => {
    const { repo, diz } = cenario();
    repo.funilResponde = "conflito_humano";
    await diz("quero o de 9 meses");
    expect(repo.avisosAoCelular).toHaveLength(1);
    expect(repo.paradas).toHaveLength(1);
  });

  it("prospecção: horário combinado para a conversa e avisa", async () => {
    const cfg = comParada(CONFIG_PROSPECCAO_EXEMPLO, { celular: "5511999990000", pontos: [{ id: "reuniao", evento: "horario", titulo: "REUNIAO", tag: "agendar" }] });
    const { repo, diz } = cenario(cfg);
    await diz("pode ser quinta às 15h");
    expect(repo.paradas).toHaveLength(1);
    expect(repo.tags[0]!.tag).toBe("agendar");
  });
});

describe("D4: validação da config", () => {
  it("ponto sem gatilho, pipeline sem etapa e notificar sem celular são recusados", () => {
    expect(atendimentoSchema.safeParse({ ...CONFIG_VENDA_EXEMPLO, parada: { pontos: [{ id: "xx", titulo: "X" }] } }).success).toBe(false);
    expect(atendimentoSchema.safeParse({ ...CONFIG_VENDA_EXEMPLO, parada: { pontos: [{ id: "xx", titulo: "X", evento: "pediu_site", pipeline: "outro" }] } }).success).toBe(false);
    const semCelular = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, parada: { pontos: [{ id: "xx", titulo: "X", evento: "pediu_site" }] } });
    expect(errosDaConfig(semCelular)).toContain("parada: ponto manda notificar, mas parada.celular não está configurado");
  });
  it("evento que ninguém emite é recusado; sem `parada` a config segue válida (padrão vazio)", () => {
    expect(atendimentoSchema.safeParse({ ...CONFIG_VENDA_EXEMPLO, parada: { pontos: [{ id: "xx", titulo: "X", evento: "inventado" }] } }).success).toBe(false);
    expect(errosDaConfig(CONFIG_VENDA_EXEMPLO)).toEqual([]);
  });
});
