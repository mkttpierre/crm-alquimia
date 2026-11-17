/**
 * AVISO DE COMPRA no celular do operador: só quando o lead diz que quer comprar ou
 * informa a quantidade/kit — não em todo "precisa do operador". Formato exato da casa, uma vez por
 * pedido. E a JANELA DE RESPOSTA do atendimento (8h–22h): resposta decidida fora dela espera abrir,
 * sem mexer na janela de prospecção.
 */
import { describe, expect, it } from "vitest";

import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem, daJanelaDeResposta } from "./atendimento";
import { atendimentoSchema } from "./config";
import { criarJulgar } from "./jev";
import { quantidadeSolta } from "./venda";

const ORG = "11111111-1111-4111-8111-111111111111";
const CELULAR = "5511900000002";
const AGORA = new Date("2026-10-14T13:00:00Z"); // 10h em Brasília (fuso -180)
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };

const PARADA = {
  celular: CELULAR,
  aviso: "🌸Respondeu {titulo}🌸\n✅ MARCA A ✅\nNome: {nome} ❤️\nWhatsApp: {telefone}\nKit: {kit}\nDisse: \"{disse}\"",
  pontos: [
    { id: "escolheu_kit", evento: "escolheu_kit", titulo: "VALORES", etapa: "pronto_fechar", tag: "pronto-pra-fechar" },
    { id: "quer_comprar", evento: "quer_fechar", titulo: "VALORES", parar: false },
    { id: "desconto", evento: "pede_desconto", titulo: "DESCONTO", tag: "negociar-desconto" },
    { id: "midia", evento: "mandou_midia", titulo: "ÁUDIO", parar: false, aviso: "🌸Mandou {titulo}🌸\nNome: {nome}\nWhatsApp: {telefone}\nChip: {chip}" },
  ],
};

let n = 0;
function cenario(agora = AGORA, sortear = () => 0.5) {
  const config = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, parada: PARADA });
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, "real"), config);
  const lead = repo.novoLead(`lead-av${++n}`, { nome: "N", telefone: "(11) 90000-0001" });
  repo.chipPorLead.set(lead.id, "chip-1");
  const deps = { repo, agora, ambiente: AMBIENTE, julgar: criarJulgar({ chave: null }), sortear };
  const diz = (texto: string | null, midia = false) => atenderMensagem(deps, ORG, lead.id, { chave: `av${++n}`, messageId: null, texto, midia, conversationId: "conv-1" });
  return { repo, lead, diz };
}

describe("aviso de compra ao celular do operador", () => {
  it("o exemplo da casa: 'tenho 4' (kit que a tabela não tem) avisa com 'Kit: 4 meses' e a frase literal", async () => {
    const { repo, diz } = cenario();
    await diz("Quanto custa?");
    await diz("tenho 4");
    expect(repo.avisosAoCelular[0]!.texto).toBe("🌸Respondeu VALORES🌸\n✅ MARCA A ✅\nNome: N ❤️\nWhatsApp: 5511900000001\nKit: 4 meses\nDisse: \"tenho 4\"");
  });

  it("quantidade dita depois da tabela ('tenho 9'): avisa no formato exato, com o kit e a frase literal", async () => {
    const { repo, diz } = cenario();
    await diz("Quanto custa?");
    expect(repo.avisosAoCelular).toHaveLength(0);
    await diz("tenho 9");
    expect(repo.avisosAoCelular).toHaveLength(1);
    const a = repo.avisosAoCelular[0]!;
    expect(a.destino).toBe(CELULAR);
    expect(a.ponto).toBe("escolheu_kit");
    expect(a.texto).toBe("🌸Respondeu VALORES🌸\n✅ MARCA A ✅\nNome: N ❤️\nWhatsApp: 5511900000001\nKit: 9 meses\nDisse: \"tenho 9\"");
  });

  it("'quero o de 12 meses' avisa o kit; intenção de compra sem quantidade ('vou levar') avisa com kit 'a definir' e não para a conversa", async () => {
    const a = cenario();
    await a.diz("Quanto custa?");
    await a.diz("quero o de 12 meses");
    expect(a.repo.avisosAoCelular.map((x) => x.texto.split("\n")[4])).toEqual(["Kit: 12 meses"]);

    const b = cenario();
    await b.diz("Quanto custa?");
    await b.diz("vou levar");
    expect(b.repo.avisosAoCelular).toHaveLength(1);
    expect(b.repo.avisosAoCelular[0]!.texto).toContain("Kit: a definir");
    expect(b.repo.avisosAoCelular[0]!.texto).toContain('Disse: "vou levar"');
    expect(b.repo.paradas).toHaveLength(0); // só avisa: a conversa segue no automático (qualifica o kit)
    expect(b.repo.enviosDo(b.lead.id).at(-1)!.tipo).toBe("pergunta_kit");
  });

  it("não avisa em 'quanto custa', elogio nem dúvida", async () => {
    const { repo, diz } = cenario();
    await diz("Quanto custa?");
    await diz("estou gostando muito, amei");
    await diz("será que funciona mesmo?");
    await diz("e a entrega, quanto tempo demora?");
    expect(repo.avisosAoCelular).toHaveLength(0);
  });

  it("não avisa em todo 'precisa do operador' (reclamação vai à Central, sem celular)", async () => {
    const { repo, diz } = cenario();
    await diz("não funcionou, quero reembolso");
    expect(repo.avisosAoCelular).toHaveLength(0);
  });

  it("o mesmo pedido não avisa duas vezes: 'vou levar' repetido; e a quantidade depois do 'quero' ainda avisa uma vez", async () => {
    const { repo, diz } = cenario();
    await diz("Quanto custa?");
    await diz("vou levar");
    await diz("vou levar sim");
    expect(repo.avisosAoCelular).toHaveLength(1);
    await diz("tenho 9");
    expect(repo.avisosAoCelular.map((x) => x.ponto)).toEqual(["quer_comprar", "escolheu_kit"]);
  });

  it("quem já avisou a quantidade não avisa o 'quero' depois", async () => {
    const { repo, diz } = cenario();
    await diz("Quanto custa?");
    await diz("quero o de 9 meses");
    expect(repo.avisosAoCelular).toHaveLength(1);
  });
});

describe("aviso de áudio ou mídia ao celular do operador", () => {
  it("lead manda áudio: conversa cai em precisa_operador e o celular recebe o aviso curto, com nome, telefone e chip", async () => {
    const { repo, lead, diz } = cenario();
    await diz(null, true);
    expect(repo.conversas.get(lead.id)!.precisaOperador).toBe(true);
    expect(repo.avisosAoCelular).toHaveLength(1);
    const a = repo.avisosAoCelular[0]!;
    expect(a.destino).toBe(CELULAR);
    expect(a.ponto).toBe("midia");
    expect(a.texto).toBe("🌸Mandou ÁUDIO🌸\nNome: N\nWhatsApp: 5511900000001\nChip: chip-1");
    // Só avisa: a conversa não é pausada, e a Central segue com o item de sempre.
    expect(repo.paradas).toHaveLength(0);
    expect(repo.avisos.filter((x) => x.nivel === "operador")).toHaveLength(1);
  });

  it("não quebra o aviso de compra: depois do áudio, 'tenho 9' ainda avisa no formato exato da compra", async () => {
    const { repo, diz } = cenario();
    await diz("Quanto custa?");
    await diz(null, true);
    await diz("tenho 9");
    expect(repo.avisosAoCelular.map((x) => x.ponto)).toEqual(["midia", "escolheu_kit"]);
    expect(repo.avisosAoCelular[1]!.texto).toBe('🌸Respondeu VALORES🌸\n✅ MARCA A ✅\nNome: N ❤️\nWhatsApp: 5511900000001\nKit: 9 meses\nDisse: "tenho 9"');
  });

  it("organização sem o ponto de mídia configurado continua sem aviso ao celular no áudio", async () => {
    const config = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, parada: { ...PARADA, pontos: PARADA.pontos.filter((p) => p.id !== "midia") } });
    const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, "real"), config);
    const lead = repo.novoLead(`lead-sm${++n}`, { nome: "N", telefone: "(11) 90000-0001" });
    repo.chipPorLead.set(lead.id, "chip-1");
    const deps = { repo, agora: AGORA, ambiente: AMBIENTE, julgar: criarJulgar({ chave: null }), sortear: () => 0.5 };
    await atenderMensagem(deps, ORG, lead.id, { chave: `av${++n}`, messageId: null, texto: null, midia: true, conversationId: "conv-1" });
    expect(repo.avisosAoCelular).toHaveLength(0);
    expect(repo.conversas.get(lead.id)!.precisaOperador).toBe(true);
  });
});

describe("quantidadeSolta", () => {
  it("só depois da tabela, de 1 a 12, e só a frase que é a quantidade", () => {
    expect(quantidadeSolta("tenho 9", true)).toBe("quero o de 9 meses");
    expect(quantidadeSolta("tenho 4", true)).toBe("quero o de 4 meses");
    expect(quantidadeSolta("9", true)).toBe("quero o de 9 meses");
    expect(quantidadeSolta("tenho 9", false)).toBeNull();
    expect(quantidadeSolta("tenho 30", true)).toBeNull();
    expect(quantidadeSolta("tenho 2 filhos", true)).toBeNull();
  });
});

describe("janela de resposta do atendimento (8h–22h)", () => {
  const ritmo = configDisparoExemplo(ORG, "real").ritmo;
  const janela = { inicioMin: 480, fimMin: 1320 };
  const local = (iso: string) => new Date(new Date(iso).getTime() + 180 * 60_000); // hora local -03 → UTC

  it("dentro da janela a hora não muda", () => {
    const t = local("2026-10-14T15:00:00Z");
    expect(daJanelaDeResposta(t, janela, ritmo, () => 0.5).getTime()).toBe(t.getTime());
  });

  it("23h vai para as 8h do dia seguinte (mais sorteio de minutos); 5h vai para as 8h do mesmo dia; domingo vale igual", () => {
    const noite = daJanelaDeResposta(local("2026-10-14T23:00:00Z"), janela, ritmo, () => 0.5); // quarta 23h
    expect(noite.toISOString().slice(0, 13)).toBe("2026-10-15T11"); // 8h local (UTC-3) = 11h UTC; 0.5*20 = 10 min
    expect(noite.getUTCMinutes()).toBeGreaterThanOrEqual(0);
    const cedo = daJanelaDeResposta(local("2026-10-14T05:00:00Z"), janela, ritmo, () => 0);
    expect(cedo.toISOString().slice(0, 13)).toBe("2026-10-14T11");
    const domingoNoite = daJanelaDeResposta(local("2026-10-18T23:30:00Z"), janela, ritmo, () => 0);
    expect(domingoNoite.toISOString().slice(0, 13)).toBe("2026-10-19T11");
  });

  it("resposta decidida às 23h: toda a fila fica para depois das 8h, sem tocar a janela de prospecção", async () => {
    const agora = local("2026-10-14T23:00:00Z");
    const { repo, lead, diz } = cenario(agora);
    await diz("Quanto custa?");
    const envios = repo.enviosDo(lead.id);
    expect(envios.length).toBeGreaterThan(1);
    for (const e of envios) {
      const minutoLocal = new Date(e.enviarApos.getTime() - 180 * 60_000);
      const m = minutoLocal.getUTCHours() * 60 + minutoLocal.getUTCMinutes();
      expect(m).toBeGreaterThanOrEqual(480);
      expect(m).toBeLessThan(1320);
      expect(e.enviarApos.getTime()).toBeGreaterThan(agora.getTime());
    }
    const ordem = envios.map((e) => e.enviarApos.getTime());
    expect([...ordem].sort((a, b) => a - b)).toEqual(ordem); // a ordem do funil se mantém
  });
});

it("escolha de kit com dúvida de saúde avisa compra sem enviar fechamento automático", async () => {
  const { repo, lead, diz } = cenario();
  await diz("quero o de 9 meses, mas sou diabética, posso tomar?");
  expect(repo.conversas.get(lead.id)?.dados.kitEscolhido).toBe("9 meses");
  expect(repo.avisos.some(a => a.nivel === "compra")).toBe(true);
  expect(repo.enviosDo(lead.id).some(e => e.tipo.startsWith("fechamento"))).toBe(false);
});

it("quantidade em resposta à pergunta de estoque não é aviso de compra", async () => {
  const { repo, lead, diz } = cenario();
  await diz("quanto custa?");
  await repo.enfileirar(ORG, { leadId: lead.id, chipId: "chip-1", tipo: "historico", texto: "Quantas unidades ainda tem em casa?", midia: null, enviarApos: AGORA, estado: "simulado", motivo: null, daParada: false });
  await diz("tenho 4");
  expect(repo.avisos.filter(a => a.nivel === "compra")).toHaveLength(0);
  expect(repo.conversas.get(lead.id)?.dados.kitEscolhido).toBeNull();
});
