/**
 * Freios de saúde e quarentena DENTRO do motor, contra o repositório em memória:
 *  - o job de saúde roda na volta do chip, no máximo a cada 15 min, e aplica a ação (vermelho = para 48 h e dia 1);
 *  - amarelo gravado no dia não some porque a taxa melhorou; vermelho gravado não se repete depois que o operador devolve o chip;
 *  - quem recebeu o último toque sem responder entra em quarentena de 45 dias;
 *  - toque além de 3 mensagens sem resposta no mês é cancelado;
 *  - repositório sem os métodos novos continua rodando como antes.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria } from "./apoio-do-motor-teste";
import { RITMO_PADRAO } from "./config";
import { type FiltroDeAbertura, type LeadDoDisparo, type RepositorioDisparo, rodarDisparo } from "./motor";
import { H, MIN } from "./ritmo";
import type { DadosDaSaude, LinhaDaSaudeDoDia, SaudeGravada } from "./saude";

const ORG = "00000000-0000-4000-8000-0000000000e1";
const AGORA = new Date("2026-10-07T10:00:00-03:00");
const LEAD: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

const toque = (tipo: string): LinhaEnvio => ({
  id: `e-${tipo}`, leadId: "l1", chipId: "chip-1", tipo, origem: "motor", texto: "Oi Maria, passando por aqui de novo.", midia: null, midiaId: null,
  enviarApos: new Date(AGORA.getTime() - 5 * MIN), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - 3 * 24 * H), daParada: false,
});

const VAZIO: DadosDaSaude = { aberturas: [], respostas: [], conexao: [] };
const QUEDA: DadosDaSaude = { aberturas: [], respostas: [], conexao: [{ estado: "close", codigo: null, em: new Date(AGORA.getTime() - H) }] };

type Extras = Partial<Pick<RepositorioDisparo, "dadosDaSaude" | "saudeDoDia" | "gravarSaudeDoDia" | "semRespostaDesde" | "entrarEmQuarentena">>;

async function rodar(extras: Extras, opcoes: { envios?: LinhaEnvio[]; chip?: Record<string, unknown>; fonteStageId?: string | null } = {}) {
  const config = { ...configDoMotor(ORG, "simulado"), fonteStageId: opcoes.fonteStageId ?? null };
  const m = motorEmMemoria(AGORA, config, [LEAD]);
  m.envios.push(...(opcoes.envios ?? []));
  Object.assign(m.chip, opcoes.chip ?? {});
  const filtros: (FiltroDeAbertura | undefined)[] = [];
  const repo: RepositorioDisparo = {
    ...m.repo,
    ...extras,
    proximoLeadParaAbertura: async (o, s, f) => (filtros.push(f), m.repo.proximoLeadParaAbertura(o, s, f)),
  };
  const resumo = await rodarDisparo({
    repo, agora: AGORA, ambiente: {}, sortear: () => 0.5,
    enviarReal: vi.fn(async () => ({ externalId: null })),
    enviarAviso: vi.fn(async () => ({ externalId: null })),
  });
  return { ...m, resumo, filtros, resultado: resumo.organizacoes[0]!.chips[0]!.resultado };
}

describe("job de saúde na volta do chip", () => {
  it("vermelho sem sessão conectada é recalculado, mas não volta a enviar", async () => {
    const gravadas: LinhaDaSaudeDoDia[] = [];
    const r = await rodar({
      dadosDaSaude: async () => VAZIO,
      saudeDoDia: async () => null,
      gravarSaudeDoDia: async (_o, l) => void gravadas.push(l),
      ...({ sessaoConectada: async () => false } as object),
    }, { chip: { saude: "vermelho", pausadoAte: new Date(AGORA.getTime() - MIN), saudeCalculadaEm: null }, envios: [toque("toque_2")] });
    expect(r.chip.saude).toBe("vermelho");
    expect(gravadas).toHaveLength(1);
    expect(r.envios[0]!.estado).toBe("pendente");
    expect(r.central).toHaveLength(0);
  });
  it("depois de 48 horas, vermelho conectado e saudável volta amarelo no dia 1 e avisa", async () => {
    const r = await rodar({
      dadosDaSaude: async () => VAZIO,
      saudeDoDia: async () => null,
      gravarSaudeDoDia: async () => undefined,
      ...({ sessaoConectada: async () => true } as object),
    }, { chip: { saude: "vermelho", diaRampa: 1, pausadoAte: new Date(AGORA.getTime() - MIN), saudeCalculadaEm: null } });
    expect(r.chip.saude).toBe("amarelo");
    expect(r.chip.diaRampa).toBe(1);
    expect(r.chip.estado).toBe("rampa");
    expect(r.central).toHaveLength(1);
    expect(r.envios).toHaveLength(0);
  });
  it("avalia saúde amarela antes de subir a rampa na primeira volta do dia", async () => {
    const r = await rodar({
      dadosDaSaude: async () => ({ ...VAZIO, conexao: [
        { estado: "connecting", codigo: null, em: new Date(AGORA.getTime() - 2 * MIN) },
        { estado: "open", codigo: null, em: new Date(AGORA.getTime() - MIN) },
      ] }),
      saudeDoDia: async () => null,
      gravarSaudeDoDia: async () => undefined,
    }, { chip: { estado: "rampa", diaRampa: 5, proximoEnvioEm: new Date(AGORA.getTime() - 24 * H) } });
    expect(r.chip.saude).toBe("amarelo");
    expect(r.chip.diaRampa).toBe(5);
  });
  it("queda de conexão: o chip fica vermelho, volta ao dia 1, pausa 48 h e a volta termina sem enviar nada", async () => {
    const gravadas: LinhaDaSaudeDoDia[] = [];
    const r = await rodar(
      { dadosDaSaude: async () => QUEDA, saudeDoDia: async () => null, gravarSaudeDoDia: async (_o, l) => void gravadas.push(l) },
      { envios: [toque("toque_2")] },
    );
    expect(r.chip).toMatchObject({ saude: "vermelho", diaRampa: 1, saudeMotivo: expect.stringContaining("Conexão caiu") });
    expect(r.chip.pausadoAte!.getTime() - AGORA.getTime()).toBe(48 * H);
    expect(r.chip.saudeCalculadaEm).toEqual(AGORA);
    expect(r.resultado).toContain("saúde vermelha");
    expect(r.envios[0]!.estado).toBe("pendente");
    expect(gravadas).toHaveLength(1);
    expect(gravadas[0]).toMatchObject({ chipId: "chip-1", dia: "2026-10-07", saude: "vermelho", diaRampa: 1, sinais: { quedas: 1 } });
  });

  it("saúde verde: grava o dia, marca o cálculo e a volta segue normal (o toque sai)", async () => {
    const gravadas: LinhaDaSaudeDoDia[] = [];
    const r = await rodar(
      { dadosDaSaude: async () => VAZIO, saudeDoDia: async () => null, gravarSaudeDoDia: async (_o, l) => void gravadas.push(l) },
      { envios: [toque("toque_2")] },
    );
    expect(r.chip).toMatchObject({ saude: "verde", saudeMotivo: null });
    expect(gravadas[0]).toMatchObject({ saude: "verde", motivos: [] });
    expect(r.envios[0]!.estado).toBe("simulado");
  });

  it("recalcula no máximo a cada 15 min: calculado há 5 min, nem lê o banco", async () => {
    const lido = vi.fn(async () => VAZIO);
    await rodar(
      { dadosDaSaude: lido, saudeDoDia: async () => null, gravarSaudeDoDia: async () => undefined },
      { chip: { saudeCalculadaEm: new Date(AGORA.getTime() - 5 * MIN) } },
    );
    expect(lido).not.toHaveBeenCalled();
  });

  it("amarelo gravado no dia não some porque o cálculo seguinte deu verde (a pior do dia vence)", async () => {
    const gravada: SaudeGravada = { saude: "amarelo", motivos: [{ indicador: "irritacao", cor: "amarelo", texto: "1 resposta com irritação" }], calculadoEm: new Date(AGORA.getTime() - H) };
    const r = await rodar({ dadosDaSaude: async () => VAZIO, saudeDoDia: async () => gravada, gravarSaudeDoDia: async () => undefined });
    expect(r.chip).toMatchObject({ saude: "amarelo", saudeMotivo: "1 resposta com irritação" });
  });

  it("vermelho já gravado hoje: a conta só olha o que veio DEPOIS dele (o operador devolveu o chip, a queda de antes não o derruba de novo)", async () => {
    const calculadoEm = new Date(AGORA.getTime() - 2 * H);
    const lido = vi.fn(async (_o: string, _c: string, p: { desde: Date }) => (p.desde.getTime() >= calculadoEm.getTime() ? VAZIO : QUEDA));
    const r = await rodar({
      dadosDaSaude: lido,
      saudeDoDia: async () => ({ saude: "vermelho", motivos: [], calculadoEm }),
      gravarSaudeDoDia: async () => undefined,
    });
    expect(lido.mock.calls[0]![2].desde).toEqual(calculadoEm);
    expect(r.chip.saude).toBe("verde");
  });

  it("desligado por organização (ritmo.saude.ligado = false): não calcula", async () => {
    const lido = vi.fn(async () => QUEDA);
    const config = configDoMotor(ORG, "simulado");
    config.ritmo = { ...RITMO_PADRAO, feriados: [], saude: { ...RITMO_PADRAO.saude, ligado: false } };
    const m = motorEmMemoria(AGORA, { ...config, fonteStageId: null }, [LEAD]);
    await rodarDisparo({
      repo: { ...m.repo, dadosDaSaude: lido, saudeDoDia: async () => null, gravarSaudeDoDia: async () => undefined },
      agora: AGORA, ambiente: {}, sortear: () => 0.5, enviarReal: vi.fn(async () => ({ externalId: null })), enviarAviso: vi.fn(async () => ({ externalId: null })),
    });
    expect(lido).not.toHaveBeenCalled();
    expect(m.chip.saude).toBe("verde");
  });

  it("repositório sem os métodos de saúde e quarentena roda como antes", async () => {
    const r = await rodar({}, { envios: [toque("toque_3")] });
    expect(r.envios[0]!.estado).toBe("simulado");
    expect(r.chip.saude).toBe("verde");
  });
});

describe("quarentena de quem recebeu todos os toques sem responder", () => {
  it("o último toque (toque_3) que sai põe o lead em quarentena por 45 dias, pelo chip que mandou", async () => {
    const entrou = vi.fn(async () => undefined);
    const r = await rodar({ entrarEmQuarentena: entrou, semRespostaDesde: async () => 2 }, { envios: [toque("toque_3")] });
    expect(r.envios[0]!.estado).toBe("simulado");
    expect(entrou).toHaveBeenCalledTimes(1);
    const [org, lead, chip, ate] = entrou.mock.calls[0] as unknown as [string, string, string, Date];
    expect([org, lead, chip]).toEqual([ORG, "l1", "chip-1"]);
    expect(ate.getTime() - AGORA.getTime()).toBe(45 * 24 * H);
    expect(r.resultado).toContain("quarentena");
  });

  it("toque que NÃO é o último não põe ninguém em quarentena", async () => {
    const entrou = vi.fn(async () => undefined);
    await rodar({ entrarEmQuarentena: entrou, semRespostaDesde: async () => 1 }, { envios: [toque("toque_2")] });
    expect(entrou).not.toHaveBeenCalled();
  });

  it("organização que desliga a quarentena não grava nada", async () => {
    const entrou = vi.fn(async () => undefined);
    const config = { ...configDoMotor(ORG, "simulado"), fonteStageId: null };
    config.ritmo = { ...RITMO_PADRAO, feriados: [], quarentena: { ...RITMO_PADRAO.quarentena, ligado: false } };
    const m = motorEmMemoria(AGORA, config, [LEAD]);
    m.envios.push(toque("toque_3"));
    await rodarDisparo({
      repo: { ...m.repo, entrarEmQuarentena: entrou },
      agora: AGORA, ambiente: {}, sortear: () => 0.5, enviarReal: vi.fn(async () => ({ externalId: null })), enviarAviso: vi.fn(async () => ({ externalId: null })),
    });
    expect(entrou).not.toHaveBeenCalled();
  });
});

describe("3 mensagens sem resposta por mês", () => {
  it("o toque que seria a 4ª é cancelado e a cadência do lead para", async () => {
    const r = await rodar({ semRespostaDesde: async () => 3 }, { envios: [toque("toque_2")] });
    expect(r.envios[0]).toMatchObject({ estado: "cancelado", motivo: expect.stringContaining("3 mensagens sem resposta") });
  });
  it("com 2 já enviadas, o 3º toque sai", async () => {
    const r = await rodar({ semRespostaDesde: async () => 2 }, { envios: [toque("toque_3")] });
    expect(r.envios[0]!.estado).toBe("simulado");
  });
  it("a janela consultada é a de `diasEntreAbordagens` (30 dias)", async () => {
    const consulta = vi.fn(async () => 0);
    await rodar({ semRespostaDesde: consulta }, { envios: [toque("toque_2")] });
    const desde = (consulta.mock.calls[0] as unknown as [string, string, Date])[2];
    expect(AGORA.getTime() - desde.getTime()).toBe(30 * 24 * H);
  });
});

describe("filtro de abertura leva a regra de quarentena", () => {
  it("a busca do próximo lead recebe a configuração e o instante", async () => {
    const r = await rodar({}, { fonteStageId: "stage-1" });
    const f = r.filtros.at(-1);
    expect(f?.quarentena).toEqual({ cfg: RITMO_PADRAO.quarentena, agora: AGORA });
  });
  it("com a quarentena desligada, o filtro não leva nada", async () => {
    const config = { ...configDoMotor(ORG, "simulado") };
    config.ritmo = { ...RITMO_PADRAO, feriados: [], quarentena: { ...RITMO_PADRAO.quarentena, ligado: false } };
    const m = motorEmMemoria(AGORA, config, [LEAD]);
    let visto: FiltroDeAbertura | undefined;
    await rodarDisparo({
      repo: { ...m.repo, proximoLeadParaAbertura: async (_o, _s, f) => ((visto = f), null) },
      agora: AGORA, ambiente: {}, sortear: () => 0.5, enviarReal: vi.fn(async () => ({ externalId: null })), enviarAviso: vi.fn(async () => ({ externalId: null })),
    });
    expect(visto?.quarentena).toBeNull();
  });
});
