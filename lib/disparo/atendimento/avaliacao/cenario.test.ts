import { expect, it } from "vitest";
import { RITMO_PADRAO } from "../../config";
import { CONFIG_VENDA_EXEMPLO } from "../apoio-de-teste";
import { casoSchema } from "./casos";
import { montarCenario } from "./cenario";

it("prepara somente a explicação sem antecipar a tabela", async () => {
  const caso = casoSchema.parse({ id: "etapa", texto: "qual o valor?", cliente_antigo: false, etapa_conversa: "apos_explicacao", ultima_nossa: null, intencao_esperada: "pergunta_preco", acao_esperada: "funil_valores" });
  const r = await montarCenario(caso, CONFIG_VENDA_EXEMPLO, RITMO_PADRAO, null);
  expect(r.tabelaPreparada).toBe(false);
  expect(r.envios.some(e => e.tipo.startsWith("tabela"))).toBe(true);
});

it("une apenas as respostas extras preservando as respostas originais", async () => {
  const { comRespostasExtras } = await import("./config-extra");
  expect(comRespostasExtras({ respostas: { entrega: [[{ texto: "entrega" }]] }, perfil: "venda" }, { saudacao: [[{ texto: "oi" }]] })).toEqual({ perfil: "venda", respostas: { entrega: [[{ texto: "entrega" }]], saudacao: [[{ texto: "oi" }]] } });
});
