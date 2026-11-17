/**
 * Perfil prospecção (venda para empresa), portado em linha geral de um motor anterior,
 * sem agenda: recusa → motivo → encerra; objeção respondida uma vez; quem
 * decide junto; interesse claro → convite do diagnóstico com o código do
 * cartão; preço e horário → operador.
 */
import { describe, expect, it } from "vitest";

import { CONFIG_PROSPECCAO_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { errosDaConfig } from "./config";
import { criarJulgar } from "./jev";

const ORG = "44444444-4444-4444-8444-444444444444";
const AGORA = new Date("2026-10-14T13:00:00Z");
let n = 0;

function cenario(campos: Record<string, unknown> = { codigo: "AB12" }) {
  const repo = new RepositorioEmMemoria(ORG, { ...configDisparoExemplo(ORG), ritmo: { ...configDisparoExemplo(ORG).ritmo, golpeEhParada: true } }, CONFIG_PROSPECCAO_EXEMPLO);
  const lead = repo.novoLead(`p${++n}`, { campos });
  const diz = (texto: string) =>
    atenderMensagem({ repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) }, ORG, lead.id, { chave: `pm${++n}`, messageId: null, texto, midia: false });
  return { repo, lead, diz, conversa: () => repo.conversas.get(lead.id)! };
}

describe("atendimento prospecção", () => {
  it("a config de exemplo é coerente", () => {
    expect(errosDaConfig(CONFIG_PROSPECCAO_EXEMPLO)).toEqual([]);
  });

  it("recusa educada pergunta o motivo uma vez; 'não' de novo encerra", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("não tenho interesse");
    expect(repo.enviosDo(lead.id).map((e) => e.tipo)).toEqual(["motivo"]);
    expect(conversa().dados.estadoProspeccao).toBe("pediu_motivo");
    await diz("não");
    expect(conversa().etapa).toBe("perdido");
    expect(repo.enviosDo(lead.id)).toHaveLength(1);
  });

  it.each([
    "Opa, quero ver sim! Pode mandar",
    "quero ver",
    "pode mandar",
    "manda aí",
    "Manda sim",
    "gostei, quero ver completo",
    "Ficou lindo!",
    "quero sim",
    "show, pode enviar",
  ])("resposta de interesse à prévia (%s) vira lead quente para o operador", async (texto) => {
    const { diz, conversa } = cenario({});
    await diz(texto);
    expect(conversa().quente).toBe(true);
    expect(conversa().precisaOperador).toBe(true);
  });

  it("sem diagnóstico configurado (abordagem com prévia), o aviso pede o demo completo", async () => {
    const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), { ...CONFIG_PROSPECCAO_EXEMPLO, diagnostico: null });
    const lead = repo.novoLead("pv1", { campos: {} });
    await atenderMensagem({ repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) }, ORG, lead.id, { chave: "pv1m", messageId: null, texto: "quero ver", midia: false });
    expect(repo.conversas.get(lead.id)!.motivoOperador).toContain("site completo");
  });

  it("'não quero ver' não é interesse", async () => {
    const { diz, conversa } = cenario({});
    await diz("não quero ver não, obrigado");
    expect(conversa().quente).toBe(false);
  });

  it("'golpe' é parada dura na venda para empresa", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("isso é golpe");
    expect(conversa().etapa).toBe("nao_contatar");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });

  it("objeção recebe a pergunta da casa uma vez; repetida vai ao operador", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("já temos uma agência que cuida disso");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("objecao_ja_tenho");
    expect(conversa().dados.estadoProspeccao).toBe("objecao_respondida");
    await diz("já tenho uma empresa que faz");
    expect(conversa().precisaOperador).toBe(true);
  });

  it("quem decide junto: resposta própria e aviso", async () => {
    const { repo, lead, diz } = cenario();
    await diz("preciso falar com o meu sócio");
    expect(repo.enviosDo(lead.id).at(-1)!.tipo).toBe("objecao_socio");
    expect(repo.avisos.at(-1)!.titulo).toMatch(/quem decide/);
  });

  it("interesse claro manda o convite e o link do diagnóstico com o código do cartão", async () => {
    const { repo, lead, diz, conversa } = cenario();
    await diz("como funciona?");
    const fila = repo.enviosDo(lead.id);
    expect(fila.map((e) => e.tipo)).toEqual(["diagnostico_convite", "diagnostico_link"]);
    expect(fila[1]!.texto).toBe("https://diagnostico.exemplo/?c=AB12#diagnostico");
    expect(conversa().quente).toBe(true);
    expect(conversa().dados.diagnosticoEnviadoEm).not.toBeNull();
  });

  it("sem código do cartão, preço ou horário: operador com o lead quente, nada sai", async () => {
    const semCodigo = cenario({});
    await semCodigo.diz("tenho interesse, me conta mais");
    expect(semCodigo.repo.enviosDo(semCodigo.lead.id)).toHaveLength(0);
    expect(semCodigo.conversa().quente).toBe(true);
    const preco = cenario();
    await preco.diz("quanto custa?");
    expect(preco.repo.enviosDo(preco.lead.id)).toHaveLength(0);
    expect(preco.conversa().precisaOperador).toBe(true);
    const hora = cenario();
    await hora.diz("pode ser quinta às 10h");
    expect(hora.conversa().motivoOperador).toMatch(/horário/);
  });
});
