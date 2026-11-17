// @vitest-environment node
/**
 * E2 (suspeito, alto impacto): reenvio depois de tempo esgotado. Quando a chamada à Evolution estoura o
 * tempo (30 s texto, 120 s mídia) ou dá 5xx, o motor tentava de novo em 10 min, até 3 vezes (a abertura ganha uma 4ª
 * chance 24 h depois), sem conferir se a mensagem saiu apesar do erro. Se saiu, o lead recebia duas cópias.
 *
 * Regra: antes de reenviar um envio cujo último erro NÃO é certo (tempo esgotado, 5xx, queda de conexão, erro
 * desconhecido), o motor confere na conversa da organização se já há saída para aquele contato com o mesmo corpo
 * depois da criação do envio. Achou: `enviado` com o external_id achado, sem reenviar. A conferência falhou: NÃO
 * reenvia nesta volta. Só reenvia quando a conferência respondeu e não achou nada. Erro certo (`evolution_4xx`,
 * `sem_whatsapp`) segue como hoje.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import type { ConfigDisparo } from "./config";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo } from "./motor";
import { H, MIN } from "./ritmo";

const ORG = "00000000-0000-4000-8000-0000000000e2";
const AGORA = new Date("2026-10-23T12:00:00-03:00");
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const LEAD: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };
const TEXTO = "Oi Maria, passando de novo.";

const toque = (p: Partial<LinhaEnvio> = {}): LinhaEnvio => ({
  id: "t2", leadId: "l1", chipId: "chip-1", tipo: "toque_2", origem: "motor", texto: TEXTO, midia: null, midiaId: null,
  enviarApos: new Date(AGORA.getTime() - 5 * MIN), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - 2 * 24 * H), daParada: false, ...p,
});

function montar(fila: LinhaEnvio[]) {
  const config: ConfigDisparo = { ...configDoMotor(ORG, "real"), fonteStageId: null };
  const m = motorEmMemoria(AGORA, config, [LEAD]);
  m.envios.push(...fila);
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid-novo" }));
  const rodar = (agora = AGORA) => rodarDisparo({ repo: m.repo, agora, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  /** A primeira chamada ao canal estoura o tempo, MAS a mensagem sai: o eco `fromMe` aparece na conversa. */
  const estouraMasSai = (erro = "This operation was aborted due to timeout") =>
    enviarReal.mockImplementationOnce(async ({ texto }) => {
      m.saidas.push({ leadId: "l1", texto, soMidia: false, externalId: "wamid-eco", em: new Date(AGORA.getTime() + 20_000) });
      throw new Error(erro);
    });
  const depois = new Date(AGORA.getTime() + 11 * MIN);
  return { ...m, enviarReal, rodar, estouraMasSai, depois };
}

describe("o canal estourou o tempo, mas a mensagem saiu", () => {
  it("a volta seguinte NÃO reenvia: acha a saída na conversa e fecha como `enviado` com o external_id dela", async () => {
    const m = montar([toque()]);
    m.estouraMasSai();
    await m.rodar();
    expect(m.envios[0]).toMatchObject({ estado: "pendente", tentativas: 1 });

    await m.rodar(m.depois);
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.envios[0]).toMatchObject({ estado: "enviado", externalId: "wamid-eco" });
    expect(m.envios[0]!.motivo).toMatch(/não reenviad/);
  });

  it("achada a saída, o resto segue como num envio: o próximo passo da cadência é planejado", async () => {
    const m = montar([toque()]);
    m.estouraMasSai();
    await m.rodar();
    await m.rodar(m.depois);
    // (a config do teste não tem modelo de toque_3: o passo é planejado como pulado, mas é planejado)
    expect(m.envios.some((e) => e.tipo === "toque_3")).toBe(true);
  });

  it("5xx também é incerto: confere antes de reenviar", async () => {
    const m = montar([toque()]);
    m.estouraMasSai("evolution_502: bad gateway");
    await m.rodar();
    await m.rodar(m.depois);
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.envios[0]!.estado).toBe("enviado");
  });

  it("a 4ª chance da abertura (24 h depois) também confere", async () => {
    const m = montar([toque({ id: "ab", tipo: "abertura", tentativas: 3, motivo: "segunda chance após 24h: timeout", enviarApos: new Date(AGORA.getTime() - MIN) })]);
    m.saidas.push({ leadId: "l1", texto: TEXTO, soMidia: false, externalId: "wamid-eco", em: new Date(AGORA.getTime() - 24 * H) });
    await m.rodar();
    expect(m.enviarReal).not.toHaveBeenCalled();
    expect(m.envios[0]).toMatchObject({ estado: "enviado", externalId: "wamid-eco" });
  });
});

describe("a conferência decide o reenvio", () => {
  it("irmão: a conferência respondeu e NÃO achou nada: reenvia (uma vez)", async () => {
    const m = montar([toque()]);
    m.enviarReal.mockImplementationOnce(async () => {
      throw new Error("This operation was aborted due to timeout");
    });
    await m.rodar();
    await m.rodar(m.depois);
    expect(m.enviarReal).toHaveBeenCalledTimes(2);
    expect(m.envios[0]).toMatchObject({ estado: "enviado", externalId: "wamid-novo" });
  });

  it("a conferência falhou (banco fora): NÃO reenvia nesta volta e não gasta tentativa", async () => {
    const m = montar([toque()]);
    m.estouraMasSai();
    await m.rodar();
    m.repo.saidaNaConversa = async () => {
      throw new Error("disparo_saida_na_conversa: timeout");
    };
    await m.rodar(m.depois);
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.envios[0]).toMatchObject({ estado: "pendente", tentativas: 1 });
    expect(m.envios[0]!.motivo).toMatch(/conferência/);
    expect(m.envios[0]!.enviarApos.getTime()).toBeGreaterThan(m.depois.getTime());
  });

  it("primeira tentativa (nenhum erro antes) não confere nada", async () => {
    const m = montar([toque()]);
    const conferiu = vi.fn(async () => null);
    m.repo.saidaNaConversa = conferiu;
    await m.rodar();
    expect(conferiu).not.toHaveBeenCalled();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
  });

  it("erro certo (`evolution_400`) segue como hoje: reenvia sem conferir", async () => {
    const m = montar([toque({ tentativas: 1, motivo: "falhou 1x: evolution_400: {\"status\":400}" })]);
    const conferiu = vi.fn(async () => null);
    m.repo.saidaNaConversa = conferiu;
    await m.rodar();
    expect(conferiu).not.toHaveBeenCalled();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
  });

  it("a conferência procura a partir da criação do envio, pelo mesmo corpo, para aquele lead", async () => {
    const m = montar([toque({ tentativas: 1, motivo: "falhou 1x: fetch failed" })]);
    const conferiu = vi.fn(async () => null);
    m.repo.saidaNaConversa = conferiu;
    await m.rodar();
    expect(conferiu).toHaveBeenCalledWith(ORG, "l1", { texto: TEXTO, soMidia: false, desde: m.envios[0]!.criadoEm });
  });
});
