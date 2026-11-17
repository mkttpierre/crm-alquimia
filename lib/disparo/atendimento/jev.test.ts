/**
 * Jev na leitura: fetch MOCKADO, nenhuma chamada real. Prova que sem chave nada
 * é chamado e valem as regras, que a regra de parada vence o Jev sempre, que o
 * Jev confiante decide quando as regras não acham nada, e que erro de rede ou
 * status ruim cai nas regras sem derrubar o atendimento.
 */
import { describe, expect, it, vi } from "vitest";

import { combinar, lerMensagem } from "../leitura";
import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { planejarComJev } from "./agente";
import { atenderMensagem } from "./atendimento";
import { criarJulgar, type Julgar, MODELO_JEV_PADRAO, URL_JEV } from "./jev";
import { leituraDeJev, lerComJev, leituraProspeccaoDeJev, lerProspeccaoComJev } from "./leitura-jev";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-10-14T13:00:00Z");

const resposta = (answers: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => ({ answers, usage: { input_tokens: 10, output_tokens: 2 } }) }) as Response;

describe("cliente do Jev", () => {
  it("sem chave não chama a rede e devolve null", async () => {
    const f = vi.fn();
    const julgar = criarJulgar({ chave: "", fetch: f as unknown as typeof fetch });
    expect(await julgar({}, { x: { type: "noul", instructions: "?" } })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("POST no endpoint de decisões, com o modelo e a chave no header (nunca na URL)", async () => {
    const f = vi.fn(async () => resposta({ x: { type: "noul", noul: 0.9 } }));
    const julgar = criarJulgar({ chave: "chave-de-teste", fetch: f as unknown as typeof fetch });
    const r = await julgar({ a: 1 }, { x: { type: "noul", instructions: "?" } });
    expect(r?.respostas.x).toEqual({ type: "noul", noul: 0.9 });
    expect(r?.tokens).toBe(12);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_JEV);
    expect(url).not.toContain("chave-de-teste");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer chave-de-teste");
    expect(JSON.parse(init.body as string).model).toBe(MODELO_JEV_PADRAO);
  });

  it("429 tenta mais uma vez; erro de rede e 500 viram null", async () => {
    const f = vi.fn().mockResolvedValueOnce(resposta(null, 429)).mockResolvedValueOnce(resposta({ x: { type: "noul", noul: 0.1 } }));
    expect(await criarJulgar({ chave: "k", fetch: f as unknown as typeof fetch, esperaMs: 0 })({}, { x: { type: "noul", instructions: "?" } })).not.toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
    const rede = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await criarJulgar({ chave: "k", fetch: rede as unknown as typeof fetch })({}, { x: { type: "noul", instructions: "?" } })).toBeNull();
    const ruim = vi.fn(async () => resposta(null, 500));
    expect(await criarJulgar({ chave: "k", fetch: ruim as unknown as typeof fetch })({}, { x: { type: "noul", instructions: "?" } })).toBeNull();
  });
});

describe("leitura com o Jev", () => {
  it("link sozinho vai ao operador mesmo se o Jev indicar interesse", async () => {
    const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), CONFIG_VENDA_EXEMPLO);
    const lead = repo.novoLead("link");
    const f = vi.fn(async () => resposta({ intencao: { type: "choice", choice: "interesse", confidence: 0.99 }, parar: { type: "noul", noul: 0.01 } }));
    await atenderMensagem({ repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: "k", fetch: f as unknown as typeof fetch }) }, ORG, lead.id, {
      chave: "link", messageId: null, texto: "https://exemplo.com/video/1", midia: false,
    });
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(repo.conversas.get(lead.id)!.precisaOperador).toBe(true);
  });
  it("certeza de 'parar' vira parada; dúvida derruba a confiança abaixo do corte", () => {
    const parar = leituraDeJev({ intencao: { type: "choice", choice: "interesse", confidence: 0.9 }, parar: { type: "noul", noul: 0.85 } });
    expect(parar?.intencao).toBe("parada");
    const duvida = leituraDeJev({ intencao: { type: "choice", choice: "interesse", confidence: 0.9 }, parar: { type: "noul", noul: 0.6 } });
    expect(duvida?.confianca).toBeLessThan(0.7);
    expect(leituraDeJev({ intencao: { type: "choice", choice: "inventada", confidence: 0.99 } })).toBeNull();
  });

  it("a regra de parada SEMPRE vence o Jev", async () => {
    const julgar = vi.fn(async () => ({
      respostas: { intencao: { type: "choice" as const, choice: "interesse", confidence: 0.99 }, quente: { type: "noul" as const, noul: 0.95 } },
      tokens: 1,
    }));
    const ia = await lerComJev(julgar as unknown as Julgar, { texto: "para de me mandar mensagem", nossaUltima: null, contexto: "x", cliente: false });
    const r = combinar(lerMensagem("para de me mandar mensagem"), ia);
    expect(r.intencao).toBe("parada");
    expect(r.discordou).toBe(true);
  });

  it("no atendimento inteiro: Jev dizendo 'interesse' para quem pediu pra parar não manda nada (e o Jev nem é chamado)", async () => {
    const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), CONFIG_VENDA_EXEMPLO);
    const lead = repo.novoLead("l1");
    const f = vi.fn(async () => resposta({ intencao: { type: "choice", choice: "interesse", confidence: 0.99 } }));
    const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: "k", fetch: f as unknown as typeof fetch }) };
    await atenderMensagem(deps, ORG, lead.id, { chave: "a", messageId: null, texto: "me tira dessa lista", midia: false });
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
    expect(repo.conversas.get(lead.id)!.etapa).toBe("nao_contatar");
    expect(f).not.toHaveBeenCalled();
  });

  it("Jev confiante decide quando as regras não leem nada; sem chave, as mesmas palavras vão ao operador", async () => {
    const texto = "hmm e aí, como faço pra ter isso aqui em casa logo";
    const comJev = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), CONFIG_VENDA_EXEMPLO);
    const a = comJev.novoLead("l2");
    const f = vi.fn(async () => resposta({ intencao: { type: "choice", choice: "pergunta_preco", confidence: 0.9 }, parar: { type: "noul", noul: 0.01 } }));
    await atenderMensagem({ repo: comJev, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: "k", fetch: f as unknown as typeof fetch }) }, ORG, a.id, {
      chave: "b",
      messageId: null,
      texto,
      midia: false,
    });
    expect(comJev.enviosDo(a.id)[0]!.tipo).toBe("tabela:seq");

    const semJev = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), CONFIG_VENDA_EXEMPLO);
    const b = semJev.novoLead("l3");
    await atenderMensagem({ repo: semJev, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: undefined }) }, ORG, b.id, { chave: "c", messageId: null, texto, midia: false });
    expect(semJev.enviosDo(b.id)).toHaveLength(0);
    expect(semJev.conversas.get(b.id)!.precisaOperador).toBe(true);
  });

  it("objeção pelo Jev: escolhe a peça; dúvida sensível só sai pelo gatilho exato", async () => {
    if (CONFIG_VENDA_EXEMPLO.perfil !== "venda") throw new Error("perfil");
    const escolhe = (opcao: string, conf = 0.9) =>
      vi.fn(async () => ({ respostas: { objecao: { type: "choice" as const, choice: opcao, confidence: conf } }, tokens: 1 })) as unknown as Julgar;
    const p = await planejarComJev(CONFIG_VENDA_EXEMPLO, "não sei se dá certo comigo não", { objecoesUsadas: [] }, null, escolhe("funciona"));
    expect(p.tipo === "objecao" && p.objecao.id).toBe("funciona");
    const saude = await planejarComJev(CONFIG_VENDA_EXEMPLO, "tomo remédio de tireoide, pode?", { objecoesUsadas: [] }, null, escolhe("saude"));
    expect(saude.tipo).toBe("operador");
    const fraco = await planejarComJev(CONFIG_VENDA_EXEMPLO, "não sei se dá certo comigo não", { objecoesUsadas: [] }, null, escolhe("funciona", 0.5));
    expect(fraco.tipo).toBe("nenhum");
  });
});

describe("leitura do Jev: prospecção e falhas seguras", () => {
  it("prospecção: certeza de 'parar' vira parada; opção inventada é descartada", () => {
    const parar = leituraProspeccaoDeJev({ intencao: { type: "choice", choice: "objecao", confidence: 0.9 }, parar: { type: "noul", noul: 0.9 } });
    expect(parar?.intencao).toBe("parada");
    const duvida = leituraProspeccaoDeJev({ intencao: { type: "choice", choice: "interesse", confidence: 0.9 }, parar: { type: "noul", noul: 0.6 } });
    expect(duvida?.confianca).toBeLessThan(0.7);
    expect(leituraProspeccaoDeJev({ intencao: { type: "choice", choice: "pergunta_preco", confidence: 0.99 } })).toBeNull();
  });

  it("prospecção: usa o contexto do negócio e devolve null quando o Jev falha", async () => {
    const julgar = vi.fn(async () => ({ respostas: { intencao: { type: "choice" as const, choice: "quem_e", confidence: 0.95 } }, tokens: 1 }));
    const r = await lerProspeccaoComJev(julgar as unknown as Julgar, { texto: "quem é?", nossaUltima: null, contexto: "agência para clínicas" });
    expect(r?.intencao).toBe("quem_e");
    expect(JSON.stringify((julgar.mock.calls[0] as unknown[])[1])).toContain("agência para clínicas");
    const falha = vi.fn(async () => null);
    expect(await lerProspeccaoComJev(falha as unknown as Julgar, { texto: "oi", nossaUltima: null, contexto: "x" })).toBeNull();
    expect(await lerProspeccaoComJev(falha as unknown as Julgar, { texto: "   ", nossaUltima: null, contexto: "x" })).toBeNull();
    expect(falha).toHaveBeenCalledTimes(1);
  });

  it("timeout do Jev vira null (as regras seguem) e a chave não vai à URL nem ao erro", async () => {
    const lento = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_ok, no) => init?.signal?.addEventListener("abort", () => no(new Error("abortado")))));
    const julgar = criarJulgar({ chave: "chave-secreta", fetch: lento as unknown as typeof fetch, timeoutMs: 20 });
    expect(await julgar({}, { x: { type: "noul", instructions: "?" } })).toBeNull();
    expect(lento).toHaveBeenCalledTimes(1);
  });

  it("resposta sem 'answers' (corpo estranho) vira null", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ erro: "x" }) }) as Response);
    expect(await criarJulgar({ chave: "k", fetch: f as unknown as typeof fetch })({}, { x: { type: "noul", instructions: "?" } })).toBeNull();
  });
});
