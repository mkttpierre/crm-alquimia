import { describe, expect, it } from "vitest";

import { lerRitmo, RITMO_PADRAO } from "@/lib/disparo/config";
import { DICIONARIO } from "@/lib/i18n/dicionario";

import { gravarCaminho, lerCaminho, ritmoAlterado, SECOES_DO_RITMO, textoDoRecomendado, voltarSecaoAoRecomendado } from "./campos-do-ritmo";

describe("seções da gaveta Personalizar", () => {
  it("todo campo mora num caminho que existe no ritmo e dentro das chaves da própria seção", () => {
    for (const secao of SECOES_DO_RITMO) {
      for (const campo of secao.campos) {
        expect(lerCaminho(RITMO_PADRAO, campo.caminho), campo.caminho).not.toBeUndefined();
        expect(secao.chaves, campo.caminho).toContain(campo.caminho.split(".")[0]);
      }
    }
  });

  it("todo texto da gaveta tem espanhol (as chaves passam por t() dinâmico, que a guarda de i18n não enxerga)", () => {
    const textos = SECOES_DO_RITMO.flatMap((s) => [s.titulo, s.descricao, ...s.campos.flatMap((c) => [c.rotulo, c.unidade])]).filter(
      (x): x is string => !!x,
    );
    expect(textos.filter((x) => !DICIONARIO[x]?.es)).toEqual([]);
  });

  it("voltar ao recomendado mexe só nas chaves da seção", () => {
    const ritmo = lerRitmo({ intervaloNova: { min: 30, max: 40 }, maxEnviosHora: 20, saude: { ligado: false } });
    const intervalos = SECOES_DO_RITMO.find((s) => s.id === "intervalos")!;
    const r = voltarSecaoAoRecomendado(ritmo, intervalos);
    expect(r.intervaloNova).toEqual(RITMO_PADRAO.intervaloNova);
    expect(r.maxEnviosHora).toBe(20);
    expect(r.saude.ligado).toBe(false);
    expect(ritmoAlterado(ritmo, r)).toEqual({ intervaloNova: RITMO_PADRAO.intervaloNova });
  });

  it("gravar num caminho não altera o original e o recomendado sai do RITMO_PADRAO", () => {
    const novo = gravarCaminho(RITMO_PADRAO, "saude.bloqueio.amarelo", 0.1);
    expect(novo.saude.bloqueio.amarelo).toBe(0.1);
    expect(RITMO_PADRAO.saude.bloqueio.amarelo).toBe(0.02);
    const campo = SECOES_DO_RITMO.flatMap((s) => s.campos).find((c) => c.caminho === "saude.bloqueio.amarelo")!;
    expect(textoDoRecomendado(campo, "sim", "não", "igual")).toBe("2 %");
    const janela = SECOES_DO_RITMO.flatMap((s) => s.campos).find((c) => c.caminho === "janela.semana")!;
    expect(textoDoRecomendado(janela, "sim", "não", "igual")).toBe("08:00–19:00");
  });
});
