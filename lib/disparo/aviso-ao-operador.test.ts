/**
 * Aviso ao celular pessoal do operador, pelo chip da conversa, no motor inteiro
 * contra o repositório em memória e com espiões no lugar do canal.
 *
 * O que fica provado:
 *  - sai pelo chip da conversa (nunca outro) e só pelo `enviarAviso`, nunca pelo `enviarReal`;
 *  - as MESMAS travas do envio real: modo real E DISPARO_REAL_LIBERADO=sim, mais a
 *    allowlist; fechada a trava, o aviso só vira `simulado`;
 *  - espera o pacote do lead sair antes de ir;
 *  - respeita o ritmo do chip (intervalo mínimo entre quaisquer envios), um por volta;
 *  - falha tem nova tentativa, e depois de três vira `falhou`.
 */
import { describe, expect, it, vi } from "vitest";

import { CONTAGEM_ZERADA, configDoMotor, type LinhaAviso, type LinhaEnvio, motorEmMemoria } from "./apoio-do-motor-teste";
import type { Contagem } from "./fila";
import { type EnvioDeAviso, type EnvioReal, type LeadDoDisparo, rodarDisparo, VALIDADE_DO_AVISO_MS } from "./motor";
import { MOTIVO_ALLOWLIST } from "./trava";

const ORG = "00000000-0000-4000-8000-0000000000d1";
const AGORA = new Date("2026-10-07T10:00:00-03:00");
const LIBERADO = { DISPARO_REAL_LIBERADO: "sim" };
const OPERADOR = "5511900000002";
const LEAD: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

const aviso = (p: Partial<LinhaAviso> = {}): LinhaAviso => ({
  id: "a1", leadId: "l1", chipId: "chip-1", canalId: "sessao-1", destino: OPERADOR, texto: "Respondeu KIT ESCOLHIDO\nNome: Maria",
  enviarApos: new Date(AGORA.getTime() - 30_000), tentativas: 0, estado: "pendente", ...p,
});

const parte = (id: string, minAtras: number): LinhaEnvio => ({
  id, leadId: "l1", chipId: "chip-1", tipo: "fechamento:seq", origem: "auto", texto: id, midia: null, midiaId: null,
  enviarApos: new Date(AGORA.getTime() - minAtras * 60_000), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - 3_600_000), daParada: true,
});

async function rodar(
  modo: "simulado" | "real",
  ambiente: Record<string, string | undefined>,
  avisos: LinhaAviso[],
  opcoes: { envios?: LinhaEnvio[]; voltas?: number; contagem?: () => Contagem; falha?: string } = {},
) {
  const config = { ...configDoMotor(ORG, modo), fonteStageId: null };
  const m = motorEmMemoria(AGORA, config, [LEAD], { contagem: opcoes.contagem });
  m.avisos.push(...avisos);
  m.envios.push(...(opcoes.envios ?? []));
  const ordem: string[] = [];
  const enviarReal = vi.fn<EnvioReal>(async (p) => (ordem.push(`pacote:${p.texto}`), { externalId: "wamid-pacote" }));
  const enviarAviso = vi.fn<EnvioDeAviso>(async () => {
    if (opcoes.falha) throw new Error(opcoes.falha);
    ordem.push("aviso");
    return { externalId: "wamid-aviso" };
  });
  const resumos = [];
  for (let i = 0; i < (opcoes.voltas ?? 1); i++) {
    resumos.push(await rodarDisparo({ repo: m.repo, agora: new Date(AGORA.getTime() + i * 60_000), ambiente, sortear: () => 0.5, enviarReal, enviarAviso }));
  }
  return { ...m, enviarReal, enviarAviso, ordem, resumos };
}

describe("aviso ao operador: pelo chip da conversa e atrás da trava dupla", () => {
  it("controle positivo: com as duas chaves, sai por enviarAviso (e só por ele), pelo chip e sessão de origem", async () => {
    const { enviarAviso, enviarReal, avisos, resumos } = await rodar("real", LIBERADO, [aviso()]);
    expect(enviarAviso).toHaveBeenCalledTimes(1);
    expect(enviarAviso.mock.calls[0]![0]).toMatchObject({ chipId: "chip-1", canalId: "sessao-1", destino: OPERADOR, texto: expect.stringContaining("KIT ESCOLHIDO") });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(avisos[0]).toMatchObject({ estado: "enviado", externalId: "wamid-aviso", enviadoEm: AGORA });
    expect(resumos[0]!.organizacoes[0]!.avisos).toBe(1);
    expect(resumos[0]!.efeito).toBe(true);
  });

  it.each([
    ["modo simulado, mesmo com a variável liberada", "simulado", LIBERADO],
    ["modo real, variável ausente", "real", {}],
    ["modo real, variável com valor quase certo", "real", { DISPARO_REAL_LIBERADO: "true" }],
  ] as const)("%s: nada vai ao canal, o aviso vira simulado", async (_n, modo, ambiente) => {
    const { enviarAviso, enviarReal, avisos } = await rodar(modo, ambiente, [aviso()]);
    expect(enviarAviso).not.toHaveBeenCalled();
    expect(enviarReal).not.toHaveBeenCalled();
    expect(avisos[0]).toMatchObject({ estado: "simulado", enviadoEm: AGORA });
  });

  it("allowlist: o número do operador fora da lista é barrado e registrado; dentro da lista, sai", async () => {
    const fora = await rodar("real", { ...LIBERADO, DISPARO_SO_PARA: "+5511999990000" }, [aviso()]);
    expect(fora.enviarAviso).not.toHaveBeenCalled();
    expect(fora.avisos[0]).toMatchObject({ estado: "cancelado", motivo: MOTIVO_ALLOWLIST });
    const dentro = await rodar("real", { ...LIBERADO, DISPARO_SO_PARA: "+55 (11) 90000-0002" }, [aviso()]);
    expect(dentro.enviarAviso).toHaveBeenCalledTimes(1);
  });

  it("só sai pelo chip do aviso: aviso de outro chip não é tocado nesta volta", async () => {
    const { enviarAviso, avisos } = await rodar("real", LIBERADO, [aviso({ id: "a-outro", chipId: "chip-9", canalId: "sessao-9" })]);
    expect(enviarAviso).not.toHaveBeenCalled();
    expect(avisos[0]!.estado).toBe("pendente");
  });

  it("ainda não venceu: espera", async () => {
    const { enviarAviso, avisos } = await rodar("real", LIBERADO, [aviso({ enviarApos: new Date(AGORA.getTime() + 60_000) })]);
    expect(enviarAviso).not.toHaveBeenCalled();
    expect(avisos[0]!.estado).toBe("pendente");
  });

  it("parado há mais de 6 h (chip fora do ar): cancelado como vencido, a Central já avisou", async () => {
    const { enviarAviso, avisos } = await rodar("real", LIBERADO, [aviso({ enviarApos: new Date(AGORA.getTime() - VALIDADE_DO_AVISO_MS - 60_000) })]);
    expect(enviarAviso).not.toHaveBeenCalled();
    expect(avisos[0]).toMatchObject({ estado: "cancelado", motivo: expect.stringContaining("vencido") });
  });
});

describe("aviso ao operador: depois do pacote", () => {
  it("o pacote sai inteiro antes do aviso, mesmo com o aviso já vencido desde o começo", async () => {
    const { ordem, avisos } = await rodar("real", LIBERADO, [aviso()], { envios: [parte("pt1", 3), parte("pt2", 2), parte("pt3", 1)], voltas: 6 });
    expect(ordem).toEqual(["pacote:pt1", "pacote:pt2", "pacote:pt3", "aviso"]);
    expect(avisos[0]!.estado).toBe("enviado");
  });

  it("enquanto houver parte do pacote por sair, o aviso fica pendente", async () => {
    const { enviarAviso, avisos } = await rodar("real", LIBERADO, [aviso()], { envios: [parte("pt1", 3), parte("pt2", 2)], voltas: 1 });
    expect(enviarAviso).not.toHaveBeenCalled();
    expect(avisos[0]!.estado).toBe("pendente");
  });
});

describe("aviso ao operador: ritmo do chip", () => {
  const agoraMenos = (seg: number): Contagem => ({ ...CONTAGEM_ZERADA, ultimoEnvioEm: new Date(AGORA.getTime() - seg * 1000), enviosHoje: 1, enviosUltimaHora: 1 });

  it("irmão: o último envio do chip foi há muito tempo, o aviso sai", async () => {
    const { enviarAviso } = await rodar("real", LIBERADO, [aviso()], { contagem: () => agoraMenos(3600) });
    expect(enviarAviso).toHaveBeenCalledTimes(1);
  });

  it("o chip acabou de mandar outra coisa (piso entre quaisquer envios): o aviso espera", async () => {
    const { enviarAviso, avisos } = await rodar("real", LIBERADO, [aviso()], { contagem: () => agoraMenos(2) });
    expect(enviarAviso).not.toHaveBeenCalled();
    expect(avisos[0]!.estado).toBe("pendente");
  });

  it("limite de envios na última hora vale também para o aviso", async () => {
    const cheia: Contagem = { ...CONTAGEM_ZERADA, enviosUltimaHora: 999 };
    const { enviarAviso } = await rodar("real", LIBERADO, [aviso()], { contagem: () => cheia });
    expect(enviarAviso).not.toHaveBeenCalled();
  });

  it("um aviso por volta e por chip", async () => {
    const { enviarAviso, avisos } = await rodar("real", LIBERADO, [aviso({ id: "a1", leadId: "l1" }), aviso({ id: "a2", leadId: "l1", enviarApos: new Date(AGORA.getTime() - 10_000) })]);
    expect(enviarAviso).toHaveBeenCalledTimes(1);
    expect(avisos.map((a) => a.estado)).toEqual(["enviado", "pendente"]);
  });
});

describe("aviso ao operador: falha", () => {
  it("falha comum: volta para a fila em 10 min, tentativa contada, o chip segura", async () => {
    const { avisos, chip } = await rodar("real", LIBERADO, [aviso()], { falha: "canal_ocupado: instância ocupada" });
    expect(avisos[0]).toMatchObject({ estado: "pendente", tentativas: 1, enviarApos: new Date(AGORA.getTime() + 10 * 60_000) });
    expect(chip.saude).toBe("verde");
  });

  it("na terceira falha o aviso vira falhou", async () => {
    const { avisos } = await rodar("real", LIBERADO, [aviso({ tentativas: 2 })], { falha: "canal_ocupado" });
    expect(avisos[0]).toMatchObject({ estado: "falhou", tentativas: 3 });
  });

  it("sinal de restrição para o chip (vermelho, 48 h), como no envio ao lead", async () => {
    const { chip } = await rodar("real", LIBERADO, [aviso()], { falha: "403 forbidden: restricted" });
    expect(chip.saude).toBe("vermelho");
    expect(chip.pausadoAte!.getTime()).toBe(AGORA.getTime() + 48 * 60 * 60_000);
  });
});
