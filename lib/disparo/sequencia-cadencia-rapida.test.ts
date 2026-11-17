// @vitest-environment node
/**
 * Cadência rápida da sequência do operador: depois de texto ou imagem a próxima parte sai 3 s depois;
 * depois de áudio, de 29 a 34 s. O motor entrega nesse ritmo DENTRO da mesma volta (laço com `dormir`), sem esperar
 * o cron seguinte nem o intervalo mínimo do chip, mas sempre na ordem e com TODAS as outras travas.
 *
 * O relógio é VIRTUAL: `dormir` só anda o relógio, então uma volta com ~75 s de pausas roda em milissegundos, e o
 * teste lê o instante de cada envio no próprio relógio. `contagem` é a REAL (o que já saiu do chip), não a zerada:
 * sem isso o intervalo mínimo de 90 s e os limites por hora/dia nunca seriam exercitados.
 */
import { describe, expect, it, vi } from "vitest";

import { CONTAGEM_ZERADA, configDoMotor, type LinhaEnvio, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import type { SituacaoHumana } from "./atendimento/humano";
import type { Contagem } from "./fila";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo } from "./motor";
import { tetoTotal } from "./ritmo";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const AGORA = new Date("2026-10-23T12:00:00-03:00");
const AMBIENTE = { DISPARO_REAL_LIBERADO: "sim" };
const s = (n: number) => n * 1000;

const lead = (p: Partial<LeadDoDisparo> = {}): LeadDoDisparo => ({
  id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {}, ...p,
});

/** Parte `n` (1..7) da sequência, vencendo `venceEmSeg` segundos DEPOIS de AGORA (negativo = já venceu). */
function parte(n: number, venceEmSeg: number, p: Partial<LinhaEnvio> = {}): LinhaEnvio {
  return {
    id: `p${n}`, leadId: "l1", chipId: "chip-1", tipo: `funil_valores:${n}`, origem: "operador", texto: `parte ${n}`, midia: null, midiaId: null,
    enviarApos: new Date(AGORA.getTime() + s(venceEmSeg)), estado: "pendente", tentativas: 0, criadoEm: new Date(AGORA.getTime() - s(30)), daParada: false, ...p,
  };
}

/** texto, ÁUDIO, texto, imagem, texto, ÁUDIO, texto: 3 s depois de texto/imagem, 31,5 s depois de áudio. */
const OFFSETS_DO_FUNIL = [0, 3, 34.5, 37.5, 40.5, 43.5, 75];
const funil = (offsets = OFFSETS_DO_FUNIL) => offsets.map((o, i) => parte(i + 1, o));
const textos = (n: number) => Array.from({ length: n }, (_, i) => `parte ${i + 1}`);

type Montagem = {
  fila: LinhaEnvio[];
  leads?: LeadDoDisparo[];
  humano?: Map<string, SituacaoHumana>;
  modo?: "simulado" | "real";
  orcamentoSeg?: number;
  ritmo?: Partial<ReturnType<typeof configDoMotor>["ritmo"]>;
  /** O que o chip já tinha mandado antes da volta. */
  base?: Partial<Contagem>;
  /** O que a lead escreveu (lido a cada parte; muda no meio da sequência). */
  respostas?: () => string[];
  /** Roda a cada envio ao canal: o teste mexe no mundo no meio da sequência. */
  aoEnviar?: (n: number, mem: ReturnType<typeof motorEmMemoria>) => void;
  enviar?: EnvioReal;
  ambiente?: Record<string, string | undefined>;
  semSequencia?: boolean;
  /** Tempo (ms) que a passada NORMAL da volta gasta no banco antes de mandar a 1ª parte (o laço gasta menos por parte). */
  latenciaDaPassadaMs?: number;
  /** Tempo (ms) de cada leitura de `contagem` (a cada parte do laço, antes de mandar): o relógio virtual anda. */
  latenciaPorParteMs?: number;
};

function montar(m: Montagem) {
  const config = { ...configDoMotor(ORG, m.modo ?? "real"), fonteStageId: null };
  if (m.ritmo) config.ritmo = { ...config.ritmo, ...m.ritmo };
  let t = AGORA.getTime();
  const relogio = () => new Date(t);
  const dormir = vi.fn(async (ms: number) => void (t += ms));
  const contagem = (): Contagem => {
    const saidos = mem.envios.filter((e) => (e.estado === "enviado" || e.estado === "simulado") && e.enviadoEm);
    const ultimo = saidos.reduce<Date | null>((a, e) => (!a || e.enviadoEm! > a ? e.enviadoEm! : a), null);
    return {
      ...CONTAGEM_ZERADA,
      ...m.base,
      ultimoEnvioEm: ultimo ?? m.base?.ultimoEnvioEm ?? null,
      enviosHoje: (m.base?.enviosHoje ?? 0) + saidos.length,
      enviosUltimaHora: (m.base?.enviosUltimaHora ?? 0) + saidos.filter((e) => e.enviadoEm!.getTime() >= t - 3_600_000).length,
    };
  };
  const mem = motorEmMemoria(AGORA, config, m.leads ?? [lead()], { humano: m.humano, contagem, respostas: m.respostas ? () => m.respostas!() : undefined });
  mem.envios.push(...m.fila);
  if (m.latenciaPorParteMs) {
    const original = mem.repo.contagem;
    mem.repo.contagem = async (...a) => (await dormir(m.latenciaPorParteMs!), original(...a));
  }
  if (m.latenciaDaPassadaMs) {
    const original = mem.repo.mandouDesde;
    mem.repo.mandouDesde = async (...a) => (await dormir(m.latenciaDaPassadaMs!), original(...a));
  }
  const saidas: { texto: string; seg: number }[] = [];
  const enviarReal = vi.fn<EnvioReal>(async (p) => {
    saidas.push({ texto: p.texto, seg: (t - AGORA.getTime()) / 1000 });
    m.aoEnviar?.(saidas.length, mem);
    if (m.enviar) return m.enviar(p);
    return { externalId: `wamid-${saidas.length}` };
  });
  /** Uma volta do cron, que começa em `agora` (padrão: o relógio virtual). */
  const rodar = (agora = relogio()) =>
    rodarDisparo({
      repo: mem.repo,
      agora,
      ambiente: m.ambiente ?? AMBIENTE,
      sortear: () => 0.5,
      enviarReal,
      enviarAviso: SEM_AVISO,
      sequencia: m.semSequencia ? undefined : { relogio, dormir, orcamentoMs: s(m.orcamentoSeg ?? 600) },
    });
  const irPara = (seg: number) => void (t = AGORA.getTime() + s(seg));
  return { ...mem, config, enviarReal, saidas, dormir, rodar, irPara, relogio, estados: () => Object.fromEntries(mem.envios.map((e) => [e.id, e.estado])) };
}

describe("cadência rápida: o motor entrega nesse ritmo", () => {
  it("as 7 numa só volta, na ordem, 3 s depois de texto/imagem e 31,5 s depois de áudio (o piso de 90 s do chip NÃO a segura)", async () => {
    const v = montar({ fila: funil() });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(7));
    expect(v.saidas.map((x) => x.seg)).toEqual(OFFSETS_DO_FUNIL);
    const pausas = v.saidas.slice(1).map((x, i) => x.seg - v.saidas[i]!.seg);
    expect(pausas).toEqual([3, 31.5, 3, 3, 3, 31.5]);
    expect(Object.values(v.estados()).every((e) => e === "enviado")).toBe(true);
  });

  it("pausas sorteadas entre 29 e 34 s são entregues como foram gravadas (sem arredondar para a volta seguinte)", async () => {
    const offsets = [0, 3, 32.3, 35.3, 38.3, 41.3, 73.6];
    const v = montar({ fila: funil(offsets) });
    await v.rodar();
    expect(v.saidas.map((x) => x.seg)).toEqual(offsets);
  });

  it("em modo simulado percorre a sequência (cada parte vira `simulado`) sem chamar o canal", async () => {
    const v = montar({ fila: funil(), modo: "simulado" });
    await v.rodar();
    expect(v.enviarReal).not.toHaveBeenCalled();
    expect(Object.values(v.estados()).every((e) => e === "simulado")).toBe(true);
  });

  it("a ordem manda: com a parte 3 falhando, da 4 em diante NÃO passam na frente e esperam junto da nova tentativa", async () => {
    const v = montar({
      fila: funil(),
      enviar: async (p) => {
        if (p.texto === "parte 3") throw new Error("timeout do canal");
        return { externalId: "ok" };
      },
    });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(3));
    expect(v.estados()).toMatchObject({ p1: "enviado", p2: "enviado", p3: "pendente", p4: "pendente", p5: "pendente", p6: "pendente", p7: "pendente" });
    const p3 = v.envios[2]!;
    const p4 = v.envios[3]!;
    expect(p3.tentativas).toBe(1);
    expect(p4.enviarApos.getTime()).toBeGreaterThan(p3.enviarApos.getTime() - 1);
  });

  it("três falhas seguidas numa parte cancelam o resto (a ordem nunca é furada)", async () => {
    const v = montar({
      fila: funil().map((e) => (e.id === "p3" ? { ...e, tentativas: 2 } : e)),
      enviar: async (p) => {
        if (p.texto === "parte 3") throw new Error("timeout do canal");
        return { externalId: "ok" };
      },
    });
    await v.rodar();
    expect(v.estados()).toMatchObject({ p3: "falhou", p4: "cancelado", p5: "cancelado", p6: "cancelado", p7: "cancelado" });
  });
});

describe("cadência rápida: a pausa é medida entre as CHAMADAS ao canal", () => {
  it("a 1ª parte sai atrasada por latência de banco (400 ms): as seguintes andam junto e a pausa entre chamadas NUNCA fica menor que a planejada", async () => {
    const v = montar({ fila: funil(), latenciaDaPassadaMs: 400 });
    await v.rodar();
    expect(v.saidas).toHaveLength(7);
    const pausas = v.saidas.slice(1).map((x, i) => x.seg - v.saidas[i]!.seg);
    const planejado = [3, 31.5, 3, 3, 3, 31.5];
    pausas.forEach((p, i) => expect(p).toBeGreaterThanOrEqual(planejado[i]!));
  });
});

describe("cadência rápida: a pausa também vale para as partes de um toque do kit (origem motor)", () => {
  it("a 1ª parte do toque sai atrasada por latência (400 ms): a pausa entre as chamadas NUNCA fica menor que a planejada", async () => {
    const v = montar({ fila: [kit(1, 0), kit(2, 3), kit(3, 34.5)], latenciaDaPassadaMs: 400 });
    await v.rodar();
    expect(v.saidas).toHaveLength(3);
    expect(v.saidas[1]!.seg - v.saidas[0]!.seg).toBeGreaterThanOrEqual(3);
    expect(v.saidas[2]!.seg - v.saidas[1]!.seg).toBeGreaterThanOrEqual(31.5);
  });
});

describe("cadência rápida: a latência de banco antes de cada parte não alarga a pausa", () => {
  it("com 300 ms de leitura antes de cada chamada, da 2ª pausa em diante a pausa entre chamadas é a planejada (a espera descontada), e a 1ª não passa de +300 ms", async () => {
    const v = montar({ fila: funil(), latenciaPorParteMs: 300 });
    await v.rodar();
    const pausas = v.saidas.slice(1).map((x, i) => x.seg - v.saidas[i]!.seg);
    const planejado = [3, 31.5, 3, 3, 3, 31.5];
    expect(pausas[0]).toBeGreaterThanOrEqual(3);
    expect(pausas[0]).toBeLessThanOrEqual(3.3 + 0.001);
    pausas.slice(1).forEach((p, i) => expect(p).toBeCloseTo(planejado[i + 1]!, 2));
  });
});

describe("cadência rápida: quem para a sequência no meio", () => {
  it("a lead escreve: cancela o resto e nada mais sai", async () => {
    let escreveu = false;
    const v = montar({ fila: funil(), respostas: () => (escreveu ? ["quanto custa?"] : []), aoEnviar: (n) => void (escreveu = n >= 2) });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(2));
    expect(Object.values(v.estados()).filter((e) => e === "cancelado")).toHaveLength(5);
    expect(v.envios[2]!.motivo).toMatch(/escreveu/);
  });

  it("a lead pede para parar: cancela tudo com o motivo", async () => {
    let escreveu = false;
    const v = montar({ fila: funil(), respostas: () => (escreveu ? ["pare de me mandar mensagem"] : []), aoEnviar: (n) => void (escreveu = n >= 1) });
    await v.rodar();
    expect(v.saidas).toHaveLength(1);
    expect(v.envios[1]!.motivo).toMatch(/parar/);
  });

  it("contato bloqueado no meio: cancela o resto", async () => {
    const dono = lead();
    const v = montar({ fila: funil(), leads: [dono], aoEnviar: (n) => void (dono.bloqueado = n >= 2) });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(2));
    expect(Object.values(v.estados()).filter((e) => e === "cancelado")).toHaveLength(5);
  });

  it("chip pausado no meio: a sequência PARA, o resto fica pendente e o motivo fica registrado (o chip não é burlado)", async () => {
    const v = montar({ fila: funil(), aoEnviar: (n, mem) => void (n === 2 && (mem.chip.estado = "pausado")) });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(2));
    expect(v.envios.filter((e) => e.estado === "pendente").map((e) => e.id)).toEqual(["p3", "p4", "p5", "p6", "p7"]);
    expect(v.envios[2]!.motivo).toMatch(/pausado/);
  });

  it("chip com saúde vermelha no meio: para e registra o motivo", async () => {
    const v = montar({ fila: funil(), aoEnviar: (n, mem) => void (n === 3 && (mem.chip.saude = "vermelho")) });
    await v.rodar();
    expect(v.saidas).toHaveLength(3);
    expect(v.envios[3]!.estado).toBe("pendente");
    expect(v.envios[3]!.motivo).toMatch(/vermelh/);
  });

  it("falha com sinal de restrição freia o chip (vermelho por 48 h) e a sequência não continua", async () => {
    const v = montar({
      fila: funil(),
      enviar: async (p) => {
        if (p.texto === "parte 2") throw new Error("403 forbidden");
        return { externalId: "ok" };
      },
    });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(2));
    expect(v.chip.saude).toBe("vermelho");
    expect(v.estados().p3).toBe("pendente");
  });
});

describe("cadência rápida: os limites do chip continuam valendo", () => {
  it("máximo de envios por hora: para ao batê-lo e o motivo fica na parte que não saiu", async () => {
    const v = montar({ fila: funil(), ritmo: { maxEnviosHora: 3 } });
    await v.rodar();
    expect(v.saidas).toHaveLength(3);
    expect(v.estados()).toMatchObject({ p3: "enviado", p4: "pendente", p7: "pendente" });
    expect(v.envios[3]!.motivo).toMatch(/3 envios na última hora/);
  });

  it("teto do dia: para ao batê-lo, com o motivo registrado; nada fura", async () => {
    const teto = tetoTotal(5, configDoMotor(ORG, "real").ritmo, null, undefined);
    const v = montar({ fila: funil(), base: { enviosHoje: teto - 2 } });
    await v.rodar();
    expect(v.saidas).toHaveLength(2);
    expect(v.envios[2]!.estado).toBe("pendente");
    expect(v.envios[2]!.motivo).toMatch(/teto do dia/);
  });

  it("com o limite ainda batido a volta seguinte nada manda; liberado o limite, a parte sai, o motivo some e o resto segue na ordem", async () => {
    const v = montar({ fila: funil(), ritmo: { maxEnviosHora: 3 } });
    await v.rodar();
    expect(v.saidas).toHaveLength(3);
    expect(v.envios[3]!.motivo).toBeTruthy();

    v.irPara(60);
    await v.rodar();
    expect(v.saidas).toHaveLength(3); // o limite da hora ainda vale

    v.config.ritmo.maxEnviosHora = 12;
    v.irPara(120);
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(7));
    expect(v.envios[3]!.motivo ?? null).toBeNull();
    expect(Object.values(v.estados()).every((e) => e === "enviado")).toBe(true);
  });

  it("allowlist (DISPARO_SO_PARA): destino fora da lista cancela a parte e nada sai", async () => {
    const v = montar({ fila: funil(), ambiente: { DISPARO_REAL_LIBERADO: "sim", DISPARO_SO_PARA: "+5511911112222" } });
    await v.rodar();
    expect(v.enviarReal).not.toHaveBeenCalled();
    expect(v.envios[0]!.estado).toBe("cancelado");
  });

  it("parte parada há mais de 30 min continua sendo descartada (e o resto junto), não sai fora de hora", async () => {
    const v = montar({ fila: funil([-31 * 60, -31 * 60 + 3, -30 * 60 - 20]) });
    await v.rodar();
    expect(v.enviarReal).not.toHaveBeenCalled();
    expect(v.estados()).toEqual({ p1: "cancelado", p2: "cancelado", p3: "cancelado" });
  });
});

// ------------------------------------------------------------------ TODO funil, não só /funil-valores ----

/** Resposta do atendimento (origem `auto`): partes gravadas juntas (mesmo `criadoEm`), `tipo = <resposta>:seq`. */
const auto = (n: number, venceEmSeg: number, p: Partial<LinhaEnvio> = {}) =>
  parte(n, venceEmSeg, { id: `a${n}`, tipo: "tabela_valores:seq", origem: "auto", criadoEm: new Date(AGORA.getTime() - s(30)), ...p });
/** Toque do kit (origem `motor`): a 1ª parte leva o tipo, as outras `_p2`, `_p3`. */
const kit = (n: number, venceEmSeg: number, p: Partial<LinhaEnvio> = {}) =>
  parte(n, venceEmSeg, { id: `k${n}`, tipo: n === 1 ? "kit_t1_261023120000" : `kit_t1_261023120000_p${n}`, origem: "motor", ...p });

describe("cadência rápida: vale para TODO funil de partes seguidas ao mesmo lead", () => {
  const OFFS = [0, 3, 34.5]; // texto, ÁUDIO, imagem

  it("funil automático de valores (`tabela_valores:seq`, origem auto): as partes seguintes saem 3 s / 29-34 s depois, na mesma volta", async () => {
    const v = montar({ fila: OFFS.map((o, i) => auto(i + 1, o - 5)) });
    // A 1ª já venceu há 5 s: sai atrasada e as seguintes andam junto (a pausa entre elas se mantém).
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(3));
    expect(v.saidas.map((x) => x.seg)).toEqual(OFFS);
    expect(Object.values(v.estados()).every((e) => e === "enviado")).toBe(true);
  });

  it("respostas `da_parada` (pacote decidido) seguem a mesma cadência", async () => {
    const v = montar({ fila: OFFS.map((o, i) => auto(i + 1, o - 5, { daParada: true, tipo: "fechamento:seq" })) });
    await v.rodar();
    expect(v.saidas.map((x) => x.seg)).toEqual(OFFS);
  });

  it("a PRIMEIRA parte de uma resposta continua sujeita ao intervalo mínimo do chip (proteção entre leads): só as seguintes o dispensam", async () => {
    const recente = { ultimoEnvioEm: new Date(AGORA.getTime() - s(3)) };
    const v = montar({ fila: OFFS.map((o, i) => auto(i + 1, o - 5)), base: recente });
    await v.rodar();
    expect(v.enviarReal).not.toHaveBeenCalled();
    expect(v.envios[0]!.motivo ?? null).toBeNull(); // nada de "sequência parada": é o ritmo do chip, não um limite
  });

  it("a decisão SEGUINTE (criada depois, outra resposta) não é seguida no laço: espera a volta normal e o ritmo do chip", async () => {
    const outra = auto(9, 45, { id: "z1", tipo: "outra:seq", criadoEm: new Date(AGORA.getTime() + s(60)) });
    const v = montar({ fila: [...OFFS.map((o, i) => auto(i + 1, o - 5)), outra] });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(3));
    expect(v.estados().z1).toBe("pendente");
  });

  it("partes de um toque do kit (`kit_tN_…_p2`, origem motor) saem 3 s / 29-34 s depois da primeira", async () => {
    const v = montar({ fila: [kit(1, 0), kit(2, 3), kit(3, 34.5)] });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(3));
    expect(v.saidas.map((x) => x.seg)).toEqual([0, 3, 34.5]);
  });

  it("NÃO muda: outro toque (outro dia) e a abertura NÃO são seguidos, mesmo que estejam vencendo logo depois", async () => {
    const outroToque = parte(5, 8, { id: "k9", tipo: "kit_t2_261023120000", origem: "motor" });
    const toque2 = parte(6, 9, { id: "t2", tipo: "toque_2", origem: "motor" });
    const v = montar({ fila: [kit(1, 0), kit(2, 3), outroToque, toque2] });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(["parte 1", "parte 2"]);
    expect(v.estados()).toMatchObject({ k9: "pendente", t2: "pendente" });
  });

  it("toque isolado (`toque_2`) segue o ritmo do chip: com envio recente do chip ele espera", async () => {
    const toque2 = parte(1, -10, { id: "t2", tipo: "toque_2", origem: "motor" });
    const v = montar({ fila: [toque2], base: { ultimoEnvioEm: new Date(AGORA.getTime() - s(3)) } });
    await v.rodar();
    expect(v.enviarReal).not.toHaveBeenCalled();
  });

  it("os limites valem para qualquer funil: com o máximo por hora batido a resposta automática para e o motivo fica na linha", async () => {
    const v = montar({ fila: OFFS.map((o, i) => auto(i + 1, o - 5)), ritmo: { maxEnviosHora: 2 } });
    await v.rodar();
    expect(v.saidas).toHaveLength(2);
    expect(v.envios[2]!.estado).toBe("pendente");
    expect(v.envios[2]!.motivo).toMatch(/2 envios na última hora/);
  });

  it("regra nova (auditoria 3, C3): mensagem nova da lead para a resposta automática em andamento também no motor (o atendimento pode não ter lido)", async () => {
    let escreveu = false;
    const v = montar({ fila: OFFS.map((o, i) => auto(i + 1, o - 5)), respostas: () => (escreveu ? ["oi"] : []), aoEnviar: (n) => void (escreveu = n >= 1) });
    await v.rodar();
    expect(v.saidas).toHaveLength(1);
  });
});

describe("cadência rápida: tempo da volta e outras origens", () => {
  it("orçamento de tempo curto: sai o que cabe e a PRÓXIMA volta continua da parte certa, sem inverter a ordem", async () => {
    const v = montar({ fila: funil(), orcamentoSeg: 40 });
    await v.rodar();
    // Cabem as partes em 0, 3, 34,5 e 37,5 s; a de 40,5 s passa do orçamento e fica para a volta seguinte.
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(4));
    expect(v.estados()).toMatchObject({ p4: "enviado", p5: "pendente", p6: "pendente", p7: "pendente" });

    v.irPara(60); // o cron da volta seguinte
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(textos(7));
    expect(Object.values(v.estados()).every((e) => e === "enviado")).toBe(true);
  });

  it("sem o relógio da sequência nos deps (qualquer outro chamador do motor): uma parte por volta, como antes", async () => {
    const v = montar({ fila: funil([0, 3, 6]), semSequencia: true });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(["parte 1"]);
  });

  it("o intervalo mínimo de 90 s segue valendo para a primeira parte de uma resposta automática; a do operador, no mesmo estado do chip, sai", async () => {
    // O chip mandou algo há 3 s (a ALGUÉM): a `auto` espera os 90 s; a do operador sai.
    const ultimoEnvioEm = new Date(AGORA.getTime() - s(3));
    const bloqueada = montar({ fila: [auto(1, -10)], base: { ultimoEnvioEm } });
    await bloqueada.rodar();
    expect(bloqueada.enviarReal).not.toHaveBeenCalled();
    const liberada = montar({ fila: [parte(1, -10)], base: { ultimoEnvioEm } });
    await liberada.rodar();
    expect(liberada.enviarReal).toHaveBeenCalledTimes(1);
  });

  it("origem `motor` (cadência) NÃO muda: o intervalo mínimo do chip segura o toque", async () => {
    const toque = parte(1, -10, { id: "t1", tipo: "toque_2", origem: "motor" });
    const v = montar({ fila: [toque], base: { ultimoEnvioEm: new Date(AGORA.getTime() - s(3)) } });
    await v.rodar();
    expect(v.enviarReal).not.toHaveBeenCalled();
  });

  it("uma sequência do operador não toca nas linhas de outro lead", async () => {
    const outro = lead({ id: "l2" });
    const deOutro = parte(1, 5, { id: "o1", leadId: "l2" });
    const v = montar({ leads: [lead(), outro], fila: [...funil([0, 3, 6]), deOutro] });
    await v.rodar();
    expect(v.saidas.map((x) => x.texto)).toEqual(["parte 1", "parte 2", "parte 3"]);
    expect(v.estados().o1).toBe("pendente");
  });
});
