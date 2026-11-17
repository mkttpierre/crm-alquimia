/**
 * Oferta de Entrada (downsell) e follow-up de 7 toques do kit, no atendimento de uma organização.
 * Tudo EM MEMÓRIA, trava fechada, sem Jev: nada fala com banco, canal ou pagamento.
 */
import { describe, expect, it, vi } from "vitest";

import { TIPO_OFERTA_DO_METODO, TIPO_TOQUE_DO_KIT } from "../kit-followup";
import { CELULAR_DO_OPERADOR, CONFIG_METODO_EXEMPLO, CONFIG_VENDA_EXEMPLO, configDisparoExemplo, METODO_EXEMPLO, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { atendimentoSchema, conferirReferencias, errosDaConfig, lerConfigAtendimento } from "./config";
import { conversaNova, lerDados } from "./estado";
import { criarJulgar, type Julgar } from "./jev";
import { confirmarPagamentoMetodo } from "./metodo";
import { motivoForaDaTabela } from "./parada";
import { escolhaDoMetodo } from "./venda";
import { normalizar } from "../leitura";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-10-14T13:00:00Z"); // quarta, 10h em São Paulo
const DIA = 24 * 60 * 60 * 1000;
/** Tipo da oferta que a decisão manda na hora, como resposta (a planejada pelo follow-up tem o tipo com a data). */
const IMEDIATA = "metodo_oferta:seq";

let n = 0;
function cenario(config = CONFIG_METODO_EXEMPLO, extra: { julgar?: Julgar } = {}) {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), config);
  const lead = repo.novoLead(`lead-m${++n}`);
  repo.chipPorLead.set(lead.id, "chip-ensaio");
  // Sem o operador no meio o limite de respostas automáticas seguidas pararia o roteiro longo.
  repo.operadorFalou.add(lead.id);
  const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }), sortear: () => 0.5, ...extra };
  const diz = (texto: string | null) => atenderMensagem(deps, ORG, lead.id, { chave: `m${++n}`, messageId: null, texto, midia: false, conversationId: "conv-1" });
  return { repo, lead, deps, diz, conversa: () => repo.conversas.get(lead.id)! };
}

/** Leva a lead até a recusa do kit menor: tabela, falta de dinheiro (kits de entrada) e a recusa deles. */
async function ateORecusarOKitMenor(c: ReturnType<typeof cenario>) {
  await c.diz("Quanto custa?");
  await c.diz("agora não tenho dinheiro");
  await c.diz("continuo sem dinheiro, não tenho como pagar");
  return c.diz("não tenho dinheiro mesmo");
}

/** Leva a lead até a oferta do Método: tabela e "não tenho interesse". */
async function ateAOferta(c: ReturnType<typeof cenario>) {
  await c.diz("Quanto custa?");
  return c.diz("não tenho interesse");
}

const tipos = (c: ReturnType<typeof cenario>, re: RegExp) => c.repo.enviosDo(c.lead.id).filter((e) => re.test(e.tipo));

describe("config: Método e follow-up são opcionais e conferidos", () => {
  it("config antiga, sem as chaves novas, segue válida e com os recursos desligados", () => {
    const antiga = CONFIG_VENDA_EXEMPLO;
    if (antiga.perfil !== "venda") throw new Error("exemplo tem de ser venda");
    expect(antiga.metodo).toBeNull();
    expect(antiga.followupKit).toBeNull();
    expect(conferirReferencias(antiga)).toEqual([]);
  });

  it("a config de exemplo do Método confere; resposta citada que não existe e Método sem ponto do Pix são erros", () => {
    expect(conferirReferencias(CONFIG_METODO_EXEMPLO)).toEqual([]);
    const quebrada = atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, metodo: { ...(CONFIG_METODO_EXEMPLO as { metodo: object }).metodo, d7: "nao_existe" } });
    expect(conferirReferencias(quebrada)).toContain('metodo.d7: resposta "nao_existe" não existe');
    const semPonto = atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, parada: { celular: CELULAR_DO_OPERADOR, pontos: [] } });
    expect(conferirReferencias(semPonto).join(" ")).toMatch(/pediu_pix_metodo/);
  });
});

describe("trava de preço: 30, 15 e 45 só no contexto do Método", () => {
  it("fora do contexto o valor continua barrado; com os extras do Método passa", () => {
    const kits = (CONFIG_VENDA_EXEMPLO as { kits: Parameters<typeof motivoForaDaTabela>[1] }).kits;
    expect(motivoForaDaTabela("São R$ 30, uma vez só", kits)).toMatch(/valor fora da tabela/);
    expect(motivoForaDaTabela("São R$ 30, uma vez só", kits, [3000, 1500, 4500])).toBeNull();
    expect(motivoForaDaTabela("Fica R$ 31", kits, [3000, 1500, 4500])).toMatch(/valor fora da tabela/);
  });

  it("uma resposta comum com R$ 30 continua barrada mesmo com o Método ligado", async () => {
    const base = CONFIG_METODO_EXEMPLO as { respostas: Record<string, unknown> };
    const c = cenario(atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, respostas: { ...base.respostas, entrega: [[{ texto: "Chega em 5 dias, frete R$ 30" }]] } }));
    await c.diz("Qual o prazo de entrega?");
    expect(c.repo.enviosDo(c.lead.id)).toHaveLength(0);
    expect(c.conversa().precisaOperador).toBe(true);
  });
});

describe("downsell: a oferta do Método", () => {
  it("depois que a lead diz que não tem interesse, sai a oferta do Método, uma vez", async () => {
    const c = cenario();
    await ateAOferta(c);
    const oferta = c.repo.enviosDo(c.lead.id).filter((e) => e.tipo === IMEDIATA);
    expect(oferta).toHaveLength(5);
    expect(oferta.map((e) => e.texto).join("\n")).toContain("São R$ 30, uma vez só, no Pix.");
    expect(c.conversa().dados.metodo).toMatchObject({ etapa: "ofertado", oferecido: true });
    // Uma vez por lead: recusar de novo não repete a oferta.
    const antes = c.repo.enviosDo(c.lead.id).filter((e) => e.tipo === IMEDIATA).length;
    await c.diz("não tenho interesse mesmo");
    expect(c.repo.enviosDo(c.lead.id).filter((e) => e.tipo === IMEDIATA)).toHaveLength(antes);
  });

  it("recusar o kit menor por falta de dinheiro NÃO oferece o Método (vai ao operador)", async () => {
    const c = cenario();
    await ateORecusarOKitMenor(c);
    expect(c.repo.enviosDo(c.lead.id).some((e) => e.tipo.startsWith("metodo"))).toBe(false);
    expect(c.conversa().dados.metodo.etapa).toBe("nenhuma");
  });

  it("nunca para quem já é cliente", async () => {
    const c = cenario();
    c.repo.leads.get(c.lead.id)!.campos = { trilha: "posvenda" };
    c.repo.conversas.set(c.lead.id, {
      ...conversaNova(),
      ultimaAutoEm: null,
      dados: lerDados({ tabelaEnviada: true, faltaDeDinheiro: 2, entradaOferecida: true }),
    });
    await c.diz("não tenho dinheiro mesmo");
    expect(c.repo.enviosDo(c.lead.id).filter((e) => e.tipo === IMEDIATA)).toHaveLength(0);
    expect(c.conversa().dados.metodo.etapa).toBe("nenhuma");
  });

  it("com o recurso desligado (config antiga ou ligado:false) a terceira recusa segue com o operador", async () => {
    const velha = cenario(CONFIG_VENDA_EXEMPLO);
    await ateORecusarOKitMenor(velha);
    expect(velha.repo.enviosDo(velha.lead.id).some((e) => e.tipo.startsWith("metodo"))).toBe(false);
    expect(velha.conversa().precisaOperador).toBe(true);

    const base = CONFIG_METODO_EXEMPLO as { metodo: object };
    const desligada = cenario(atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, metodo: { ...base.metodo, ligado: false } }));
    await ateORecusarOKitMenor(desligada);
    expect(desligada.repo.enviosDo(desligada.lead.id).some((e) => e.tipo.startsWith("metodo"))).toBe(false);
    expect(desligada.conversa().precisaOperador).toBe(true);
  });

  it("'não é o momento' depois do toque 6 do follow-up pula direto para a oferta do Método", async () => {
    const c = cenario();
    await c.diz("Quanto custa?");
    c.repo.toquesSaidos = 6;
    await c.diz("não é o momento, obrigada");
    expect(c.repo.enviosDo(c.lead.id).filter((e) => e.tipo === IMEDIATA)).toHaveLength(5);
    expect(c.conversa().etapa).not.toBe("perdido");
    expect(c.conversa().dados.metodo.etapa).toBe("ofertado");
  });

  it("'não é o momento' sem o follow-up ter chegado ao toque 6 não dispara a oferta", async () => {
    const c = cenario();
    await c.diz("Quanto custa?");
    c.repo.toquesSaidos = 2;
    await c.diz("não é o momento, obrigada");
    expect(c.repo.enviosDo(c.lead.id).some((e) => e.tipo === IMEDIATA)).toBe(false);
  });
});

describe("o 'sim', a escolha do valor e o aviso do Pix", () => {
  it("'sim' leva à mensagem do Pix com o bump; 'só o método' grava 3000 e avisa o celular, sem cobrança automática", async () => {
    const c = cenario();
    await ateAOferta(c);
    const antes = c.repo.enviosDo(c.lead.id).length;
    await c.diz("sim");
    const pix = c.repo.enviosDo(c.lead.id).slice(antes);
    expect(pix.map((e) => e.texto).join("\n")).toMatch(/R\$ 30[\s\S]*R\$ 15[\s\S]*R\$ 45/);
    expect(c.conversa().dados.metodo.etapa).toBe("escolhendo");

    const antesDaEscolha = c.repo.enviosDo(c.lead.id).length;
    await c.diz("só o método");
    expect(c.conversa().dados.metodo).toMatchObject({ etapa: "aguardando_pix", valorCents: 3000, comCardapio: false });
    expect(c.repo.enviosDo(c.lead.id)).toHaveLength(antesDaEscolha); // a conversa espera: nada sai para a lead
    expect(c.repo.avisosAoCelular).toHaveLength(1);
    expect(c.repo.avisosAoCelular[0]).toMatchObject({ destino: CELULAR_DO_OPERADOR, ponto: "pix_metodo" });
    expect(c.repo.avisosAoCelular[0]!.texto).toBe("Aviso: pediu PIX DO MÉTODO\nNome: Maria Silva\nWhatsApp: 5511900000000\nChip: chip-ensaio\nValor: R$ 30,00");
    // A conversa espera o pagamento: o que ela escrever vai para o operador, sem resposta automática.
    await c.diz("já fiz o pix");
    expect(c.repo.enviosDo(c.lead.id)).toHaveLength(antesDaEscolha);
    expect(c.conversa().precisaOperador).toBe(true);
  });

  it("'com o cardápio' grava 4500", async () => {
    const c = cenario();
    await ateAOferta(c);
    await c.diz("sim");
    await c.diz("com o cardápio");
    expect(c.conversa().dados.metodo).toMatchObject({ etapa: "aguardando_pix", valorCents: 4500, comCardapio: true });
    expect(c.repo.avisosAoCelular[0]!.texto).toContain("Valor: R$ 45,00");
  });

  it("a oferta que saiu pelo follow-up (o motor mandou, o atendimento não viu) também aceita o 'sim'", async () => {
    const c = cenario();
    await c.diz("Quanto custa?");
    c.repo.ofertaMetodoSaiu = true;
    await c.diz("sim");
    expect(c.repo.enviosDo(c.lead.id).filter((e) => e.tipo === "metodo_pix:seq")).toHaveLength(3);
    expect(c.conversa().dados.metodo.etapa).toBe("escolhendo");
  });

});
/** Jev de mentira que lê toda mensagem como `opcao` (a mesma pergunta da leitura de intenção); conta as chamadas. */
function jevLe(opcao: string, confianca = 0.9) {
  const julgar = vi.fn(async () => ({ respostas: { intencao: { type: "choice", choice: opcao, confidence: confianca } }, tokens: 0 })) as unknown as Julgar & ReturnType<typeof vi.fn>;
  return julgar;
}

describe("atendimento inteligente na oferta do Método", () => {
  const PEDIDOS_DE_EXPLICACAO = [
    "como funciona?",
    "Como funciona isso?",
    "quero saber",
    "Quero saber mais",
    "me explica",
    "como é?",
    "do que se trata?",
    "o que é isso?",
    "quanto custa?",
    "qual o valor?",
    "e quanto custa?",
    "tem garantia?",
    "manda mais detalhes",
    "mande mais detalhes",
    "pode me mandar mais detalhes?",
    "sim, quero saber como funciona",
  ];

  it.each(PEDIDOS_DE_EXPLICACAO)("'%s' vale como aceite do convite: sai a mensagem do Método com preço e bump", async (frase) => {
    const c = cenario();
    await ateAOferta(c);
    const antes = c.repo.enviosDo(c.lead.id).length;
    await c.diz(frase);
    const novos = c.repo.enviosDo(c.lead.id).slice(antes);
    expect(novos.filter((e) => e.tipo === "metodo_pix:seq")).toHaveLength(3);
    expect(novos.map((e) => e.texto).join(" ")).toMatch(/R\$ 30[\s\S]*R\$ 15[\s\S]*R\$ 45/);
    expect(c.conversa().dados.metodo.etapa).toBe("escolhendo");
    expect(c.conversa().precisaOperador).toBe(false);
  });

  it.each(["não", "não quero", "nao quero saber", "não tenho interesse mesmo", "agora não quero saber disso"])("recusa clara ('%s') NÃO é aceite", async (frase) => {
    const c = cenario();
    await ateAOferta(c);
    await c.diz(frase);
    expect(c.repo.enviosDo(c.lead.id).some((e) => e.tipo === "metodo_pix:seq")).toBe(false);
    expect(c.conversa().dados.metodo.etapa).not.toBe("escolhendo");
  });

  it("pergunta de preço de kit específico ('quanto custa o de 6 meses?') não vira aceite do Método", async () => {
    const c = cenario();
    await ateAOferta(c);
    await c.diz("quanto custa o de 6 meses?");
    expect(c.repo.enviosDo(c.lead.id).some((e) => e.tipo === "metodo_pix:seq")).toBe(false);
    expect(c.conversa().dados.metodo.etapa).toBe("ofertado");
  });

  it("frase fora do vocabulário que o Jev já leu como interesse também vale (sem chamada extra de Jev)", async () => {
    const julgar = jevLe("interesse");
    const c = cenario(CONFIG_METODO_EXEMPLO, { julgar });
    await ateAOferta(c);
    const antes = julgar.mock.calls.length;
    await c.diz("fiquei curiosa sobre isso");
    expect(c.conversa().dados.metodo.etapa).toBe("escolhendo");
    expect(c.repo.enviosDo(c.lead.id).filter((e) => e.tipo === "metodo_pix:seq")).toHaveLength(3);
    expect(julgar.mock.calls.length - antes).toBe(1); // só a leitura da mensagem
  });

  it("o mesmo texto sem o Jev (sem chave) não é aceite: segue o atendimento normal", async () => {
    const c = cenario();
    await ateAOferta(c);
    await c.diz("fiquei curiosa sobre isso");
    expect(c.repo.enviosDo(c.lead.id).some((e) => e.tipo === "metodo_pix:seq")).toBe(false);
    expect(c.conversa().dados.metodo.etapa).toBe("ofertado");
  });

  it("pedido de explicação que o regex já resolve não gasta chamada de Jev a mais que a leitura", async () => {
    const julgar = jevLe("outro", 0.5);
    const c = cenario(CONFIG_METODO_EXEMPLO, { julgar });
    await ateAOferta(c);
    for (const frase of ["tem garantia?", "como funciona?", "qual o valor?"]) {
      const c2 = cenario(CONFIG_METODO_EXEMPLO, { julgar });
      await ateAOferta(c2);
      const antes = julgar.mock.calls.length;
      await c2.diz(frase);
      expect(julgar.mock.calls.length - antes, frase).toBe(1);
      expect(c2.conversa().dados.metodo.etapa, frase).toBe("escolhendo");
    }
  });

  it("depois do aceite por explicação, a escolha do valor segue o fluxo de sempre", async () => {
    const c = cenario();
    await ateAOferta(c);
    await c.diz("como funciona?");
    await c.diz("só o método");
    expect(c.conversa().dados.metodo).toMatchObject({ etapa: "aguardando_pix", valorCents: 3000, comCardapio: false });
  });
});

describe("escolha do valor do Método: os números vêm da config da organização", () => {
  // Outra organização, outra oferta: R$ 35 só o método, R$ 52 com o bônus. Nenhum número fixo no leitor.
  const OUTRA = { soMetodoCents: 3500, comCardapioCents: 5200 };
  const ler = (f: string, naDuvida = true) => escolhaDoMetodo(normalizar(f).replace(/\s+/g, " ").trim(), OUTRA, naDuvida);
  it.each(["o de 35", "só o de 35", "35", "35 reais", "quero o de 35"])("'%s' = só o método", (f) => expect(ler(f)).toBe("so"));
  it.each(["o de 52", "52", "52 reais"])("'%s' = com o bônus", (f) => expect(ler(f)).toBe("com"));
  it.each(["o de 30", "30", "o de 45", "45", "o de 47", "64"])("'%s' não é escolha (não é o valor desta organização)", (f) => expect(ler(f)).toBeNull());
  it("valor com centavos casa com vírgula ou ponto", () => {
    const c = { soMetodoCents: 2990, comCardapioCents: 3990 };
    expect(escolhaDoMetodo("o de 29,90", c)).toBe("so");
    expect(escolhaDoMetodo("39.90", c)).toBe("com");
    expect(escolhaDoMetodo("29", c)).toBeNull();
  });
  it("prazo ou porcentagem com o mesmo número não é escolha", () => {
    expect(ler("tem garantia de 35 dias?", false)).toBeNull();
    expect(ler("da desconto de 35%?", false)).toBeNull();
  });
  it("número que só começa com o valor não é o valor (35 não casa 350 nem 355)", () => {
    expect(ler("o de 350", false)).toBeNull();
    expect(ler("tem de 355?", false)).toBeNull();
    expect(ler("so o de 3500", false)).toBeNull();
    expect(escolhaDoMetodo("so o de 300", METODO_EXEMPLO, false)).toBeNull();
    expect(escolhaDoMetodo("o de 305", METODO_EXEMPLO, false)).toBeNull();
  });
});

describe("escolha do valor do Método: variações naturais", () => {
  const SO = ["só o método", "so o metodo", "só o metodo mesmo", "o simples", "pode ser o simples", "quero o simples", "só o de 30", "sem o cardápio", "apenas o método", "o básico"];
  const COM = ["com cardápio", "com o cardapio", "com o cardápio", "quero o cardápio também", "quero o cardapio tambem", "os dois", "quero os dois", "com o cardápio, por favor", "o completo", "o de 45", "levo o cardápio também"];

  it.each(SO)("'%s' = só o método", (f) => expect(escolhaDoMetodo(normalizar(f).replace(/\s+/g, " ").trim(), METODO_EXEMPLO)).toBe("so"));
  it.each(COM)("'%s' = com o cardápio", (f) => expect(escolhaDoMetodo(normalizar(f).replace(/\s+/g, " ").trim(), METODO_EXEMPLO)).toBe("com"));
  it.each(["como funciona?", "talvez", "não sei", "quero algo simples", "tem algo mais básico?", "não", "não quero", "sim mas tenho uma dúvida"])("'%s' não é escolha", (f) => expect(escolhaDoMetodo(normalizar(f).replace(/\s+/g, " ").trim(), METODO_EXEMPLO)).toBeNull());

  // Na dúvida, o aceite seco vale o valor menor (R$ 30 nesta config de exemplo). A mensagem `metodo_pix` não numera as opções: "1" e "2" ficam de fora.
  const NA_DUVIDA = ["sim", "ok", "pode", "pode mandar", "manda o pix", "pode mandar o pix", "quero", "quero o método", "30", "o de 30", "o mais barato", "sim, pode mandar!", "Ok!"];
  it.each(NA_DUVIDA)("'%s' = só o método (na dúvida)", (f) => expect(escolhaDoMetodo(normalizar(f).replace(/\s+/g, " ").trim(), METODO_EXEMPLO)).toBe("so"));
  it.each(["45", "o de 45"])("'%s' = com o cardápio", (f) => expect(escolhaDoMetodo(normalizar(f).replace(/\s+/g, " ").trim(), METODO_EXEMPLO)).toBe("com"));
  it.each(["1", "2"])("'%s' solto não é escolha (a mensagem não numera as opções)", (f) => expect(escolhaDoMetodo(f, METODO_EXEMPLO)).toBeNull());
  it("fora da etapa 'escolhendo' o 'sim' não é escolha (senão pula a mensagem do Pix)", () => {
    expect(escolhaDoMetodo("sim", METODO_EXEMPLO, false)).toBeNull();
    expect(escolhaDoMetodo("so o metodo", METODO_EXEMPLO, false)).toBe("so");
  });

  it("de ponta a ponta: 'sim' na etapa 'escolhendo' cobra R$ 30; 'sim' na oferta só manda a mensagem do Pix", async () => {
    const c = cenario();
    await ateAOferta(c);
    await c.diz("sim");
    expect(c.conversa().dados.metodo.etapa).toBe("escolhendo");
    await c.diz("pode mandar o pix");
    expect(c.conversa().dados.metodo).toMatchObject({ etapa: "aguardando_pix", valorCents: 3000, comCardapio: false });
  });

  it("de ponta a ponta: 'o simples' grava 3000 e 'quero o cardápio também' grava 4500", async () => {
    const a = cenario();
    await ateAOferta(a);
    await a.diz("sim");
    await a.diz("o simples");
    expect(a.conversa().dados.metodo).toMatchObject({ etapa: "aguardando_pix", valorCents: 3000 });
    const b = cenario();
    await ateAOferta(b);
    await b.diz("sim");
    await b.diz("quero o cardápio também");
    expect(b.conversa().dados.metodo).toMatchObject({ etapa: "aguardando_pix", valorCents: 4500, comCardapio: true });
  });
});

describe("pagamento confirmado", () => {
  async function ateOPix(c: ReturnType<typeof cenario>) {
    await ateAOferta(c);
    await c.diz("sim");
    await c.diz("só o método");
  }

  it("agenda D0 na hora (com o link da config), D7 e D14, grava a marca VIP e não agenda duas vezes", async () => {
    const c = cenario();
    await ateOPix(c);
    const antes = c.repo.envios.length;
    const r = await confirmarPagamentoMetodo(c.deps, ORG, c.lead.id);
    expect(r.resultado).toBe("agendado");
    const novos = c.repo.envios.slice(antes);
    const d0 = novos.filter((e) => e.tipo.startsWith("metodo_d0"));
    expect(d0.map((e) => e.texto).join("\n")).toContain("Aqui está tudo: https://entrega.exemplo/metodo");
    expect(d0[0]!.enviarApos.getTime() - AGORA.getTime()).toBeLessThan(5 * 60_000);
    const d7 = novos.find((e) => e.tipo === "metodo_d7")!;
    const d14 = novos.find((e) => e.tipo === "metodo_d14")!;
    expect(d7.texto).toContain("Uma semana!");
    expect(d14.texto).toContain("Duas semanas!");
    expect(d7.origem).toBe("motor");
    expect(d7.enviarApos.getTime() - AGORA.getTime()).toBeGreaterThanOrEqual(7 * DIA);
    expect(d7.enviarApos.getTime() - AGORA.getTime()).toBeLessThan(8 * DIA);
    expect(d14.enviarApos.getTime() - AGORA.getTime()).toBeGreaterThanOrEqual(14 * DIA);
    expect(d14.enviarApos.getTime() - AGORA.getTime()).toBeLessThan(15 * DIA);
    expect(c.conversa().dados.metodo.etapa).toBe("pago");
    expect(c.conversa().dados.vipDescontoPct).toBe(10);

    const total = c.repo.envios.length;
    expect((await confirmarPagamentoMetodo(c.deps, ORG, c.lead.id)).resultado).toBe("ja_pago");
    expect(c.repo.envios).toHaveLength(total);
  });

  it("se a lead responder, volta ao atendimento normal: D7 e D14 não saem mais e a marca VIP fica", async () => {
    const c = cenario();
    await ateOPix(c);
    await confirmarPagamentoMetodo(c.deps, ORG, c.lead.id);
    await c.diz("recebi, obrigada");
    const d7 = c.repo.envios.find((e) => e.tipo === "metodo_d7")!;
    const d14 = c.repo.envios.find((e) => e.tipo === "metodo_d14")!;
    expect(d7.cancelado).toBeTruthy();
    expect(d14.cancelado).toBeTruthy();
    expect(c.conversa().dados.vipDescontoPct).toBe(10);
    expect(c.conversa().dados.metodo.etapa).toBe("pago");
  });

  it("sem link de entrega na config, nada é agendado", async () => {
    const base = CONFIG_METODO_EXEMPLO as { metodo: object };
    const c = cenario(atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, metodo: { ...base.metodo, linkEntrega: null } }));
    await ateOPix(c);
    const antes = c.repo.envios.length;
    const r = await confirmarPagamentoMetodo(c.deps, ORG, c.lead.id);
    expect(r.resultado).toBe("sem_link");
    expect(c.repo.envios).toHaveLength(antes);
    expect(c.conversa().dados.metodo.etapa).toBe("aguardando_pix");
  });

  it("com cardápio, a entrega usa linkEntregaComCardapio; sem ele, cai no linkEntrega", async () => {
    const base = CONFIG_METODO_EXEMPLO as { metodo: object };
    const com = cenario(atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, metodo: { ...base.metodo, linkEntregaComCardapio: "https://entrega.exemplo/com-cardapio" } }));
    await ateAOferta(com);
    await com.diz("sim");
    await com.diz("com o cardápio");
    const antes = com.repo.envios.length;
    expect((await confirmarPagamentoMetodo(com.deps, ORG, com.lead.id)).resultado).toBe("agendado");
    const d0 = com.repo.envios.slice(antes).find((e) => e.tipo.startsWith("metodo_d0"))!;
    expect(d0.texto).toContain("https://entrega.exemplo/com-cardapio");
    expect(d0.texto).not.toContain("https://entrega.exemplo/metodo");

    const so = cenario(atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, metodo: { ...base.metodo, linkEntregaComCardapio: "https://entrega.exemplo/com-cardapio" } }));
    await ateAOferta(so);
    await so.diz("sim");
    await so.diz("só o método");
    const antesSo = so.repo.envios.length;
    await confirmarPagamentoMetodo(so.deps, ORG, so.lead.id);
    expect(so.repo.envios.slice(antesSo).find((e) => e.tipo.startsWith("metodo_d0"))!.texto).toContain("https://entrega.exemplo/metodo");

    const sem = cenario();
    await ateAOferta(sem);
    await sem.diz("sim");
    await sem.diz("com o cardápio");
    const antesSem = sem.repo.envios.length;
    await confirmarPagamentoMetodo(sem.deps, ORG, sem.lead.id);
    expect(sem.repo.envios.slice(antesSem).find((e) => e.tipo.startsWith("metodo_d0"))!.texto).toContain("https://entrega.exemplo/metodo");
  });

  it("linkEntregaComCardapio é opcional na config (default null)", () => {
    const base = CONFIG_METODO_EXEMPLO as { metodo: object };
    const cfg = atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, metodo: { ...base.metodo } });
    expect(cfg.perfil === "venda" && cfg.metodo?.linkEntregaComCardapio).toBeNull();
  });

  it("sem Método ligado ou sem conversa, não faz nada", async () => {
    const c = cenario(CONFIG_VENDA_EXEMPLO);
    expect((await confirmarPagamentoMetodo(c.deps, ORG, c.lead.id)).resultado).toBe("sem_metodo");
    const d = cenario();
    expect((await confirmarPagamentoMetodo(d.deps, ORG, d.lead.id)).resultado).toBe("sem_conversa");
  });
});

describe("follow-up de 7 toques do kit", () => {
  it("quem viu a tabela ganha os 7 toques (D+1, 2, 4, 6, 9, 12, 15) e a oferta 48 h depois do último, como mensagens do motor", async () => {
    const c = cenario();
    await c.diz("Quanto custa?");
    const toques = tipos(c, TIPO_TOQUE_DO_KIT);
    expect(toques).toHaveLength(7);
    expect(toques.every((e) => e.origem === "motor" && e.estado === "pendente" && e.chipId === "chip-ensaio")).toBe(true);
    expect(toques[0]!.texto).toBe("Maria, ficou alguma dúvida sobre os planos?");
    expect(toques[6]!.texto).toBe("Vou deixar você à vontade. Quando quiser retomar, é só me chamar aqui.");
    [1, 2, 4, 6, 9, 12, 15].forEach((dia, i) => {
      const dt = toques[i]!.enviarApos.getTime() - AGORA.getTime();
      expect(dt, `toque ${i + 1}`).toBeGreaterThan((dia - 1) * DIA);
      expect(dt, `toque ${i + 1}`).toBeLessThan((dia + 1) * DIA);
    });
    const oferta = c.repo.enviosDo(c.lead.id).filter((e) => e.tipo.startsWith("metodo_oferta_"));
    expect(oferta).toHaveLength(5);
    expect(TIPO_OFERTA_DO_METODO.test(oferta[0]!.tipo)).toBe(true);
    expect(oferta.every((e) => e.origem === "motor" && e.estado === "pendente")).toBe(true);
    const depois7 = oferta[0]!.enviarApos.getTime() - toques[6]!.enviarApos.getTime();
    expect(depois7).toBeGreaterThanOrEqual(48 * 60 * 60 * 1000);
    expect(depois7).toBeLessThan(4 * DIA);
    expect(oferta.map((e) => e.texto).join("\n")).toContain("R$ 30");
  });

  it("quando a lead responde, o que não saiu é cancelado e o follow-up recomeça da nova mensagem", async () => {
    const c = cenario();
    await c.diz("Quanto custa?");
    const primeiros = tipos(c, TIPO_TOQUE_DO_KIT).map((e) => e.tipo);
    c.deps.agora = new Date(AGORA.getTime() + 3 * 60 * 60 * 1000);
    await c.diz("achei caro");
    const vivos = tipos(c, TIPO_TOQUE_DO_KIT);
    expect(vivos).toHaveLength(7);
    expect(vivos.some((e) => primeiros.includes(e.tipo))).toBe(false);
    for (const t of primeiros) expect(c.repo.envios.find((e) => e.tipo === t)!.cancelado).toBeTruthy();
    expect(vivos[0]!.enviarApos.getTime()).toBeGreaterThan(c.deps.agora.getTime());
  });

  it("não planeja para quem não viu a tabela, para cliente, com o recurso desligado ou na config antiga", async () => {
    const semTabela = cenario();
    await semTabela.diz("Qual o prazo de entrega?");
    expect(tipos(semTabela, TIPO_TOQUE_DO_KIT)).toHaveLength(0);

    const cliente = cenario();
    cliente.repo.leads.get(cliente.lead.id)!.campos = { trilha: "posvenda" };
    await cliente.diz("Quanto custa?");
    expect(tipos(cliente, TIPO_TOQUE_DO_KIT)).toHaveLength(0);

    const base = CONFIG_METODO_EXEMPLO as { followupKit: object };
    const desligado = cenario(atendimentoSchema.parse({ ...CONFIG_METODO_EXEMPLO, followupKit: { ...base.followupKit, ligado: false } }));
    await desligado.diz("Quanto custa?");
    expect(tipos(desligado, TIPO_TOQUE_DO_KIT)).toHaveLength(0);

    const velha = cenario(CONFIG_VENDA_EXEMPLO);
    await velha.diz("Quanto custa?");
    expect(tipos(velha, TIPO_TOQUE_DO_KIT)).toHaveLength(0);
  });

  it("quem escolheu o kit (pronto para fechar) e quem foi para o operador não recebe follow-up", async () => {
    const fecha = cenario();
    await fecha.diz("Quanto custa?");
    await fecha.diz("quero o de 9 meses");
    for (const e of tipos(fecha, TIPO_TOQUE_DO_KIT)) expect(e.cancelado ?? "").toBeTruthy();
    expect(tipos(fecha, TIPO_TOQUE_DO_KIT)).toHaveLength(0);
  });
});

describe("bloco `metodo` incompleto: só o Método desliga, o atendimento segue", () => {
  // Sem default nos valores, um bloco `metodo` sem eles invalidava o schema inteiro e o atendimento da organização
  // parava em silêncio. O menos surpreendente: o Método fica desligado, o resto segue, e o log diz qual campo falta.
  const semValores = () => {
    const { soMetodoCents: _a, comCardapioCents: _b, cardapioCents: _c, ...resto } = (CONFIG_METODO_EXEMPLO as { metodo: Record<string, unknown> }).metodo;
    return { ...CONFIG_METODO_EXEMPLO, metodo: resto };
  };

  it("lê a config com o Método desligado e avisa no log quais campos faltam", async () => {
    const { logger } = await import("../../logger");
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const c = lerConfigAtendimento(semValores());
      expect(c).not.toBeNull();
      expect(c!.perfil).toBe("venda");
      expect(c!.perfil === "venda" && c!.metodo).toBeNull();
      expect(aviso).toHaveBeenCalledTimes(1);
      const [msg, ctx] = aviso.mock.calls[0]!;
      expect(msg).toMatch(/metodo/);
      expect(JSON.stringify(ctx)).toMatch(/soMetodoCents/);
    } finally {
      aviso.mockRestore();
    }
  });

  it("o aviso sai uma vez por bloco (a leitura roda a cada tick) e não sai com o Método desligado de propósito", async () => {
    const { logger } = await import("../../logger");
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // Um bloco que nenhum outro caso usou: o memo é do processo.
      const base = semValores();
      const outro = { ...base, metodo: { ...base.metodo, rotulo: "bloco-do-caso-de-memo" } };
      for (let i = 0; i < 5; i++) expect(lerConfigAtendimento(outro)).not.toBeNull();
      expect(aviso).toHaveBeenCalledTimes(1);
      aviso.mockClear();
      const desligado = { ...base, metodo: { ...base.metodo, ligado: false } };
      const c = lerConfigAtendimento(desligado);
      expect(c).not.toBeNull();
      expect(c!.perfil === "venda" && c!.metodo).toBeNull();
      expect(aviso).not.toHaveBeenCalled();
    } finally {
      aviso.mockRestore();
    }
  });

  it("quem grava a config continua vendo o campo faltando", () => {
    expect(errosDaConfig(semValores()).some((e) => e.startsWith("metodo.soMetodoCents"))).toBe(true);
  });

  it("erro fora do bloco `metodo` continua desligando a config inteira", () => {
    expect(lerConfigAtendimento({ ...semValores(), parada: "inválido" })).toBeNull();
  });
});
