/**
 * TRAVA DURA: sem as DUAS chaves (disparo_config.modo = 'real' E
 * DISPARO_REAL_LIBERADO=sim), nada chega ao canal.
 *
 * A prova não é só a função pura: o motor INTEIRO roda contra um repositório em
 * memória com um `enviarReal` espião, em cada uma das combinações. O controle
 * positivo (as duas chaves viradas) existe para o teste não passar por
 * vacuidade — se o motor nunca chamasse o espião, as três combinações
 * "travadas" ficariam verdes sem provar nada.
 */
import { describe, expect, it, vi } from "vitest";

import { RITMO_PADRAO, type ConfigDisparo } from "./config";
import type { Chip, Contagem } from "./fila";
import { rodarDisparo, type EnvioDaFila, type EnvioReal, type LeadDoDisparo, type NovoEnvio, type RepositorioDisparo } from "./motor";
import { SEM_AVISO, SEM_HUMANO_NEM_AVISOS } from "./apoio-do-motor-teste";
import { chaveDoTelefone, destinoPermitido, envioRealLiberado, listaPermitida, MOTIVO_ALLOWLIST, motivoDoSimulado } from "./trava";

const ORG = "00000000-0000-4000-8000-000000000001";
const AGORA = new Date("2026-10-07T10:00:00-03:00"); // quarta, dentro da janela

function configCom(modo: "simulado" | "real"): ConfigDisparo {
  return {
    organizationId: ORG,
    ligado: true,
    modo,
    tetoDiario: null,
    cadencia: "reativacao_3_toques",
    fonteStageId: "stage-1",
    ritmo: { ...RITMO_PADRAO, feriados: [] },
    modelos: { abertura: ["{oi} Tudo bem? Posso te contar uma novidade?"], toque_2: ["{oi} Passando de novo."] },
    proibidos: [],
    slots: { fixos: {}, semNomeQuando: [] },
    escolha: [],
  };
}

/** Repositório em memória com só o que o motor usa. */
function repoEmMemoria(config: ConfigDisparo, leads: LeadDoDisparo[]) {
  const envios: (EnvioDaFila & { motivo?: string | null; enviadoEm?: Date | null })[] = [];
  const chip: Chip = {
    id: "chip-1",
    estado: "ativo",
    saude: "verde",
    diaRampa: 5,
    proximoEnvioEm: new Date(AGORA.getTime() - 60_000), // dia aberto, vez chegou
    pausadoAte: null,
    enviosDesdePausa: 0,
    pausaACada: 15,
  };
  let n = 0;
  const repo: RepositorioDisparo = {
    ...SEM_HUMANO_NEM_AVISOS,
    configsLigadas: async () => [config],
    chipsDaVolta: async () => [chip],
    contagem: async (): Promise<Contagem> => ({
      ultimoEnvioEm: null,
      ultimaNovaEm: null,
      enviosHoje: 0,
      aberturasHoje: 0,
      enviosUltimaHora: 0,
      aberturasUltimaHora: 0,
    }),
    mandouDesde: async () => true,
    atualizarChip: async (_o, _c, patch, ate) => {
      if (ate && chip.proximoEnvioEm && chip.proximoEnvioEm.getTime() > ate.getTime()) return false;
      Object.assign(chip, patch);
      return true;
    },
    proximoLeadParaAbertura: async () => leads.find((l) => !envios.some((e) => e.leadId === l.id && e.tipo === "abertura")) ?? null,
    enfileirar: async (_o, e: NovoEnvio) => {
      if (envios.some((x) => x.leadId === e.leadId && x.tipo === e.tipo)) return null;
      const novo = {
        id: `envio-${++n}`, leadId: e.leadId, chipId: e.chipId, tipo: e.tipo, origem: e.origem, texto: e.texto, midia: null, midiaId: null,
        enviarApos: e.enviarApos, estado: e.estado ?? "pendente", tentativas: 0, criadoEm: AGORA, daParada: false, motivo: e.motivo ?? null,
      } as const;
      envios.push({ ...novo });
      return { ...novo };
    },
    vencidos: async (_o, chipId, agora, limite) =>
      envios.filter((e) => e.chipId === chipId && e.estado === "pendente" && e.origem !== "lembrete" && e.enviarApos <= agora).slice(0, limite),
    lembretesVencidos: async () => [],
    reservar: async (_o, id) => {
      const e = envios.find((x) => x.id === id);
      if (!e || e.estado !== "pendente") return false;
      e.estado = "enviando";
      return true;
    },
    finalizar: async (_o, id, fim) => {
      const e = envios.find((x) => x.id === id)!;
      e.estado = fim.estado;
      if (fim.motivo !== undefined) e.motivo = fim.motivo;
      if (fim.enviadoEm !== undefined) e.enviadoEm = fim.enviadoEm;
    },
    lead: async (_o, id) => leads.find((l) => l.id === id) ?? null,
    respostasDesde: async () => [],
    origensRecentes: async () => [],
    cancelarPendentesDoLead: async () => 0,
    autoEmAbertoAntes: async () => false,
    adiarAutoDoLead: async () => 0,
    criadosDesde: async () => 0,
    saiuEm: async () => AGORA,
    lembretesNoDia: async () => 0,
    criarTarefa: async () => "tarefa-1",
  };
  return { repo, envios, chip };
}

const LEAD: LeadDoDisparo = {
  id: "lead-1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {},
};

async function volta(modo: "simulado" | "real", ambiente: Record<string, string | undefined>) {
  const { repo, envios, chip } = repoEmMemoria(configCom(modo), [LEAD]);
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid-1" }));
  const resumo = await rodarDisparo({ repo, agora: AGORA, ambiente, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  return { enviarReal, envios, resumo, chip };
}

describe("trava dupla (função pura)", () => {
  it("só modo real + DISPARO_REAL_LIBERADO=sim libera", () => {
    expect(envioRealLiberado({ modo: "real" }, { DISPARO_REAL_LIBERADO: "sim" })).toBe(true);
    expect(envioRealLiberado({ modo: "simulado" }, { DISPARO_REAL_LIBERADO: "sim" })).toBe(false);
    expect(envioRealLiberado({ modo: "real" }, {})).toBe(false);
    for (const quase of ["", "true", "1", "SIM", " sim", "yes", "s"]) {
      expect(envioRealLiberado({ modo: "real" }, { DISPARO_REAL_LIBERADO: quase })).toBe(false);
    }
    expect(motivoDoSimulado({ modo: "real" }, {})).toMatch(/DISPARO_REAL_LIBERADO/);
    expect(motivoDoSimulado({ modo: "simulado" }, {})).toMatch(/modo simulado/);
  });
});

describe("trava dupla (motor inteiro, repositório em memória)", () => {
  it.each([
    ["simulado", {}],
    ["simulado", { DISPARO_REAL_LIBERADO: "sim" }],
    ["real", {}],
    ["real", { DISPARO_REAL_LIBERADO: "true" }],
  ] as const)("modo %s com %j: nada vai para o canal, a abertura fica simulada", async (modo, ambiente) => {
    const { enviarReal, envios, resumo } = await volta(modo, ambiente);
    expect(enviarReal).not.toHaveBeenCalled();
    const abertura = envios.find((e) => e.tipo === "abertura")!;
    expect(abertura.estado).toBe("simulado");
    expect(abertura.enviadoEm).toEqual(AGORA);
    expect(resumo.organizacoes[0]!.modo).toBe("simulado");
    expect(resumo.organizacoes[0]!.simulados).toBe(1);
    // A cadência segue no ensaio: o toque 2 entra na fila, pendente.
    expect(envios.find((e) => e.tipo === "toque_2")?.estado).toBe("pendente");
  });

  it("controle positivo: com as DUAS chaves o motor chama o canal (o espião funciona)", async () => {
    const { enviarReal, envios, resumo } = await volta("real", { DISPARO_REAL_LIBERADO: "sim" });
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(envios.find((e) => e.tipo === "abertura")!.estado).toBe("enviado");
    expect(resumo.organizacoes[0]!.enviados).toBe(1);
  });

  it("lead bloqueado não recebe nem simulação", async () => {
    const { repo, envios } = repoEmMemoria(configCom("simulado"), [{ ...LEAD, bloqueado: true }]);
    const enviarReal = vi.fn<EnvioReal>();
    await rodarDisparo({ repo, agora: AGORA, ambiente: {}, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(envios[0]!.estado).toBe("cancelado");
  });

  it("fora da janela nenhuma abertura é planejada", async () => {
    const { repo, envios } = repoEmMemoria(configCom("simulado"), [LEAD]);
    await rodarDisparo({ repo, agora: new Date("2026-10-07T21:00:00-03:00"), ambiente: {}, sortear: () => 0.5, enviarReal: vi.fn<EnvioReal>(), enviarAviso: SEM_AVISO });
    expect(envios).toHaveLength(0);
  });
});

describe("terceira trava: DISPARO_SO_PARA (função pura)", () => {
  it("não definida (ausente, vazia ou só espaços): qualquer destino passa", () => {
    for (const amb of [{}, { DISPARO_SO_PARA: "" }, { DISPARO_SO_PARA: "   " }]) {
      expect(listaPermitida(amb)).toBeNull();
      expect(destinoPermitido("+5511999990000", amb)).toBe(true);
      expect(destinoPermitido(null, amb)).toBe(true);
    }
  });

  it("definida: só os números da lista passam", () => {
    const amb = { DISPARO_SO_PARA: "+5511999990000, +5521988887777" };
    expect(destinoPermitido("+5511999990000", amb)).toBe(true);
    expect(destinoPermitido("+5521988887777", amb)).toBe(true);
    expect(destinoPermitido("+5511911112222", amb)).toBe(false);
    expect(destinoPermitido(null, amb)).toBe(false);
    expect(destinoPermitido("", amb)).toBe(false);
  });

  it("número formatado diferente é o mesmo número", () => {
    const amb = { DISPARO_SO_PARA: "+5511999990000" };
    for (const f of ["5511999990000", "+55 (11) 99999-0000", "(11) 99999-0000", "11999990000", "55 11 9 9999 0000", "+55 11 9999-0000", "551199990000", "005511999990000"]) {
      expect(destinoPermitido(f, amb), f).toBe(true);
    }
    expect(destinoPermitido("+5511999990001", amb)).toBe(false);
    expect(destinoPermitido("+5511999990000", { DISPARO_SO_PARA: "(11) 99999-0000" })).toBe(true);
  });

  it("definida mas ilegível barra tudo (fail-closed)", () => {
    const amb = { DISPARO_SO_PARA: "abc, ,123" };
    expect(listaPermitida(amb)?.size).toBe(0);
    expect(destinoPermitido("+5511999990000", amb)).toBe(false);
  });

  it("chaveDoTelefone rejeita o que não é telefone", () => {
    expect(chaveDoTelefone("abc")).toBeNull();
    expect(chaveDoTelefone("")).toBeNull();
    expect(chaveDoTelefone(undefined)).toBeNull();
  });
});

describe("terceira trava (motor inteiro)", () => {
  const LIBERADO = { DISPARO_REAL_LIBERADO: "sim" };

  it("não definida: comportamento de sempre, o lead sai", async () => {
    const { enviarReal, envios, resumo } = await volta("real", LIBERADO);
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(envios.find((e) => e.tipo === "abertura")!.estado).toBe("enviado");
    expect(resumo.organizacoes[0]!.bloqueadosAllowlist).toBe(0);
  });

  it("definida com o número do lead: o lead sai", async () => {
    const { enviarReal, envios } = await volta("real", { ...LIBERADO, DISPARO_SO_PARA: "+55 (11) 99999-0000" });
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(envios.find((e) => e.tipo === "abertura")!.estado).toBe("enviado");
  });

  it("definida sem o número do lead: não chama o canal, registra o bloqueio e não é falha", async () => {
    const { enviarReal, envios, resumo, chip } = await volta("real", { ...LIBERADO, DISPARO_SO_PARA: "+5521988887777" });
    expect(enviarReal).not.toHaveBeenCalled();
    const abertura = envios.find((e) => e.tipo === "abertura")!;
    expect(abertura.estado).toBe("cancelado");
    expect(abertura.motivo).toBe(MOTIVO_ALLOWLIST);
    expect(abertura.tentativas).toBe(0);
    expect(envios.some((e) => e.estado === "falhou" || e.estado === "pendente")).toBe(false);
    const org = resumo.organizacoes[0]!;
    expect(org.bloqueadosAllowlist).toBe(1);
    expect(org.falhas).toBe(0);
    expect(org.enviados).toBe(0);
    expect(chip.saude).toBe("verde");
    expect(chip.estado).toBe("ativo");
  });

  it("a allowlist não abre a trava: sem as duas chaves continua simulado", async () => {
    const { enviarReal, envios } = await volta("real", { DISPARO_SO_PARA: "+5511999990000" });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(envios.find((e) => e.tipo === "abertura")!.estado).toBe("simulado");
  });
});
