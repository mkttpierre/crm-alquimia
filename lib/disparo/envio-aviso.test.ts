/**
 * O aviso ao celular do operador passa pelo MESMO caminho do envio real
 * (`enviarPeloChip`) e pelas mesmas travas, e só sai pela instância do chip em que
 * a lead conversa. O banco é um falso que registra o que foi consultado; o canal é
 * um espião (nenhum canal de verdade é chamado).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, OutboundEnvelope } from "@/lib/channels";

import { RITMO_PADRAO, type ConfigDisparo } from "./config";
import { criarEnvioDeAviso } from "./envio-real";

const enviados: OutboundEnvelope[] = [];
const adapterEspiao = {
  resolveRecipient: vi.fn((r: { phoneNumber: string | null }) => (r.phoneNumber ? r.phoneNumber.replace(/\D/g, "") : null)),
  send: vi.fn(async (envelope: OutboundEnvelope) => {
    enviados.push(envelope);
    return { externalId: "wamid-aviso" };
  }),
} as unknown as ChannelAdapter;

const PROVIDER = "canal-do-chip-ficticio";
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider, ref",
  resolveSessionRef: (s: { ref: string }) => s.ref,
  getAdapter: () => adapterEspiao,
}));

const ORG = "00000000-0000-4000-8000-0000000000e1";
const OPERADOR = "5511900000002";

function bancoFalso() {
  const tabelas: Record<string, Record<string, unknown>[]> = {
    disparo_chips: [
      { organization_id: ORG, id: "chip-a", channel_session_id: "sessao-a" },
      { organization_id: ORG, id: "chip-b", channel_session_id: "sessao-b" },
    ],
    channel_sessions: [
      { organization_id: ORG, id: "sessao-a", provider: PROVIDER, ref: "instancia-chip-a", archived_at: null },
      { organization_id: ORG, id: "sessao-b", provider: PROVIDER, ref: "instancia-chip-b", archived_at: null },
    ],
  };
  const consultas: string[] = [];
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
  return { db: { from } as unknown as SupabaseClient, consultas };
}

const config = (modo: "simulado" | "real"): ConfigDisparo => ({
  organizationId: ORG, ligado: true, modo, tetoDiario: null, cadencia: "reativacao_3_toques", fonteStageId: null,
  ritmo: { ...RITMO_PADRAO, feriados: [] }, modelos: {}, proibidos: [], slots: { fixos: {}, semNomeQuando: [] }, escolha: [],
});
const LIBERADO = { DISPARO_REAL_LIBERADO: "sim" };
const pedido = (p: Partial<{ chipId: string; canalId: string | null }> = {}) => ({
  chipId: "chip-a", canalId: "sessao-a", destino: OPERADOR, texto: "Respondeu KIT ESCOLHIDO", ...p,
});

beforeEach(() => {
  enviados.length = 0;
  vi.mocked(adapterEspiao.send).mockClear();
});

describe("criarEnvioDeAviso: as travas do envio real", () => {
  it.each([
    ["modo simulado, variável liberada", config("simulado"), LIBERADO],
    ["modo real, variável ausente", config("real"), {}],
    ["modo real, variável 'true'", config("real"), { DISPARO_REAL_LIBERADO: "true" }],
  ])("%s: lança antes de tocar no banco ou no canal", async (_n, cfg, ambiente) => {
    const banco = bancoFalso();
    await expect(criarEnvioDeAviso(banco.db, ambiente)({ config: cfg, ...pedido() })).rejects.toThrow(/disparo_trava/);
    expect(banco.consultas).toEqual([]);
    expect(adapterEspiao.send).not.toHaveBeenCalled();
  });

  it("allowlist: o número do operador fora da lista é recusado", async () => {
    const banco = bancoFalso();
    const envia = criarEnvioDeAviso(banco.db, { ...LIBERADO, DISPARO_SO_PARA: "+5511999990000" });
    await expect(envia({ config: config("real"), ...pedido() })).rejects.toThrow(/bloqueado_por_allowlist/);
    expect(adapterEspiao.send).not.toHaveBeenCalled();
  });
});

describe("criarEnvioDeAviso: pelo chip da conversa", () => {
  it("controle positivo: sai como texto, para o número do operador, pela instância do chip A", async () => {
    const banco = bancoFalso();
    const r = await criarEnvioDeAviso(banco.db, LIBERADO)({ config: config("real"), ...pedido() });
    expect(r.externalId).toBe("wamid-aviso");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatchObject({ organizationId: ORG, sessionRef: "instancia-chip-a", to: OPERADOR, kind: "text", body: "Respondeu KIT ESCOLHIDO" });
  });

  it("o chip B avisa pela instância do B: cada chip leva o aviso das suas conversas", async () => {
    const banco = bancoFalso();
    await criarEnvioDeAviso(banco.db, LIBERADO)({ config: config("real"), ...pedido({ chipId: "chip-b", canalId: "sessao-b" }) });
    expect(enviados[0]).toMatchObject({ sessionRef: "instancia-chip-b" });
  });

  it("chip ligado a OUTRA sessão que a da conversa de origem: recusa, nunca sai por outro chip", async () => {
    const banco = bancoFalso();
    await expect(criarEnvioDeAviso(banco.db, LIBERADO)({ config: config("real"), ...pedido({ chipId: "chip-b", canalId: "sessao-a" }) })).rejects.toThrow(/disparo_aviso_outro_chip/);
    expect(adapterEspiao.send).not.toHaveBeenCalled();
  });

  it("chip de outra organização não é encontrado (a consulta filtra a organização)", async () => {
    const banco = bancoFalso();
    const outra = { ...config("real"), organizationId: "00000000-0000-4000-8000-0000000000ff" };
    await expect(criarEnvioDeAviso(banco.db, LIBERADO)({ config: outra, ...pedido() })).rejects.toThrow(/disparo_chip_sem_canal/);
    expect(adapterEspiao.send).not.toHaveBeenCalled();
  });
});
