// @vitest-environment node
/**
 * Travas do motor contra envio em dobro, fila presa e fila velha (auditoria 3).
 * Cada caso que barra tem o irmão que passa, na mesma montagem.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import type { ConfigDisparo } from "./config";
import { type EnvioReal, type LeadDoDisparo, MARCA_NO_CANAL, rodarDisparo } from "./motor";

const ORG = "00000000-0000-4000-8000-0000000000d1";
const AGORA = new Date("2026-10-23T12:00:00-03:00");
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const s = (n: number) => n * 1000;

const lead = (p: Partial<LeadDoDisparo> = {}): LeadDoDisparo => ({
  id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {}, ...p,
});

/** Parte `n` da sequência do operador, vencendo `venceHaSeg` segundos antes de AGORA. */
function parte(n: number, venceHaSeg: number, p: Partial<LinhaEnvio> = {}): LinhaEnvio {
  return {
    id: `p${n}`, leadId: "l1", chipId: "chip-1", tipo: `funil_valores:${n}`, origem: "operador", texto: `parte ${n}`, midia: null, midiaId: null,
    enviarApos: new Date(AGORA.getTime() - s(venceHaSeg)), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - s(venceHaSeg + 5)), daParada: false, ...p,
  };
}

function montar(fila: LinhaEnvio[], config: ConfigDisparo = { ...configDoMotor(ORG, "real"), fonteStageId: null }, leads = [lead()]) {
  const mem = motorEmMemoria(AGORA, config, leads);
  mem.envios.push(...fila);
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "wamid-1" }));
  const rodar = (agora = AGORA) => rodarDisparo({ repo: mem.repo, agora, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  return { ...mem, enviarReal, rodar };
}

describe("C1: erro DEPOIS que o canal aceitou não reenvia nem freia o chip", () => {
  it("irmão: tudo certo, a parte vira `enviado` com o external_id", async () => {
    const m = montar([parte(1, 20)]);
    await m.rodar();
    expect(m.envios[0]).toMatchObject({ estado: "enviado", externalId: "wamid-1" });
  });

  it("o registro de `enviado` falha: a linha NÃO volta a `pendente`, o chip não fica vermelho, e a volta seguinte não manda de novo", async () => {
    const m = montar([parte(1, 20)]);
    const original = m.repo.finalizar;
    m.repo.finalizar = async (o, id, fim, se) => {
      if (fim.estado === "enviado") throw new Error("disparo_finalizar: connection closed");
      return original(o, id, fim, se);
    };
    const r = await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.envios[0]!.estado).not.toBe("pendente");
    expect(m.chip.saude).toBe("verde");
    expect(m.chip.pausadoAte).toBeNull();
    expect(r.organizacoes[0]!.enviados).toBe(1);

    await m.rodar(new Date(AGORA.getTime() + 15 * 60_000));
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
  });

  it("o adiamento das partes seguintes falha depois do envio: a parte fica `enviado`, sem reenvio nem freio", async () => {
    const m = montar([parte(1, 180), parte(2, 170)]);
    m.repo.adiarAutoDoLead = async () => {
      throw new Error("disparo_adiar_auto: timeout");
    };
    await m.rodar();
    expect(m.envios[0]!.estado).toBe("enviado");
    expect(m.envios[1]!.estado).toBe("pendente");
    expect(m.chip.saude).toBe("verde");
    expect(m.chip.proximoEnvioEm!.getTime()).toBeLessThan(AGORA.getTime());
  });

  it("o `enviado` só é gravado sobre a linha ainda `enviando` (a varredura que já a fechou não é sobrescrita)", async () => {
    const m = montar([parte(1, 20)]);
    const finalizar = vi.spyOn(m.repo, "finalizar");
    await m.rodar();
    const chamada = finalizar.mock.calls.find((c) => c[2].estado === "enviado")!;
    expect(chamada[3]).toBe("enviando");
  });

  it("irmão: erro do CANAL continua sendo falha de envio (volta à fila, e restrição freia o chip)", async () => {
    const m = montar([parte(1, 20)]);
    m.enviarReal.mockImplementation(async () => {
      throw new Error("connection closed");
    });
    await m.rodar();
    expect(m.envios[0]).toMatchObject({ estado: "pendente", tentativas: 1 });
    expect(m.chip.saude).toBe("vermelho");
  });
});

describe("C2: linha `pendente` sem chip não fica presa para sempre", () => {
  const auto = (p: Partial<LinhaEnvio> = {}): LinhaEnvio =>
    parte(1, 60, { id: "a1", tipo: "tabela_valores", origem: "auto", chipId: null, ...p });

  it("o motor acha o chip pela conversa da lead e a resposta sai por ele", async () => {
    const m = montar([auto()]);
    m.chipDaConversa.set("l1", "chip-1");
    await m.rodar();
    expect(m.envios[0]).toMatchObject({ chipId: "chip-1", estado: "enviado" });
  });

  it("sem chip nenhum: a linha é cancelada com o motivo e o operador é avisado na Central (uma vez)", async () => {
    const m = montar([auto(), auto({ id: "a2", tipo: "tabela_valores_2" })]);
    await m.rodar();
    expect(m.envios.map((e) => e.estado)).toEqual(["cancelado", "cancelado"]);
    expect(m.envios[0]!.motivo).toMatch(/sem chip/);
    expect(m.central.filter((a) => a.leadId === "l1")).toHaveLength(1);
    expect(m.enviarReal).not.toHaveBeenCalled();
  });

  it("com as respostas sem chip resolvidas, o aviso ao celular do operador que esperava o pacote sai", async () => {
    const m = montar([auto()]);
    m.avisos.push({ id: "av1", leadId: "l1", chipId: "chip-1", canalId: "canal-1", destino: "5511900000001", texto: "a lead pediu o kit", enviarApos: new Date(AGORA.getTime() - 60_000), tentativas: 0, estado: "pendente" });
    const enviarAviso = vi.fn(async () => ({ externalId: "wamid-aviso" }));
    await rodarDisparo({ repo: m.repo, agora: AGORA, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal: m.enviarReal, enviarAviso });
    expect(enviarAviso).toHaveBeenCalledTimes(1);
  });
});

describe("C3: fila velha não sai fora de contexto", () => {
  const H = 3600;
  const auto = (venceHaSeg: number, p: Partial<LinhaEnvio> = {}): LinhaEnvio =>
    parte(1, venceHaSeg, { id: "a1", tipo: "tabela_valores:seq", origem: "auto", ...p });
  const toque = (venceHaSeg: number): LinhaEnvio => parte(1, venceHaSeg, { id: "t2", tipo: "toque_2", origem: "motor", texto: "Oi Maria, passando de novo." });

  it("os limites têm padrão conservador: resposta automática 2 h, toque 24 h", () => {
    const r = configDoMotor(ORG, "real").ritmo.validade;
    expect(r.autoHoras).toBe(2);
    expect(r.toqueAtrasoHoras).toBe(24);
  });

  it("irmão: resposta automática atrasada 1 h ainda sai", async () => {
    const m = montar([auto(1 * H)]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
  });

  it("resposta automática atrasada mais de 2 h (chip vermelho dias, pausa): cancelada com o motivo, o resto da sequência junto, e o operador avisado", async () => {
    const m = montar([auto(4 * 24 * H), auto(4 * 24 * H - 3, { id: "a2", tipo: "tabela_valores:seq" })]);
    await m.rodar();
    expect(m.enviarReal).not.toHaveBeenCalled();
    expect(m.envios.map((e) => e.estado)).toEqual(["cancelado", "cancelado"]);
    expect(m.envios[0]!.motivo).toMatch(/vencid/);
    expect(m.central.some((a) => a.leadId === "l1")).toBe(true);
  });

  it("resposta automática e a lead escreveu DEPOIS que ela foi planejada: não sai", async () => {
    const config = { ...configDoMotor(ORG, "real"), fonteStageId: null };
    const mem = motorEmMemoria(AGORA, config, [lead()], { respostas: () => ["oi, ainda tá aí?"] });
    mem.envios.push(auto(60));
    const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "x" }));
    await rodarDisparo({ repo: mem.repo, agora: AGORA, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
    expect(enviarReal).not.toHaveBeenCalled();
    expect(mem.envios[0]!.estado).toBe("cancelado");
  });

  it("irmão: o pacote do ponto de parada (`daParada`) sai mesmo com a lead escrevendo no meio", async () => {
    const config = { ...configDoMotor(ORG, "real"), fonteStageId: null };
    const mem = motorEmMemoria(AGORA, config, [lead()], { respostas: () => ["oi"] });
    mem.envios.push(auto(60, { daParada: true }));
    const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "x" }));
    await rodarDisparo({ repo: mem.repo, agora: AGORA, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
    expect(enviarReal).toHaveBeenCalledTimes(1);
  });

  it("irmão: toque atrasado 2 h sai", async () => {
    const m = montar([toque(2 * H)]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
  });

  it("toque atrasado mais de 24 h não sai em rajada: é reprogramado para frente, com o motivo", async () => {
    const m = montar([toque(3 * 24 * H)]);
    await m.rodar();
    expect(m.enviarReal).not.toHaveBeenCalled();
    expect(m.envios[0]!.estado).toBe("pendente");
    expect(m.envios[0]!.enviarApos.getTime()).toBeGreaterThan(AGORA.getTime());
    expect(m.envios[0]!.motivo).toMatch(/reprogramad/);
  });
});

describe("A1: linha presa em `enviando` não trava a lead para sempre (e nunca é reenviada às cegas)", () => {
  const presa = (minAtras: number, p: Partial<LinhaEnvio> = {}): LinhaEnvio =>
    parte(1, 20, { estado: "enviando", atualizadoEm: new Date(AGORA.getTime() - minAtras * 60_000), ...p });

  it("irmão: presa há 3 min (a volta pode estar no meio) não é tocada", async () => {
    const m = montar([presa(3, { motivo: MARCA_NO_CANAL })]);
    await m.rodar();
    expect(m.envios[0]!.estado).toBe("enviando");
  });

  it("com external_id: o canal aceitou, só o registro faltou — vira `enviado`, sem reenvio", async () => {
    const m = montar([presa(20, { externalId: "wamid-velho" })]);
    await m.rodar();
    expect(m.envios[0]!.estado).toBe("enviado");
    expect(m.enviarReal).not.toHaveBeenCalled();
  });

  it("sem sinal de que chamou o canal (a volta morreu antes): volta para a fila e sai uma vez", async () => {
    const m = montar([presa(20)]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.envios[0]!.estado).toBe("enviado");
  });

  it("com sinal de que chamou o canal e sem desfecho: NÃO reenvia — `falhou` com o motivo, resto da sequência cancelado, operador avisado", async () => {
    const m = montar([presa(20, { motivo: MARCA_NO_CANAL }), parte(2, 10)]);
    await m.rodar();
    expect(m.enviarReal).not.toHaveBeenCalled();
    expect(m.envios[0]!.estado).toBe("falhou");
    expect(m.envios[0]!.motivo).toMatch(/pode ter saído/);
    expect(m.envios[1]!.estado).toBe("cancelado");
    expect(m.central.some((a) => a.leadId === "l1" && /confira/i.test(a.corpo))).toBe(true);
  });

  it("o motor marca a linha ANTES de chamar o canal (é o sinal que a varredura lê)", async () => {
    const m = montar([parte(1, 20)]);
    let marcaNaChamada: string | null | undefined;
    m.enviarReal.mockImplementation(async () => {
      marcaNaChamada = m.envios[0]!.motivo;
      return { externalId: "w" };
    });
    await m.rodar();
    expect(marcaNaChamada).toBe(MARCA_NO_CANAL);
  });
});

describe("E5: a reserva tem dono — a volta que perdeu a reserva não chama o canal", () => {
  /**
   * Volta A reserva a linha e trava (banco lento, processo congelado) antes de chamar o canal por mais que
   * `enviandoPresoMin`; a trava do chip (4 min) já venceu. A volta B: a varredura devolve a linha à fila (sem a marca de
   * canal), B a reserva de novo e está no meio da chamada ao canal quando A acorda. Sem dono, a marca de A confere só
   * `estado = 'enviando'` — que é a reserva de B — e A manda a MESMA mensagem: duas cópias.
   */
  function corrida() {
    const leads = [lead()];
    const m = { ...montar([parte(1, 20)], undefined, leads), leads };
    let soltarA!: () => void;
    const aPresa = new Promise<void>((r) => (soltarA = r));
    let aParou!: () => void;
    const aNaLeitura = new Promise<void>((r) => (aParou = r));
    const leadOriginal = m.repo.lead;
    let primeiraLeitura = true;
    m.repo.lead = async (o, id) => {
      if (primeiraLeitura) {
        primeiraLeitura = false;
        aParou();
        await aPresa;
      }
      return leadOriginal(o, id);
    };
    let bChamou!: () => void;
    const bNoCanal = new Promise<void>((r) => (bChamou = r));
    let soltarB!: () => void;
    const bPresa = new Promise<void>((r) => (soltarB = r));
    let chamadas = 0;
    m.enviarReal.mockImplementation(async () => {
      chamadas++;
      if (chamadas === 1) {
        bChamou();
        await bPresa;
        return { externalId: "wamid-B" };
      }
      return { externalId: "wamid-A" };
    });
    return { m, aNaLeitura, soltarA, bNoCanal, soltarB };
  }

  it("A acorda com a linha reservada por B: A NÃO chama o canal; sai uma cópia só, a de B", async () => {
    const { m, aNaLeitura, soltarA, bNoCanal, soltarB } = corrida();
    const voltaA = m.rodar(AGORA);
    await aNaLeitura;
    m.travasDeChip.clear(); // a trava de 4 min de A venceu
    const voltaB = m.rodar(new Date(AGORA.getTime() + 15 * 60_000));
    await bNoCanal;
    soltarA();
    await voltaA;
    soltarB();
    await voltaB;
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.envios[0]).toMatchObject({ estado: "enviado", externalId: "wamid-B" });
  });

  it("a volta que perdeu a reserva também não mexe no desfecho de quem a tem (nem devolve à fila, nem cancela)", async () => {
    const { m, aNaLeitura, soltarA, bNoCanal, soltarB } = corrida();
    const voltaA = m.rodar(AGORA);
    await aNaLeitura;
    m.travasDeChip.clear();
    const voltaB = m.rodar(new Date(AGORA.getTime() + 15 * 60_000));
    await bNoCanal;
    m.leads[0]!.bloqueado = true; // A acorda e veria o lead bloqueado: cancelaria a linha de B
    soltarA();
    await voltaA;
    expect(m.envios[0]!.estado).toBe("enviando"); // continua de B
    soltarB();
    await voltaB;
    expect(m.envios[0]).toMatchObject({ estado: "enviado", externalId: "wamid-B" });
  });

  it("irmão: sem corrida, a reserva da própria volta marca, chama o canal e fecha normalmente", async () => {
    const m = montar([parte(1, 20)]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.envios[0]).toMatchObject({ estado: "enviado", externalId: "wamid-1" });
  });
});

describe("A2: erro numa organização ou num chip não derruba os outros nem deixa reserva órfã", () => {
  it("erro de banco depois da reserva e antes do canal: a linha volta para `pendente` (não fica `enviando`), e a volta não lança", async () => {
    const m = montar([parte(1, 20)]);
    m.repo.lead = async () => {
      throw new Error("disparo_lead: timeout");
    };
    const r = await m.rodar();
    expect(m.envios[0]!.estado).toBe("pendente");
    expect(m.enviarReal).not.toHaveBeenCalled();
    expect(r.organizacoes[0]!.falhas).toBe(1);
    expect(r.organizacoes[0]!.chips[0]!.resultado).toMatch(/erro/);
  });

  it("uma organização com erro não impede a outra de rodar na mesma volta", async () => {
    const m = montar([parte(1, 20)]);
    const outra = { ...configDoMotor("00000000-0000-4000-8000-0000000000d2", "real"), fonteStageId: null };
    const original = m.repo.chipsDaVolta;
    m.repo.configsLigadas = async () => [outra, { ...configDoMotor(ORG, "real"), fonteStageId: null }];
    m.repo.chipsDaVolta = async (org) => {
      if (org === outra.organizationId) throw new Error("disparo_chips: connection reset");
      return original(org);
    };
    const r = await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(r.organizacoes.find((o) => o.organizationId === outra.organizationId)!.erro).toMatch(/connection reset/);
    expect(r.efeito).toBe(true);
  });
});

describe("A4: a janela de resposta vale também na hora do envio", () => {
  const NOITE = new Date("2026-10-23T22:30:00-03:00");
  const auto = (p: Partial<LinhaEnvio> = {}): LinhaEnvio =>
    parte(1, 0, { id: "a1", tipo: "tabela_valores:seq", origem: "auto", enviarApos: new Date(NOITE.getTime() - 60_000), criadoEm: new Date(NOITE.getTime() - 120_000), ...p });

  it("irmão: às 21h a resposta automática sai", async () => {
    const m = montar([auto({ enviarApos: new Date("2026-10-23T21:00:00-03:00"), criadoEm: new Date("2026-10-23T20:59:00-03:00") })]);
    await m.rodar(new Date("2026-10-23T21:00:30-03:00"));
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
  });

  it("resposta automática vencida às 22h30 não sai: ela e as partes seguintes vão para a abertura da janela, na mesma ordem", async () => {
    const m = montar([auto(), auto({ id: "a2", enviarApos: new Date(NOITE.getTime() + 3000) })]);
    await m.rodar(NOITE);
    expect(m.enviarReal).not.toHaveBeenCalled();
    const [a1, a2] = m.envios;
    expect(a1!.estado).toBe("pendente");
    expect(a1!.motivo).toMatch(/janela/);
    const local = new Date(a1!.enviarApos.getTime() - 3 * 3600_000);
    expect(local.getUTCDate()).toBe(24);
    expect(local.getUTCHours()).toBe(8);
    expect(a2!.enviarApos.getTime()).toBeGreaterThan(a1!.enviarApos.getTime());
  });

  // Regra: o funil que o operador manda à mão só exige chip saudável; a janela
  // de resposta não o barra (quem clicou está na conversa naquela hora). A resposta automática, acima, segue barrada.
  it("sequência do operador fora da janela: sai (envio manual não respeita a janela da resposta automática)", async () => {
    const m = montar([parte(1, 0, { enviarApos: new Date(NOITE.getTime() - 60_000), criadoEm: new Date(NOITE.getTime() - 61_000) })]);
    await m.rodar(NOITE);
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.envios[0]!.estado).toBe("enviado");
  });

  it("a janela da organização (atendimento.janelaResposta) é a que vale", async () => {
    const config = { ...configDoMotor(ORG, "real"), fonteStageId: null, janelaResposta: { inicioMin: 8 * 60, fimMin: 23 * 60 } };
    const m = montar([auto()], config);
    await m.rodar(NOITE);
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
  });
});

describe("A5: uma volta por chip de cada vez, e toda volta registrada", () => {
  it("chip com a trava de outra volta: esta volta não mexe nele", async () => {
    const m = montar([parte(1, 20)]);
    m.travasDeChip.set("chip-1", "outra-volta");
    const r = await m.rodar();
    expect(m.enviarReal).not.toHaveBeenCalled();
    expect(r.organizacoes[0]!.chips[0]!.resultado).toMatch(/outra volta/);
  });

  it("irmão: chip livre roda, e a trava é solta no fim da volta", async () => {
    const m = montar([parte(1, 20)]);
    await m.rodar();
    expect(m.enviarReal).toHaveBeenCalledTimes(1);
    expect(m.travasDeChip.size).toBe(0);
  });

  it("a trava fica com a volta enquanto ela segue a sequência (a volta seguinte do cron não entra no meio) e é solta depois", async () => {
    const m = montar([parte(1, 20), parte(2, 17)]);
    let relogio = AGORA.getTime();
    const trancadoNaPausa: boolean[] = [];
    await rodarDisparo({
      repo: m.repo, agora: AGORA, ambiente: AMBIENTE, sortear: () => 0.5, enviarReal: m.enviarReal, enviarAviso: SEM_AVISO,
      sequencia: {
        relogio: () => new Date(relogio),
        dormir: async (ms) => {
          trancadoNaPausa.push(m.travasDeChip.has("chip-1"));
          relogio += ms;
        },
        orcamentoMs: 110_000,
      },
    });
    expect(m.enviarReal).toHaveBeenCalledTimes(2);
    expect(trancadoNaPausa.length).toBeGreaterThan(0);
    expect(trancadoNaPausa.every(Boolean)).toBe(true);
    expect(m.travasDeChip.size).toBe(0);
  });

  it("toda volta é registrada (duração e resultado por chip), inclusive a que não fez nada", async () => {
    const m = montar([]);
    const r = await m.rodar();
    expect(r.efeito).toBe(false);
    expect(m.voltas).toHaveLength(1);
    expect(m.voltas[0]!.duracaoMs).toBeGreaterThanOrEqual(0);
    expect(m.voltas[0]!.resultado).toMatchObject({ chips: [{ chipId: "chip-1" }] });
  });
});

describe("parada silenciosa: motor ligado sem nada a enviar avisa o operador uma vez por dia", () => {
  const TARDE = new Date("2026-10-23T15:00:00-03:00"); // sexta, janela 8h–19h aberta há 7 h
  const comOrigem = () => ({ ...configDoMotor(ORG, "real") }); // fonteStageId = "stage-1"

  it("etapa de origem sem lead elegível e nada saiu hoje: um aviso na Central, com o motivo; a volta seguinte não repete", async () => {
    const m = montar([], comOrigem(), []);
    await m.rodar(TARDE);
    await m.rodar(new Date(TARDE.getTime() + 60_000));
    const avisos = m.central.filter((a) => /parado/i.test(a.titulo));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.corpo).toMatch(/nenhum lead pronto/);
    expect(avisos[0]!.umaVezDesde).toBeDefined();
  });

  it("todos os chips vermelhos: o aviso diz que os chips estão parados", async () => {
    const m = montar([], comOrigem(), [lead()]);
    m.chip.saude = "vermelho";
    m.chip.saudeMotivo = "Conexão caiu 1x no dia";
    await m.rodar(TARDE);
    const aviso = m.central.find((a) => /parado/i.test(a.titulo))!;
    expect(aviso.corpo).toMatch(/vermelh/);
    expect(aviso.corpo).toMatch(/Conexão caiu/);
  });

  it("irmão: algo saiu hoje, não avisa", async () => {
    const m = montar([{ ...parte(1, 3600), estado: "enviado", enviadoEm: new Date(TARDE.getTime() - 3600_000) }], comOrigem(), []);
    await m.rodar(TARDE);
    expect(m.central.filter((a) => /parado/i.test(a.titulo))).toEqual([]);
  });

  it("irmão: janela aberta há menos de 4 h (9h), ainda não avisa", async () => {
    const m = montar([], comOrigem(), []);
    await m.rodar(new Date("2026-10-23T09:00:00-03:00"));
    expect(m.central.filter((a) => /parado/i.test(a.titulo))).toEqual([]);
  });

  it("irmão: domingo à tarde, fora da janela de prospecção do dia, não avisa", async () => {
    const m = montar([], comOrigem(), []);
    await m.rodar(new Date("2026-10-25T15:00:00-03:00"));
    expect(m.central.filter((a) => /parado/i.test(a.titulo))).toEqual([]);
  });
});
