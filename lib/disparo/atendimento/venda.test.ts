/**
 * Ensaio EM MEMÓRIA do atendimento, perfil venda: os cenários do `ensaio.mjs`
 * de uma organização rodando no atendimento inteiro (`atenderMensagem`) contra um
 * repositório em memória, sem Jev (sem chave) e com a trava fechada.
 */
import { describe, expect, it } from "vitest";

import { CONFIG_METODO_EXEMPLO, CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import type { ConfigAtendimento } from "./config";
import { criarJulgar } from "./jev";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-10-14T13:00:00Z"); // quarta, 10h em São Paulo

let n = 0;
function cenario(config: ConfigAtendimento = CONFIG_VENDA_EXEMPLO) {
  const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), config);
  const lead = repo.novoLead(`lead-${++n}`);
  repo.chipPorLead.set(lead.id, "chip-ensaio");
  const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) };
  const diz = (texto: string | null, midia = false) =>
    atenderMensagem(deps, ORG, lead.id, { chave: `m${++n}`, messageId: null, texto, midia });
  return { repo, lead, diz, conversa: () => repo.conversas.get(lead.id)! };
}

describe("atendimento venda: aceite antes da tabela", () => {
  it("cliente com dúvida de preço recebe a tabela, não a resposta de reposição", async () => {
    const { repo, lead, diz, conversa } = cenario();
    repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
    await diz("Conta pra mim só não sei se cabe no meu bolso cliquei por concelhos da lin...");
    expect(repo.enviosDo(lead.id).map((e) => e.tipo)).toContain("tabela:seq");
    expect(repo.enviosDo(lead.id).map((e) => e.tipo)).not.toContain("reposicao");
    expect(conversa().dados.tabelaEnviada).toBe(true);
  });

  it("cliente que diz quero mais ñ é encerrado sem resposta", async () => {
    const { repo, lead, diz, conversa } = cenario();
    repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
    await diz("Quero mais ñ.");
    expect(conversa().etapa).toBe("perdido");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });

  it("objeção de preço antes da tabela começa pelo primeiro degrau", async () => {
    const { repo, lead, diz, conversa } = cenario();
    repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
    await diz("caro");
    expect(repo.enviosDo(lead.id).map((e) => e.tipo)).toContain("tabela:seq");
    expect(conversa().dados.degrau).toBe(0);
  });

  it("link sozinho fica com o operador sem envio automático", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("https://exemplo.com/video/1");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(conversa().precisaOperador).toBe(true);
  });
  it("'Quero sim' sem ter visto a tabela recebe a explicação e depois o funil de valores, e NÃO vira pronto para fechar", async () => {
    const { repo, lead, diz, conversa } = cenario();
    const r = await diz("Quero sim");
    const fila = repo.enviosDo(lead.id);
    expect(r.resultado).toBe("decidida");
    expect(fila[0]!.tipo).toBe("explicacao");
    expect(fila[0]!.midia?.nome).toBe("explica.ogg");
    expect(fila.slice(1).every((e) => e.tipo === "tabela:seq")).toBe(true);
    expect(fila.length).toBe(1 + 5);
    // Ritmo humano: a tabela sai de 29 a 34 s depois do áudio (não mais "depois de o áudio tocar inteiro").
    const depoisDoAudio = fila[1]!.enviarApos.getTime() - fila[0]!.enviarApos.getTime();
    expect(depoisDoAudio).toBeGreaterThanOrEqual(29_000);
    expect(depoisDoAudio).toBeLessThanOrEqual(34_000);
    expect(conversa().etapa).toBe("qualificando");
    expect(conversa().quente).toBe(false);
    expect(repo.avisos.filter((a) => a.nivel === "compra")).toHaveLength(0);
    // Uma decisão = uma resposta automática (explicação + tabela não gastam duas).
    expect(conversa().autoSeguidas).toBe(1);
  });

  it("'quero o de 9 meses' antes da tabela é compra de verdade", async () => {
    const { repo, diz, conversa } = cenario();
    await diz("quero o de 9 meses");
    expect(conversa().etapa).toBe("pronto_fechar");
    expect(repo.avisos.filter((a) => a.nivel === "compra")).toHaveLength(1);
  });
});

describe("atendimento venda: escada de preço", () => {
  it("cada objeção de preço desce um degrau, sem pular, até o de 5 meses; depois é com o operador (3 e 2 meses não entram na escada)", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("Quanto custa?");
    expect(conversa().dados.degrau).toBe(0);
    expect(conversa().dados.tabelaEnviada).toBe(true);

    // O operador entra no meio (zera as automáticas seguidas) para a escada inteira caber no teste.
    const passo = async (texto: string) => {
      repo.operadorFalou.add(lead.id);
      await diz(texto);
      repo.operadorFalou.delete(lead.id);
    };
    await passo("achei caro");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("degrau_9");
    // O degrau não fura o funil de valores ainda em fila: sai depois da última parte da tabela.
    const tabela = repo.enviosDo(lead.id).filter((e) => e.tipo === "tabela:seq");
    expect(repo.enviosDo(lead.id).at(-1)!.enviarApos.getTime()).toBeGreaterThan(tabela.at(-1)!.enviarApos.getTime());
    await passo("ainda está caro pra mim");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("degrau_7");
    await passo("muito caro mesmo");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("degrau_5");
    expect(repo.envios.some((e) => e.tipo === "entrada")).toBe(false);
    const antes = repo.enviosDo(lead.id).length;
    await passo("continua caro");
    expect(repo.enviosDo(lead.id)).toHaveLength(antes);
    expect(conversa().precisaOperador).toBe(true);
    expect(repo.avisos.filter((a) => a.nivel === "compra")).toHaveLength(0);
    expect(repo.envios.some((e) => /frasco/i.test(e.texto))).toBe(false);
  });
});

describe("atendimento venda: kits de entrada (3 e 2 meses) só com falta de dinheiro repetida", () => {
  const entradas = (repo: RepositorioEmMemoria, leadId: string) => repo.enviosDo(leadId).filter((e) => e.tipo === "entrada");

  it("a tabela e a escada automática nunca citam os kits de 3 e 2 meses", () => {
    const c = CONFIG_VENDA_EXEMPLO;
    if (c.perfil !== "venda") throw new Error("config de exemplo tem de ser venda");
    expect(c.escada).not.toContain("entrada");
    for (const id of c.escada) {
      const texto = c.respostas[id]!.flat().map((p) => p.texto).join(" ");
      expect(texto, id).not.toMatch(/\b[32] meses/);
    }
  });

  it("a primeira vez que diz que não tem dinheiro não oferece os kits de entrada; a repetida oferece, uma vez", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("Quanto custa?");
    repo.operadorFalou.add(lead.id);
    await diz("agora não tenho dinheiro");
    expect(entradas(repo, lead.id)).toHaveLength(0);
    await diz("continuo sem dinheiro, não tenho como pagar");
    expect(entradas(repo, lead.id)).toHaveLength(1);
    expect(entradas(repo, lead.id)[0]!.midia?.nome).toBe("entrada.png");
    expect(conversa().dados.entradaOferecida).toBe(true);
    // Uma vez só: a terceira vez é com o operador.
    const antes = repo.enviosDo(lead.id).length;
    await diz("não tenho dinheiro mesmo");
    expect(repo.enviosDo(lead.id)).toHaveLength(antes);
    expect(conversa().precisaOperador).toBe(true);
  });

  it("objeção de preço ('achei caro') sozinha não conta como falta de dinheiro", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quanto custa?");
    repo.operadorFalou.add(lead.id);
    await diz("achei caro");
    await diz("muito caro mesmo");
    expect(entradas(repo, lead.id)).toHaveLength(0);
  });
});

describe("atendimento venda: parada", () => {
  it("pedido de parar encerra: nada sai, nenhum aviso, fila do lead cancelada, nao_contatar", async () => {
    const { repo, lead, diz, conversa } = cenario();
    repo.pendentesDoMotor.push({ leadId: lead.id, estado: "pendente" });
    const r = await diz("para de me mandar mensagem");
    expect(r.envios).toBe(0);
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(repo.avisos).toHaveLength(0);
    expect(repo.pendentesDoMotor[0]!.estado).toBe("cancelado");
    expect(conversa().etapa).toBe("nao_contatar");
    // Escreveu de novo: só registrado.
    const de = await diz("oi?");
    expect(de.resultado).toBe("registrada");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });

  it("spam e xingamento são parada e pesam no chip (amarelo, depois vermelho)", async () => {
    const a = cenario();
    await a.diz("isso é spam, vou denunciar");
    expect(a.conversa().etapa).toBe("nao_contatar");
    expect(a.repo.chips.get("chip-ensaio")?.saude).toBe("amarelo");
  });

  it("'não, obrigada' é perdido, sem resposta", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("não, obrigada");
    expect(conversa().etapa).toBe("perdido");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });
});

describe("Método após recusa", () => {
  it("oferece quando a lead não tem interesse", async () => {
    const { repo, lead, diz, conversa } = cenario(CONFIG_METODO_EXEMPLO);
    await diz("não tenho interesse");
    expect(repo.enviosDo(lead.id).some((e) => e.tipo === "metodo_oferta:seq")).toBe(true);
    expect(conversa().dados.metodo).toMatchObject({ etapa: "ofertado", oferecido: true });
    expect(conversa().etapa).toBe("qualificando");
  });
  it("encerra como perdido com Método desligado", async () => {
    const config = structuredClone(CONFIG_METODO_EXEMPLO);
    if (config.perfil !== "venda" || !config.metodo) throw new Error("config do Método");
    config.metodo.ligado = false;
    const { repo, lead, diz, conversa } = cenario(config);
    await diz("não tenho interesse");
    expect(conversa().etapa).toBe("perdido");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });
  it("encerra como perdido após recusa da oferta", async () => {
    const { repo, lead, diz, conversa } = cenario(CONFIG_METODO_EXEMPLO);
    await diz("não tenho interesse");
    expect(conversa().dados.metodo.etapa).toBe("ofertado");
    repo.ofertaMetodoSaiu = true;
    await diz("não quero");
    expect(conversa().etapa).toBe("perdido");
    expect(repo.envios.filter((e) => e.leadId === lead.id && e.tipo === "metodo_oferta:seq")).toHaveLength(5);
  });
  it("encerra cliente sem oferta", async () => {
    const { repo, lead, diz, conversa } = cenario(CONFIG_METODO_EXEMPLO);
    repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
    await diz("não tenho interesse");
    expect(conversa().etapa).toBe("perdido");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });
  it("respeita parada dura sem oferta", async () => {
    const { repo, lead, diz, conversa } = cenario(CONFIG_METODO_EXEMPLO);
    await diz("para de me mandar mensagem");
    expect(conversa().etapa).toBe("nao_contatar");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });
});

describe("atendimento venda: limite de respostas automáticas", () => {
  it("a 3ª resposta automática seguida vira operador", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("quanto tempo demora pra chegar?");
    await diz("estou no trabalho agora");
    expect(conversa().autoSeguidas).toBe(2);
    const antes = repo.enviosDo(lead.id).length;
    await diz("vou pensar");
    expect(repo.enviosDo(lead.id)).toHaveLength(antes);
    expect(conversa().precisaOperador).toBe(true);
    expect(conversa().motivoOperador).toMatch(/limite de 2 respostas automáticas/);
    expect(repo.avisos.at(-1)!.nivel).toBe("operador");
  });

  it("o operador escrevendo no meio zera a contagem", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("quanto tempo demora pra chegar?");
    await diz("estou no trabalho agora");
    repo.operadorFalou.add(lead.id);
    await diz("vou pensar");
    expect(conversa().autoSeguidas).toBe(1);
    expect(conversa().precisaOperador).toBe(false);
  });
});

describe("atendimento venda: kit escolhido", () => {
  it("quem diz o kit recebe o pacote de fechamento, fica pronto para fechar e o operador é avisado", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("Quanto custa?");
    await diz("quero o de 12 meses");
    const fila = repo.enviosDo(lead.id).filter((e) => e.tipo.startsWith("fechamento"));
    expect(fila.map((e) => e.midia?.nome ?? e.texto.slice(0, 20))).toEqual(["fechamento-1.opus", "fechamento-2.opus", "Para fechar, me pass"]);
    expect(conversa().etapa).toBe("pronto_fechar");
    expect(conversa().quente).toBe(true);
    expect(conversa().dados.kitEscolhido).toBe("12 meses");
    const compra = repo.avisos.filter((a) => a.nivel === "compra");
    expect(compra).toHaveLength(1);
    expect(compra[0]!.corpo).toContain("12 meses");
    // Depois de quente, nada automático.
    const antes = repo.enviosDo(lead.id).length;
    await diz("ok, obrigada");
    expect(repo.enviosDo(lead.id)).toHaveLength(antes);
    expect(repo.avisos.filter((a) => a.nivel === "compra")).toHaveLength(1);
  });

  it("'quero fechar' SEM dizer a quantidade não é compra: depois da tabela pergunta o kit, sem aviso e sem esquentar; '12 meses' manda o pacote", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("Quanto custa?");
    repo.operadorFalou.add(lead.id); // zera as automáticas seguidas: o limite não é o assunto
    await diz("quero fechar");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("pergunta_kit");
    expect(conversa().etapa).toBe("qualificando");
    expect(conversa().quente).toBe(false);
    expect(conversa().precisaOperador).toBe(false);
    expect(repo.avisos).toHaveLength(0);
    expect(repo.enviosDo(lead.id).some((e) => e.tipo.startsWith("fechamento"))).toBe(false);

    repo.operadorFalou.delete(lead.id);
    await diz("12 meses");
    const pacote = repo.enviosDo(lead.id).filter((e) => e.tipo.startsWith("fechamento"));
    expect(pacote.map((e) => e.midia?.nome ?? e.texto.slice(0, 20))).toEqual(["fechamento-1.opus", "fechamento-2.opus", "Para fechar, me pass"]);
    expect(conversa().etapa).toBe("pronto_fechar");
    expect(conversa().quente).toBe(true);
    expect(repo.avisos.filter((a) => a.nivel === "compra")).toHaveLength(1);
  });

  it("'quero fechar' antes de ver os valores recebe o funil de valores (sem explicação), sem parar nem avisar", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("quero fechar");
    const fila = repo.enviosDo(lead.id);
    expect(fila.length).toBeGreaterThan(0);
    expect(fila.every((e) => e.tipo === "tabela:seq")).toBe(true);
    expect(conversa().dados.tabelaEnviada).toBe(true);
    expect(conversa().etapa).toBe("qualificando");
    expect(conversa().quente).toBe(false);
    expect(repo.avisos).toHaveLength(0);
  });

  it("frascos não viram meses: pergunta o kit e avisa sem kit", async () => {
    const { repo, lead, diz } = cenario();
    await diz("Quanto custa?");
    await diz("quero 6 frascos");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("pergunta_kit");
  });

  it("pediu o site com o kit escolhido: recomenda o de cima e manda os dois links, o de cima primeiro", async () => {
    const { repo, lead, diz } = cenario();
    await diz("quero o de 9 meses, me manda o site");
    const t = repo.enviosDo(lead.id).at(-1)!.texto;
    expect(t.indexOf("k12")).toBeGreaterThan(-1);
    expect(t.indexOf("k12")).toBeLessThan(t.indexOf("k9"));
  });
});

describe("atendimento venda: objeções e dúvidas", () => {
  it("dúvida de golpe recebe o áudio da objeção e a pergunta de retorno; repetida vai ao operador", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("isso é golpe? vocês têm cnpj?");
    const fila = repo.enviosDo(lead.id);
    expect(fila.map((e) => e.midia?.nome ?? "texto")).toEqual(["obj-golpe.ogg", "texto"]);
    expect(fila.at(-1)!.texto).toMatch(/\?$/);
    await diz("mas é golpe mesmo?");
    expect(conversa().precisaOperador).toBe(true);
  });

  it("no máximo 2 objeções de tipos diferentes", async () => {
    const { repo, lead, diz, conversa } = cenario();
    const comOperador = async (t: string) => {
      repo.operadorFalou.add(lead.id);
      await diz(t);
      repo.operadorFalou.delete(lead.id);
    };
    await comOperador("tenho medo de golpe");
    await comOperador("vou pensar");
    await comOperador("estou no trabalho");
    expect(conversa().dados.objecoesRespondidas).toHaveLength(2);
    expect(conversa().precisaOperador).toBe(true);
  });

  it("áudio do lead e reclamação vão ao operador sem resposta", async () => {
    const a = cenario();
    await a.diz(null, true);
    expect(a.repo.enviosDo(a.lead.id)).toHaveLength(0);
    expect(a.conversa().precisaOperador).toBe(true);
    const b = cenario();
    await b.diz("nunca chegou meu pedido, quero estorno");
    expect(b.repo.enviosDo(b.lead.id)).toHaveLength(0);
    expect(b.conversa().motivoOperador).toMatch(/reclamação/);
  });

  it("assunto da lista de desvios da casa vai ao operador", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("queria saber do reembolso");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(conversa().motivoOperador).toMatch(/reembolso/);
  });

  it("cliente que já comprou recebe a resposta de reposição, uma vez", async () => {
    const { repo, lead, diz, conversa } = cenario();
    repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
    await diz("estou amando o resultado");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("reposicao");
    await diz("quanto custa?");
    expect(repo.enviosDo(lead.id).some((e) => e.tipo.startsWith("tabela"))).toBe(true);
    expect(conversa().precisaOperador).toBe(false);
  });

  it("cliente que só demonstra interesse (sem falar do tratamento) recebe o funil de valores, sem a explicação", async () => {
    const { repo, lead, diz } = cenario();
    repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
    await diz("sim, pode me contar");
    const tipos = repo.enviosDo(lead.id).map((e) => e.tipo);
    expect(tipos).not.toContain("reposicao");
    expect(tipos.some((t) => t.startsWith("tabela"))).toBe(true);
    expect(tipos.some((t) => t.startsWith("explicacao"))).toBe(false);
  });

  it("saudação com 'bom' e negação do tratamento não viram reposição", async () => {
    for (const texto of ["bom dia, quero saber mais", "não estou gostando, me conta", "não estou tomando mais, pode falar"]) {
      const { repo, lead, diz } = cenario();
      repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
      await diz(texto);
      expect(repo.enviosDo(lead.id).map((e) => e.tipo), texto).not.toContain("reposicao");
    }
  });

  it("'sim' depois da reposição vai ao funil; novo interesse depois do funil não manda a explicação", async () => {
    const { repo, lead, diz } = cenario();
    repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
    await diz("estou amando o resultado");
    await diz("sim, pode me contar");
    expect(repo.enviosDo(lead.id).some((e) => e.tipo.startsWith("tabela"))).toBe(true);
    await diz("quero saber mais");
    expect(repo.enviosDo(lead.id).some((e) => e.tipo.startsWith("explicacao"))).toBe(false);
  });

  it("cliente que diz que está tomando e gostando, com interesse, recebe a reposição", async () => {
    const { repo, lead, diz } = cenario();
    repo.leads.get(lead.id)!.campos = { trilha: "posvenda" };
    await diz("estou tomando e gostando, quero saber mais");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("reposicao");
  });
});

describe("atendimento venda: idempotência e lead fora", () => {
  it("a mesma mensagem duas vezes decide uma vez só", async () => {
    const { repo, lead } = cenario();
    const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) };
    const m = { chave: "wamid-1", messageId: null, texto: "Quanto custa?", midia: false };
    expect((await atenderMensagem(deps, ORG, lead.id, m)).resultado).toBe("decidida");
    expect((await atenderMensagem(deps, ORG, lead.id, m)).resultado).toBe("repetida");
    expect(repo.enviosDo(lead.id)).toHaveLength(5);
  });

  it("lead bloqueado só registra; atendimento desligado não lê", async () => {
    const { repo, lead, diz } = cenario();
    repo.leads.get(lead.id)!.bloqueado = true;
    expect((await diz("Quanto custa?")).resultado).toBe("registrada");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    repo.atendimento = { ...CONFIG_VENDA_EXEMPLO, ligado: false };
    expect((await diz("Quanto custa?")).resultado).toBe("sem_atendimento");
  });

  it("mídia que não está na biblioteca barra a resposta e o operador assume", async () => {
    const { repo, lead, diz, conversa } = cenario();
    const semId = structuredClone(CONFIG_VENDA_EXEMPLO);
    if (semId.perfil !== "venda") throw new Error("perfil");
    semId.respostas["entrega"] = [[{ texto: "", midia: { id: null, nome: "sumiu.ogg" } }]];
    repo.atendimento = semId;
    await diz("quanto tempo demora pra chegar?");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(conversa().motivoOperador).toMatch(/biblioteca/);
  });
});
