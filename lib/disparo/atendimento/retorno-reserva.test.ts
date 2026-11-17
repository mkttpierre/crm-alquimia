import { describe, expect, it } from "vitest";

import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { atendimentoSchema } from "./config";
import type { EnvioDaFila } from "../motor";
import { lerMensagem } from "../leitura";
import { conversaNova } from "./estado";
import { criarJulgar } from "./jev";
import { conferirRetornoReserva } from "./retorno-reserva";
import { decidirVenda } from "./venda";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-10-28T18:00:00Z");
let n = 0;
function cenario(ligado = true) {
  const at = atendimentoSchema.parse({
    ...CONFIG_VENDA_EXEMPLO, retornoReserva: { ligado },
    objecoes: [{ id: "sem_dinheiro", gatilho: "sem dinheiro|nao tenho dinheiro|recebo", jev: "falta de dinheiro", midia: { id: "00000000-0000-4000-8000-000000000999", nome: "sem-dinheiro.ogg" }, pergunta: "Entendo. Podemos conversar?" }],
  });
  const cfg = configDisparoExemplo(ORG, "real");
  cfg.ligado = true;
  cfg.ritmo = { ...cfg.ritmo, feriados: [], limiteAutomaticasSeguidas: 5 };
  const repo = new RepositorioEmMemoria(ORG, cfg, at);
  const lead = repo.novoLead(`lead-${++n}`);
  lead.nome = "Maria Silva";
  repo.chipPorLead.set(lead.id, "chip-1");
  repo.conversas.set(lead.id, { ...conversaNova(), ultimaAutoEm: null });
  const deps = { repo, agora: AGORA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, julgar: criarJulgar({ chave: null }), sortear: () => 0 };
  const diz = (texto: string) => atenderMensagem(deps, ORG, lead.id, { chave: `m-${++n}`, messageId: null, texto, midia: false });
  const retornos = () => repo.enviosDo(lead.id).filter((e) => e.tipo === "retorno_reserva" && e.estado === "pendente");
  return { repo, lead, cfg, deps, diz, retornos, conversa: () => repo.conversas.get(lead.id)! };
}

describe("retorno da reserva: atendimento inteiro sem canal nem banco real", () => {
  it("agenda além do áudio e guarda kit e último degrau", async () => {
    const c = cenario();
    Object.assign(c.conversa().dados, { kitEscolhido: "9 meses", tabelaEnviada: true, degrau: 1 });
    await c.diz("não tenho dinheiro, recebo dia 5");
    expect(c.repo.enviosDo(c.lead.id).some((e) => e.midia?.nome === "sem-dinheiro.ogg")).toBe(true);
    expect(c.retornos()).toHaveLength(1);
    expect(c.retornos()[0]).toMatchObject({ origem: "auto", enviarApos: new Date("2026-11-05T12:00:00Z"), daParada: false });
    expect(c.retornos()[0]!.texto).toContain("Olá Maria, tudo bem?");
    expect(c.retornos()[0]!.texto).toContain("Seu kit de 9 meses está separado aqui.");
    expect(c.conversa().dados).toMatchObject({ retornoEm: "2026-11-05T12:00:00.000Z", retornoPedido: { kit: "9 meses", condicao: "degrau_9" } });
  });
  it("remarca um único pendente e mantém os kits de entrada na segunda objeção", async () => {
    const c = cenario();
    await c.diz("sem dinheiro, recebo dia 5");
    await c.diz("continuo sem dinheiro, recebo dia 10");
    expect(c.retornos()).toHaveLength(1);
    expect(c.retornos()[0]!.enviarApos.toISOString()).toBe("2026-11-10T12:00:00.000Z");
    expect(c.repo.envios.find((e) => e.tipo === "retorno_reserva" && e.cancelado)?.cancelado).toMatch(/remarcado/);
    expect(c.repo.enviosDo(c.lead.id).some((e) => e.tipo === "entrada")).toBe(true);
  });
  it("lê data isolada depois da falta de dinheiro", async () => {
    const c = cenario();
    await c.diz("sem dinheiro");
    await c.diz("dia 5");
    expect(c.retornos()).toHaveLength(1);
  });
  it("resposta comum preserva o retorno sem empurrar a resposta imediata", async () => {
    const c = cenario();
    await c.diz("sem dinheiro, recebo dia 5");
    await c.diz("quanto tempo demora a entrega?");
    expect(c.retornos()).toHaveLength(1);
    const entrega = c.repo.enviosDo(c.lead.id).find((e) => e.tipo === "entrega")!;
    expect(entrega.enviarApos.getTime()).toBeLessThan(AGORA.getTime() + 60 * 60 * 1000);
  });
  it.each(["quero o de 9 meses", "já paguei", "não quero mais", "pare de me mandar mensagem"])("cancela com motivo ao receber '%s'", async (texto) => {
    const c = cenario();
    await c.diz("sem dinheiro, recebo dia 5");
    await c.diz(texto);
    expect(c.retornos()).toHaveLength(0);
    expect(c.repo.envios.find((e) => e.tipo === "retorno_reserva")?.cancelado).toMatch(/compra|encerr|parar|não quer/);
    expect(c.conversa().dados.retornoEm).toBeNull();
  });
  it("humano que assume cancela o retorno", async () => {
    const c = cenario();
    await c.diz("sem dinheiro, recebo dia 5");
    c.repo.forceHuman.add(c.lead.id);
    await c.diz("bom dia");
    expect(c.retornos()).toHaveLength(0);
    expect(c.repo.envios.find((e) => e.tipo === "retorno_reserva")?.cancelado).toMatch(/humano/);
  });
  it("sem nome nem kit remove vocativo e usa linha genérica", async () => {
    const c = cenario();
    c.lead.nome = null;
    await c.diz("sem dinheiro, recebo dia 5");
    expect(c.retornos()[0]?.texto).toBe("Olá, tudo bem? Consegui manter reservado o seu pedido até hoje, como combinamos 🌸 Está tudo separado aqui com as condições que te passei. Para eu já separar e enviar, me confirma: prefere pagar no Pix ou no cartão?");
  });
  it("modelo do tenant substitui variáveis no padrão existente", async () => {
    const c = cenario();
    c.cfg.modelos.retorno_reserva = ["{nome_virgula}hoje é o dia! {linha_do_pedido}"];
    await c.diz("sem dinheiro, recebo dia 5");
    expect(c.retornos()[0]?.texto).toBe("Maria, hoje é o dia! Está tudo separado aqui com as condições que te passei.");
  });
  it("domingo fechado vai à janela existente do dia seguinte", async () => {
    const c = cenario();
    c.cfg.ritmo.janela = { semana: [{ inicio: 600, fim: 1080 }], sabado: [], domingo: [] };
    await c.diz("sem dinheiro, recebo domingo");
    expect(c.retornos()[0]?.enviarApos.toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });
  it.each([false, true])("sem data, ou recurso desligado (%s), não agenda", async (ligado) => {
    const c = cenario(ligado);
    await c.diz(ligado ? "sem dinheiro" : "sem dinheiro, recebo dia 5");
    expect(c.retornos()).toHaveLength(0);
  });
  it("não agenda só por existir data, sem falta de dinheiro", async () => {
    const c = cenario();
    await c.diz("vou trabalhar sexta");
    expect(c.retornos()).toHaveLength(0);
  });
  it("lead não contatável não ganha retorno", async () => {
    const c = cenario();
    c.lead.campos.nao_contatar = true;
    await c.diz("sem dinheiro, recebo dia 5");
    expect(c.retornos()).toHaveLength(0);
  });
});

it("agenda retorno com áudio também para cliente antigo", async () => {
  const c = cenario();
  c.lead.campos.trilha = "posvenda";
  await c.diz("sem dinheiro, recebo dia 5");
  expect(c.repo.enviosDo(c.lead.id).some(e => e.midia?.nome === "sem-dinheiro.ogg")).toBe(true);
  expect(c.retornos()).toHaveLength(1);
});

describe("compro dia X", () => {
  /** A casa com a resposta na hora e o modelo próprio do retorno (textos fictícios; os da casa vivem no banco). */
  function comCompra(o: { confirma?: boolean; modelo?: boolean } = {}) {
    const c = cenario();
    const at = c.repo.atendimento as Extract<typeof c.repo.atendimento, { perfil: "venda" }>;
    if (o.confirma !== false) at.respostas.compro_dia_confirma = [[{ texto: "Combinado{virg_nome}! Te chamo no dia.", midia: null }]];
    if (o.modelo !== false) c.cfg.modelos.retorno_compra = ["Oi {nome}, hoje é o dia que você combinou 🌸 {linha_do_pedido} Prefere Pix ou cartão?"];
    Object.assign(c.conversa().dados, { tabelaEnviada: true, kitEscolhido: "6 meses" });
    return c;
  }

  it("responde na hora, agenda o retorno no dia com o modelo retorno_compra e grava o motivo", async () => {
    const c = comCompra();
    await c.diz("compro dia 20");
    const tipos = c.repo.enviosDo(c.lead.id).map((e) => e.tipo);
    expect(tipos).toContain("compro_dia_confirma");
    expect(c.retornos()).toHaveLength(1);
    expect(c.retornos()[0]!.enviarApos.toISOString()).toBe("2026-11-20T12:00:00.000Z");
    expect(c.retornos()[0]!.texto).toContain("hoje é o dia que você combinou");
    expect(c.retornos()[0]!.texto).toContain("Seu kit de 6 meses está separado aqui.");
    expect(c.conversa().dados.retornoPedido).toMatchObject({ kit: "6 meses", motivo: "compra" });
    expect(c.conversa().quente).toBe(false);
    expect(c.repo.avisos.filter((a) => a.nivel === "compra")).toHaveLength(0);
  });

  it("sem retorno_compra, NÃO agenda o texto de reserva (o bot nunca prometeu reserva): avisa o operador", async () => {
    const c = comCompra({ modelo: false });
    await c.diz("fecho dia 20");
    expect(c.retornos()).toHaveLength(0);
    expect(c.repo.envios.some((e) => e.tipo === "retorno_reserva")).toBe(false);
    expect(c.conversa().dados.retornoEm).toBeNull();
    const aviso = c.repo.avisos.find((a) => a.titulo === "Retorno da reserva não agendado");
    expect(aviso?.corpo).toMatch(/retorno_compra/);
  });

  it("'quero fechar, pago dia 20' avisa que quer fechar (evento quer_fechar), além da confirmação", () => {
    const at = atendimentoSchema.parse({
      ...CONFIG_VENDA_EXEMPLO,
      retornoReserva: { ligado: true },
      respostas: { ...(CONFIG_VENDA_EXEMPLO as { respostas: object }).respostas, compro_dia_confirma: [[{ texto: "Combinado! Te chamo no dia." }]] },
    }) as Extract<ReturnType<typeof atendimentoSchema.parse>, { perfil: "venda" }>;
    const texto = "quero fechar, pago dia 20";
    const leitura = lerMensagem(texto);
    expect(leitura.intencao).toBe("quer_fechar");
    const estado = conversaNova();
    estado.dados.tabelaEnviada = true;
    const d = decidirVenda({
      config: at, leitura, texto, estado, lead: { id: "l1", nome: "Maria", telefone: "5511900000000", campos: {} },
      plano: { tipo: "nenhum" }, limiteAutomaticas: 5, proibidos: [], agora: AGORA, fusoMinutos: -180,
    });
    expect(d.eventos).toContain("quer_fechar");
    expect(d.acoes.some((a) => a.tipo === "responder" && a.resposta === "compro_dia_confirma")).toBe(true);
  });

  it("'fecho dia 20' sem 'quero fechar' não dispara o evento", () => {
    const at = atendimentoSchema.parse({ ...CONFIG_VENDA_EXEMPLO, retornoReserva: { ligado: true } }) as Extract<ReturnType<typeof atendimentoSchema.parse>, { perfil: "venda" }>;
    const texto = "compro dia 20";
    const estado = conversaNova();
    estado.dados.tabelaEnviada = true;
    const d = decidirVenda({
      config: at, leitura: lerMensagem(texto), texto, estado, lead: { id: "l1", nome: "Maria", telefone: "5511900000000", campos: {} },
      plano: { tipo: "nenhum" }, limiteAutomaticas: 5, proibidos: [], agora: AGORA, fusoMinutos: -180,
    });
    expect(d.retornoEm).toBe("2026-11-20T12:00:00.000Z");
    expect(d.eventos ?? []).not.toContain("quer_fechar");
  });

  it("sem compro_dia_confirma, não responde na hora, mas agenda o retorno", async () => {
    const c = comCompra({ confirma: false });
    await c.diz("compro dia 20");
    expect(c.repo.enviosDo(c.lead.id).filter((e) => e.tipo !== "retorno_reserva")).toHaveLength(0);
    expect(c.retornos()).toHaveLength(1);
  });

  it("antes da tabela não vira retorno de compra", async () => {
    const c = comCompra();
    Object.assign(c.conversa().dados, { tabelaEnviada: false });
    await c.diz("compro dia 20");
    expect(c.retornos()).toHaveLength(0);
    expect(c.repo.enviosDo(c.lead.id).map((e) => e.tipo)).not.toContain("compro_dia_confirma");
  });

  it("escolher o kit com data é compra agora: vai ao operador, sem retorno", async () => {
    const c = comCompra();
    await c.diz("quero o de 9 meses, pago dia 20");
    expect(c.retornos()).toHaveLength(0);
    expect(c.repo.avisos.some((a) => a.nivel === "compra")).toBe(true);
  });

  it("recurso desligado: nada muda", async () => {
    const c = cenario(false);
    Object.assign(c.conversa().dados, { tabelaEnviada: true });
    await c.diz("compro dia 20");
    expect(c.retornos()).toHaveLength(0);
  });

  it("falta de dinheiro segue sem o motivo de compra", async () => {
    const c = comCompra();
    await c.diz("não tenho dinheiro, recebo dia 5");
    expect(c.retornos()).toHaveLength(1);
    expect(c.conversa().dados.retornoPedido?.motivo).toBeUndefined();
    expect(c.retornos()[0]!.texto).toContain("Consegui manter reservado");
  });
});

describe("o retorno do teste A/B e o 'quer fechar' com data", () => {
  const envioDoRetorno = (leadId: string): EnvioDaFila =>
    ({ id: "r1", leadId, chipId: "chip-1", tipo: "retorno_reserva", origem: "auto", texto: "x", midia: null, midiaId: null, enviarApos: AGORA, estado: "pendente", tentativas: 0, criadoEm: AGORA, daParada: false }) as EnvioDaFila;
  const comRetorno = (campos: Record<string, unknown>) => {
    const c = cenario();
    c.lead.campos = campos;
    Object.assign(c.conversa().dados, { retornoEm: "2026-11-20T12:00:00.000Z", retornoPedido: { kit: null, condicao: null, motivo: "compra" } });
    return c;
  };

  it("no dia, o retorno do produto P4/P2 do teste A/B (trilha de cliente + ab_teste) NÃO é cancelado como compra", async () => {
    const c = comRetorno({ trilha: "posvenda", classe: "P4", ab_teste: "1211" });
    expect(await conferirRetornoReserva(c.repo, ORG, envioDoRetorno(c.lead.id), AGORA)).toBeNull();
  });

  it("irmão: sem ab_teste, a trilha de cliente segue cancelando", async () => {
    const c = comRetorno({ trilha: "posvenda", classe: "P4" });
    expect(await conferirRetornoReserva(c.repo, ORG, envioDoRetorno(c.lead.id), AGORA)).toMatch(/compra ou fechamento/);
  });

  it("irmão: com ab_teste e compra aprovada, cancela (já comprou)", async () => {
    const c = comRetorno({ trilha: "posvenda", ab_teste: "1211", compras_aprovadas: { "TX-1": "aprovada" } });
    expect(await conferirRetornoReserva(c.repo, ORG, envioDoRetorno(c.lead.id), AGORA)).toMatch(/compra ou fechamento/);
  });

  /**
   * Decisão do lead: a confirmação diz "te chamo no dia que você falou", então o retorno que a PRÓPRIA
   * decisão do "compro dia X" agendou não cai pelo `quer_fechar` dessa mesma decisão. O aviso ao operador sai igual.
   */
  function comAvisoDeQuererFechar() {
    const c = cenario();
    c.repo.atendimento = atendimentoSchema.parse({
      ...c.repo.atendimento,
      respostas: { ...(c.repo.atendimento as { respostas: object }).respostas, compro_dia_confirma: [[{ texto: "Anotei aqui e te chamo no dia que você falou." }]] },
      parada: {
        celular: "5511900000002",
        pontos: [{ id: "quer_comprar", evento: "quer_fechar", titulo: "QUER COMPRAR", parar: false, aviso: "🌸{titulo}🌸\nNome: {nome}\nWhatsApp: {telefone}\nChip: {chip}" }],
      },
    });
    c.cfg.modelos.retorno_compra = ["Oi {nome}, hoje é o dia que você combinou 🌸 {linha_do_pedido} Prefere Pix ou cartão?"];
    Object.assign(c.conversa().dados, { tabelaEnviada: true });
    return c;
  }

  it("'vou comprar dia 20' (lido como quer_fechar) confirma, avisa o operador E deixa o retorno agendado", async () => {
    const c = comAvisoDeQuererFechar();
    await c.diz("vou comprar dia 20");
    expect(c.repo.enviosDo(c.lead.id).map((e) => e.tipo)).toContain("compro_dia_confirma");
    expect(c.repo.avisosAoCelular.filter((a) => a.ponto === "quer_comprar")).toHaveLength(1);
    expect(c.retornos()).toHaveLength(1);
    expect(c.retornos()[0]!.enviarApos.toISOString()).toBe("2026-11-20T12:00:00.000Z");
    expect(c.conversa().dados.retornoEm).toBe("2026-11-20T12:00:00.000Z");
    expect(c.conversa().dados.retornoPedido?.motivo).toBe("compra");
  });

  it("a mensagem seguinte da lead que fecha a compra cancela o retorno, como antes", async () => {
    const c = comAvisoDeQuererFechar();
    await c.diz("vou comprar dia 20");
    expect(c.retornos()).toHaveLength(1);
    await c.diz("quero fechar");
    expect(c.retornos()).toHaveLength(0);
    expect(c.repo.envios.find((e) => e.tipo === "retorno_reserva")?.cancelado).toMatch(/compra ou fechamento/);
    expect(c.conversa().dados.retornoEm).toBeNull();
  });

  it("'quero fechar' sem data, sem retorno agendado nesta decisão, segue cancelando o retorno anterior da falta de dinheiro", async () => {
    const c = comAvisoDeQuererFechar();
    await c.diz("não tenho dinheiro, recebo dia 5");
    expect(c.retornos()).toHaveLength(1);
    await c.diz("quero fechar");
    expect(c.retornos()).toHaveLength(0);
  });
});
