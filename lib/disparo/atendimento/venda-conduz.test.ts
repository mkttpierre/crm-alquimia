// @vitest-environment node
/**
 * Interesse conduzido pelo funil (pedido do operador): quem diz "me fala mais",
 * "o que é isso?" ou "quero saber mais" recebe a explicação e é levada à pergunta do kit,
 * em vez de cair no operador sem resposta. Achados do QA com a config real de uma organização, sem Jev.
 */
import { describe, expect, it } from "vitest";

import { lerMensagem } from "../leitura";
import { CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { criarJulgar } from "./jev";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGORA = new Date("2026-10-26T14:00:00Z");

let n = 0;
function cenario() {
  const disparo = configDisparoExemplo(ORG);
  disparo.ritmo = { ...disparo.ritmo, limiteAutomaticasSeguidas: 5 };
  const repo = new RepositorioEmMemoria(ORG, disparo, CONFIG_VENDA_EXEMPLO);
  const lead = repo.novoLead(`conduz-${++n}`);
  repo.chipPorLead.set(lead.id, "chip-ensaio");
  const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) };
  const diz = (texto: string) => atenderMensagem(deps, ORG, lead.id, { chave: `c${++n}`, messageId: null, texto, midia: false });
  return { repo, lead, diz, conversa: () => repo.conversas.get(lead.id)! };
}

describe("leitura: pedidos de explicação são interesse, mesmo sem o Jev", () => {
  it.each(["me fala mais", "fala mais", "me fala mais sobre esse produto", "o que é isso?", "o que é esse produto?", "que produto é esse?", "quero mais detalhes", "mais informações", "me passa mais informações", "do que se trata?"])(
    "'%s' é interesse",
    (t) => expect(lerMensagem(t).intencao).toBe("interesse"),
  );

  it.each(["oi", "boa tarde"])("'%s' é saudação", (t) => expect(lerMensagem(t).intencao).toBe("saudacao"));
  it("agradecimento isolado permanece sem leitura segura", () => expect(lerMensagem("obrigada").intencao).toBe("outro"));
});

describe("venda: interesse depois da tabela", () => {
  it("viu só o preço e pede para saber mais: recebe a explicação e a pergunta do kit, sem ir ao operador", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("Quanto custa?");
    const antes = repo.enviosDo(lead.id).length;
    await diz("quero saber mais");
    const novos = repo.enviosDo(lead.id).slice(antes).map((e) => e.tipo);
    expect(novos[0]).toBe("explicacao");
    expect(novos.at(-1)).toMatch(/^pergunta_kit|pergunta/);
    expect(conversa().precisaOperador).toBe(false);
    expect(conversa().etapa).toBe("qualificando");
    expect(repo.avisos.filter((a) => a.nivel === "operador")).toHaveLength(0);
  });

  it("já ouviu a explicação e pergunta de novo: vai ao operador, sem repetir o áudio", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("quero saber mais");
    const antes = repo.enviosDo(lead.id).length;
    await diz("como funciona?");
    expect(repo.enviosDo(lead.id)).toHaveLength(antes);
    expect(conversa().precisaOperador).toBe(true);
  });

  it("conversa antiga (sem saber se a explicação saiu) segue como antes: operador", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("Quanto custa?");
    // Simula conversa gravada antes da mudança: o campo novo não existe.
    const c = repo.conversas.get(lead.id)!;
    delete (c.dados as Record<string, unknown>).explicacaoEnviada;
    const antes = repo.enviosDo(lead.id).length;
    await diz("quero saber mais");
    expect(repo.enviosDo(lead.id)).toHaveLength(antes);
    expect(conversa().precisaOperador).toBe(true);
  });
});
