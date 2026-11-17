/**
 * Envio de MÍDIA pelo motor (etapa 2): uma resposta do atendimento com texto,
 * áudio e imagem sai pelo canal na ORDEM da sequência, com a pausa planejada
 * entre as partes, e só com a trava dupla aberta.
 *
 * O caminho é o de produção inteiro menos a rede: `rodarDisparo` (motor) →
 * `criarEnvioReal` (o único caminho até o canal) → `getAdapter` do seam de
 * `lib/channels`, aqui MOCKADO (nenhum canal de verdade é chamado). O banco do
 * `criarEnvioReal` é um falso que registra cada tabela consultada e cada URL
 * assinada: sem a trava, a prova é que ele NÃO foi tocado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, OutboundEnvelope } from "@/lib/channels";

import { montarPartes } from "./atendimento/pecas";
import { RITMO_PADRAO, type ConfigDisparo } from "./config";
import { criarEnvioReal } from "./envio-real";
import { ESTADOS_SAIDOS, type Chip, type Contagem } from "./fila";
import { rodarDisparo, type EnvioDaFila, type LeadDoDisparo, type RepositorioDisparo } from "./motor";
import { SEM_AVISO, SEM_HUMANO_NEM_AVISOS } from "./apoio-do-motor-teste";
import { origensPorDecisao } from "./repositorio-supabase";

const enviados: { envelope: OutboundEnvelope; em: Date }[] = [];
const relogio = { agora: new Date(0) };
let falhasAntes = 0;

const adapterEspiao = {
  resolveRecipient: vi.fn((r: { phoneNumber: string | null }) => r.phoneNumber),
  send: vi.fn(async (envelope: OutboundEnvelope) => {
    if (falhasAntes > 0) {
      falhasAntes--;
      throw new Error("canal_ocupado: instância ocupada");
    }
    enviados.push({ envelope, em: relogio.agora });
    return { externalId: `wamid-${enviados.length}` };
  }),
} as unknown as ChannelAdapter;
const getAdapter = vi.fn(() => adapterEspiao);

// O seam inteiro é falso: o motor não sabe (nem este teste precisa saber) qual provider está atrás do chip.
const PROVIDER = "canal-do-chip-ficticio";
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider, ref",
  resolveSessionRef: (s: { ref: string }) => s.ref,
  getAdapter: (p: string) => (getAdapter as (p: string) => ChannelAdapter)(p),
}));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OUTRA = "00000000-0000-4000-8000-0000000000b2";
const T0 = new Date("2026-10-07T10:00:00-03:00"); // quarta
const AUDIO = "11111111-1111-4111-8111-111111111111";
const IMAGEM = "22222222-2222-4222-8222-222222222222";
const DE_OUTRA = "33333333-3333-4333-8333-333333333333";

/** Banco falso do `criarEnvioReal`: registra o que foi consultado e assinado. */
function bancoFalso() {
  const tabelas: Record<string, Record<string, unknown>[]> = {
    disparo_chips: [{ organization_id: ORG, id: "chip-1", channel_session_id: "sessao-1" }],
    channel_sessions: [{ organization_id: ORG, id: "sessao-1", provider: PROVIDER, ref: "x1-chip-ficticio", archived_at: null }],
    media_library: [
      { organization_id: ORG, id: AUDIO, kind: "audio", name: "AUDIO VALORES PT1.opus", mime: "audio/ogg", storage_path: `${ORG}/biblioteca/pt1.opus` },
      { organization_id: ORG, id: IMAGEM, kind: "image", name: "tabela.jpg", mime: "image/jpeg", storage_path: `${ORG}/biblioteca/tabela.jpg` },
      // Linha da org certa apontando para o arquivo de OUTRA org: a posse é o prefixo.
      { organization_id: ORG, id: DE_OUTRA, kind: "image", name: "intrusa.jpg", mime: "image/jpeg", storage_path: `${OUTRA}/biblioteca/x.jpg` },
    ],
  };
  const consultas: string[] = [];
  const assinadas: string[] = [];
  const from = (t: string) => {
    consultas.push(t);
    const filtros: [string, unknown][] = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      maybeSingle: async () => ({ data: (tabelas[t] ?? []).find((r) => filtros.every(([c, v]) => r[c] === v)) ?? null, error: null }),
    };
    return q;
  };
  const storage = {
    from: (bucket: string) => ({
      createSignedUrl: async (caminho: string) => {
        assinadas.push(`${bucket}:${caminho}`);
        return { data: { signedUrl: `https://storage.local/object/sign/${bucket}/${caminho}?token=t` }, error: null };
      },
    }),
  };
  return { db: { from, storage } as unknown as SupabaseClient, consultas, assinadas };
}

function config(modo: "simulado" | "real"): ConfigDisparo {
  return {
    organizationId: ORG, ligado: true, modo, tetoDiario: null, cadencia: "reativacao_3_toques",
    fonteStageId: null, // só a fila: nenhuma abertura nesta prova
    ritmo: { ...RITMO_PADRAO, feriados: [] },
    modelos: {}, proibidos: [], slots: { fixos: {}, semNomeQuando: [] }, escolha: [],
  };
}

const LEAD: LeadDoDisparo = {
  id: "lead-1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {},
};

/** A resposta como o atendimento a monta: texto, áudio do produto, tabela com legenda. */
function partesDaResposta() {
  const m = montarPartes(
    [
      { texto: "Vou te explicar sobre os preços{virg_nome} 👇", midia: null },
      { texto: "", midia: { id: AUDIO, nome: "AUDIO VALORES PT1.opus", segundos: 64 } },
      { texto: "Tabela de valores 👇", midia: { id: IMAGEM, nome: "tabela.jpg" } },
    ],
    { lead: LEAD, agora: T0, fusoMinutos: -180, proibidos: [] },
  );
  if (!m.ok) throw new Error(m.motivo);
  return m.partes;
}

type Linha = EnvioDaFila & { motivo?: string | null; enviadoEm?: Date | null };

/** Repositório em memória com a fila já preenchida pelo atendimento (estado pendente: trava aberta na hora da decisão). */
function repoComResposta(cfg: ConfigDisparo) {
  const envios: Linha[] = [];
  let quando = T0.getTime() + 40_000;
  for (const [i, p] of partesDaResposta().entries()) {
    quando += p.aposSeg * 1000;
    envios.push({
      id: `parte-${i + 1}`, leadId: LEAD.id, chipId: "chip-1", tipo: "tabela_valores:seq", origem: "auto", texto: p.texto,
      midia: p.midia?.nome ?? null, midiaId: p.midia?.id ?? null, enviarApos: new Date(quando), estado: "pendente",
      tentativas: 0, criadoEm: T0, daParada: false,
    });
  }
  const chip: Chip = {
    id: "chip-1", estado: "ativo", saude: "verde", diaRampa: 5, proximoEnvioEm: new Date(T0.getTime() - 60_000),
    pausadoAte: null, enviosDesdePausa: 0, pausaACada: 15,
  };
  const saidos = () => envios.filter((e) => (ESTADOS_SAIDOS as readonly string[]).includes(e.estado) && e.enviadoEm);
  const repo: RepositorioDisparo = {
    ...SEM_HUMANO_NEM_AVISOS,
    configsLigadas: async () => [cfg],
    chipsDaVolta: async () => [chip],
    contagem: async (_o, _c, agora): Promise<Contagem> => {
      const s = saidos();
      const ultimo = s.map((e) => e.enviadoEm!.getTime()).sort((a, b) => b - a)[0];
      return {
        ultimoEnvioEm: ultimo ? new Date(ultimo) : null, ultimaNovaEm: null, enviosHoje: s.length, aberturasHoje: 0,
        enviosUltimaHora: s.filter((e) => agora.getTime() - e.enviadoEm!.getTime() < 3_600_000).length, aberturasUltimaHora: 0,
      };
    },
    mandouDesde: async () => true,
    atualizarChip: async (_o, _c, patch) => (Object.assign(chip, patch), true),
    proximoLeadParaAbertura: async () => null,
    enfileirar: async () => null,
    vencidos: async (_o, chipId, agora, limite) =>
      envios
        .filter((e) => e.chipId === chipId && e.estado === "pendente" && e.enviarApos <= agora)
        .sort((a, b) => a.enviarApos.getTime() - b.enviarApos.getTime())
        .slice(0, limite),
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
      if (fim.tentativas !== undefined) e.tentativas = fim.tentativas;
      if (fim.enviarApos !== undefined) e.enviarApos = fim.enviarApos;
    },
    lead: async () => LEAD,
    respostasDesde: async () => [],
    origensRecentes: async (_o, _l, limite, envio) =>
      origensPorDecisao(
        saidos().sort((a, b) => b.enviadoEm!.getTime() - a.enviadoEm!.getTime()).map((e) => ({ id: e.id, origem: e.origem, criadoEm: e.criadoEm })),
        envio,
      ).slice(0, limite),
    cancelarPendentesDoLead: async (_o, leadId, motivo) => {
      const alvo = envios.filter((e) => e.leadId === leadId && e.estado === "pendente");
      for (const e of alvo) Object.assign(e, { estado: "cancelado", motivo });
      return alvo.length;
    },
    autoEmAbertoAntes: async (_o, leadId, id, antesDe) =>
      envios.some((e) => e.leadId === leadId && e.origem === "auto" && e.id !== id && (e.estado === "enviando" || (e.estado === "pendente" && e.enviarApos < antesDe))),
    adiarAutoDoLead: async (_o, leadId, depoisDe, ms) => {
      const alvo = envios.filter((e) => e.leadId === leadId && e.origem === "auto" && e.estado === "pendente" && e.enviarApos > depoisDe);
      for (const e of alvo) e.enviarApos = new Date(e.enviarApos.getTime() + ms);
      return alvo.length;
    },
    criadosDesde: async () => 0,
    saiuEm: async () => null,
    lembretesNoDia: async () => 0,
    criarTarefa: async () => "tarefa-1",
  };
  return { repo, envios };
}

/** Roda o cron a cada minuto por `minutos`, como o scheduler faz. */
async function rodarMinutos(modo: "simulado" | "real", ambiente: Record<string, string | undefined>, minutos: number) {
  const banco = bancoFalso();
  const { repo, envios } = repoComResposta(config(modo));
  const enviarReal = vi.fn(criarEnvioReal(banco.db, ambiente));
  for (let m = 0; m <= minutos; m++) {
    relogio.agora = new Date(T0.getTime() + m * 60_000);
    await rodarDisparo({ repo, agora: relogio.agora, ambiente, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  }
  return { banco, envios, enviarReal };
}

beforeEach(() => {
  enviados.length = 0;
  falhasAntes = 0;
  vi.mocked(adapterEspiao.send).mockClear();
  getAdapter.mockClear();
});

describe("mídia no envio real: trava dupla", () => {
  it.each([
    ["simulado", {}],
    ["simulado", { DISPARO_REAL_LIBERADO: "sim" }],
    ["real", {}],
    ["real", { DISPARO_REAL_LIBERADO: "SIM" }],
  ] as const)("modo %s com %j: nenhuma parte (texto, áudio, imagem) chega ao canal", async (modo, ambiente) => {
    const { banco, envios, enviarReal } = await rodarMinutos(modo, ambiente, 10);
    expect(enviarReal).not.toHaveBeenCalled();
    expect(getAdapter).not.toHaveBeenCalled();
    expect(adapterEspiao.send).not.toHaveBeenCalled();
    // Nem o banco do envio real foi consultado, nem URL assinada foi gerada.
    expect(banco.consultas).toEqual([]);
    expect(banco.assinadas).toEqual([]);
    expect(envios.map((e) => e.estado)).toEqual(["simulado", "simulado", "simulado"]);
  });

  it("chamado direto com a trava fechada, o envio real recusa antes de tocar no banco", async () => {
    const banco = bancoFalso();
    const enviar = criarEnvioReal(banco.db, { DISPARO_REAL_LIBERADO: "true" });
    await expect(enviar({ config: config("real"), chipId: "chip-1", lead: LEAD, texto: "", midiaId: AUDIO })).rejects.toThrow(/disparo_trava/);
    expect(banco.consultas).toEqual([]);
    expect(adapterEspiao.send).not.toHaveBeenCalled();
  });
});

describe("mídia no envio real: controle positivo (adapter mockado)", () => {
  it("com as DUAS chaves, texto, áudio e imagem saem nessa ordem, com a pausa planejada entre eles", async () => {
    const partes = partesDaResposta();
    const { banco, envios } = await rodarMinutos("real", { DISPARO_REAL_LIBERADO: "sim" }, 10);

    expect(getAdapter).toHaveBeenCalledWith(PROVIDER);
    expect(enviados.map((e) => e.envelope.kind)).toEqual(["text", "audio", "image"]);
    expect(envios.map((e) => e.estado)).toEqual(["enviado", "enviado", "enviado"]);

    const [texto, audio, imagem] = enviados.map((e) => e.envelope);
    expect(texto!.body).toBe("Vou te explicar sobre os preços, Maria 👇");
    expect(texto!.media).toBeUndefined();
    // Áudio: URL assinada do bucket privado, nunca base64, e sem legenda.
    expect(audio!.media).toMatchObject({ mime: "audio/ogg", caption: null });
    expect(audio!.media!.url).toMatch(/^https:\/\/storage\.local\/object\/sign\/whatsapp-media\//);
    expect(audio!.media!.url).not.toMatch(/base64|^data:/);
    // Imagem: o texto da parte vira legenda.
    expect(imagem!.media).toMatchObject({ mime: "image/jpeg", caption: "Tabela de valores 👇" });
    expect(banco.assinadas).toEqual([`whatsapp-media:${ORG}/biblioteca/pt1.opus`, `whatsapp-media:${ORG}/biblioteca/tabela.jpg`]);
    for (const e of enviados) expect(e.envelope).toMatchObject({ organizationId: ORG, sessionRef: "x1-chip-ficticio", to: LEAD.telefone });

    // Espaçamento SEM o laço do ritmo humano (este teste roda o cron minuto a minuto, sem `sequencia` nos deps):
    // nunca menos que a pausa planejada nem que o piso do ritmo (90 s). O laço está em sequencia-cadencia-rapida.test.ts.
    const gap = (a: number, b: number) => (enviados[b]!.em.getTime() - enviados[a]!.em.getTime()) / 1000;
    expect(gap(0, 1)).toBeGreaterThanOrEqual(Math.max(partes[1]!.aposSeg, RITMO_PADRAO.intervaloMinimoSeg));
    expect(gap(1, 2)).toBeGreaterThanOrEqual(Math.max(partes[2]!.aposSeg, 72));
  });

  it("parte que falha segura a sequência: o áudio não passa na frente do texto", async () => {
    falhasAntes = 1; // a 1ª tentativa do texto falha; nova tentativa em 10 min
    const { envios } = await rodarMinutos("real", { DISPARO_REAL_LIBERADO: "sim" }, 25);
    expect(enviados.map((e) => e.envelope.kind)).toEqual(["text", "audio", "image"]);
    expect(envios[0]!.tentativas).toBe(1);
    const t = enviados.map((e) => e.em.getTime());
    expect(t[1]! - t[0]!).toBeGreaterThanOrEqual(90_000);
    expect(t[2]! - t[1]!).toBeGreaterThanOrEqual(72_000);
  });

  it("arquivo fora da biblioteca da organização não sai (e nada é assinado)", async () => {
    const banco = bancoFalso();
    const enviar = criarEnvioReal(banco.db, { DISPARO_REAL_LIBERADO: "sim" });
    await expect(enviar({ config: config("real"), chipId: "chip-1", lead: LEAD, texto: "", midiaId: DE_OUTRA })).rejects.toThrow(
      /disparo_midia_indisponivel/,
    );
    await expect(enviar({ config: config("real"), chipId: "chip-1", lead: LEAD, texto: "legenda", midiaId: AUDIO })).rejects.toThrow(
      /disparo_audio_com_texto/,
    );
    expect(banco.assinadas).toEqual([]);
    expect(adapterEspiao.send).not.toHaveBeenCalled();
  });
});

describe("limite de automáticas seguidas é por decisão, não por parte", () => {
  const em = (s: number) => new Date(T0.getTime() + s * 1000);
  it("as 7 partes do funil de valores contam uma vez", () => {
    const funil = Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, origem: "auto", criadoEm: em(600 + i * 0.01) }));
    const anterior = { id: "a1", origem: "auto", criadoEm: em(0) };
    const abertura = { id: "m1", origem: "motor", criadoEm: em(-86_400) };
    expect(origensPorDecisao([...funil, anterior, abertura], { id: "novo", criadoEm: em(1200) })).toEqual(["auto", "auto", "motor"]);
  });
  it("a parte seguinte da MESMA decisão não conta as irmãs já saídas", () => {
    const irmas = [{ id: "p2", origem: "auto", criadoEm: em(0.02) }, { id: "p1", origem: "auto", criadoEm: em(0) }];
    expect(origensPorDecisao(irmas, { id: "p3", criadoEm: em(0.03) })).toEqual([]);
  });
  it("áudio com texto vira duas partes: o áudio primeiro, o texto 29-34 s depois (ritmo humano; sorteio fixo em 0,5 = 31,5 s)", () => {
    const m = montarPartes([{ texto: "Ouviu?", midia: { id: AUDIO, nome: "x.ogg", segundos: 20 } }], {
      lead: LEAD, agora: T0, fusoMinutos: -180, proibidos: [], sortear: () => 0.5,
    });
    expect(m.ok && m.partes.map((p) => [p.midia?.nome ?? null, p.texto, p.aposSeg])).toEqual([["x.ogg", "", 0], [null, "Ouviu?", 31.5]]);
  });
});
