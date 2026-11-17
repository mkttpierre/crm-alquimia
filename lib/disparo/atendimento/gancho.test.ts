// @vitest-environment node
/**
 * Gancho do webhook (M4 da auditoria 3): erro de consulta não pode sumir sem rastro, e um erro numa mensagem não
 * pode cortar o laço das seguintes do mesmo lote. O webhook segue devolvendo 200 (o gancho nunca lança).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { atenderMensagem, logger } = vi.hoisted(() => ({
  atenderMensagem: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger }));
vi.mock("@/lib/env", () => ({ env: { DISPARO_REAL_LIBERADO: undefined, OPENROUTER_API_KEY: undefined, JEV_MODELO: undefined } }));
vi.mock("./atendimento", () => ({ atenderMensagem }));
vi.mock("./jev", () => ({ criarJulgar: () => async () => null }));
vi.mock("./repositorio-supabase", () => ({ repositorioAtendimentoSupabase: () => ({}) }));

import { atenderEntradas } from "./gancho";

const ORG = "00000000-0000-4000-8000-0000000000c1";
type Resp = { data: unknown; error: { message: string } | null };

/** Cliente falso: cada consulta termina em `maybeSingle` e devolve o que `respostas[tabela]` entregar (uma por chamada). */
function adminFalso(respostas: Record<string, Resp[]>) {
  const chamadas: Record<string, number> = {};
  const builder = (tabela: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
    b.maybeSingle = async () => {
      const i = (chamadas[tabela] = (chamadas[tabela] ?? 0) + 1) - 1;
      const fila = respostas[tabela] ?? [];
      return fila[Math.min(i, fila.length - 1)] ?? { data: null, error: null };
    };
    return b;
  };
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const envelope = (id: string) => ({ event: "message", payload: { id, fromMe: false } });
const ok = (data: unknown): Resp => ({ data, error: null });
const erro = (message: string): Resp => ({ data: null, error: { message } });
const ligado = ok({ atendimento: { ligado: true } });
const msg = (id: string) => ok({ id, contact_id: `c-${id}`, conversation_id: "conv-1", body: "oi" });

beforeEach(() => {
  vi.clearAllMocks();
  atenderMensagem.mockResolvedValue({ resultado: "decidida" });
});

describe("gancho do webhook: erro de consulta deixa rastro e não corta o lote", () => {
  it("erro ao buscar a mensagem: loga com organização, id externo e etapa, e segue para a próxima", async () => {
    const admin = adminFalso({
      disparo_config: [ligado],
      messages: [erro("canceling statement due to statement timeout"), msg("m2")],
      crm_leads: [ok({ id: "lead-2" })],
    });
    const n = await atenderEntradas(admin, ORG, [envelope("ext-1"), envelope("ext-2")]);
    expect(n).toBe(1);
    expect(atenderMensagem).toHaveBeenCalledTimes(1);
    const logado = [...logger.error.mock.calls, ...logger.warn.mock.calls];
    expect(logado).toHaveLength(1);
    expect(logado[0]![1]).toMatchObject({ organization_id: ORG, external_id: "ext-1", etapa: "messages" });
    expect(String(logado[0]![1].detail)).toContain("statement timeout");
  });

  it("erro ao buscar o lead: loga com a etapa e segue para a próxima", async () => {
    const admin = adminFalso({
      disparo_config: [ligado],
      messages: [msg("m1"), msg("m2")],
      crm_leads: [erro("connection reset"), ok({ id: "lead-2" })],
    });
    const n = await atenderEntradas(admin, ORG, [envelope("ext-1"), envelope("ext-2")]);
    expect(n).toBe(1);
    const logado = [...logger.error.mock.calls, ...logger.warn.mock.calls];
    expect(logado).toHaveLength(1);
    expect(logado[0]![1]).toMatchObject({ organization_id: ORG, external_id: "ext-1", etapa: "crm_leads" });
  });

  it("o atendimento lançar numa mensagem não corta as seguintes do lote", async () => {
    atenderMensagem.mockRejectedValueOnce(new Error("falha do repositório"));
    const admin = adminFalso({ disparo_config: [ligado], messages: [msg("m1"), msg("m2")], crm_leads: [ok({ id: "lead-1" })] });
    const n = await atenderEntradas(admin, ORG, [envelope("ext-1"), envelope("ext-2")]);
    expect(atenderMensagem).toHaveBeenCalledTimes(2);
    expect(n).toBe(1);
    const logado = [...logger.error.mock.calls, ...logger.warn.mock.calls];
    expect(logado[0]![1]).toMatchObject({ organization_id: ORG, external_id: "ext-1", etapa: "atendimento" });
  });

  it("erro ao ler a config: loga (antes sumia) e devolve 0 sem lançar", async () => {
    const admin = adminFalso({ disparo_config: [erro("permission denied")] });
    await expect(atenderEntradas(admin, ORG, [envelope("ext-1")])).resolves.toBe(0);
    const logado = [...logger.error.mock.calls, ...logger.warn.mock.calls];
    expect(logado).toHaveLength(1);
    expect(logado[0]![1]).toMatchObject({ organization_id: ORG, etapa: "disparo_config" });
    expect(atenderMensagem).not.toHaveBeenCalled();
  });

  it("irmão: sem erro nenhum, nada é logado e as duas mensagens são atendidas", async () => {
    const admin = adminFalso({ disparo_config: [ligado], messages: [msg("m1"), msg("m2")], crm_leads: [ok({ id: "lead-1" })] });
    const n = await atenderEntradas(admin, ORG, [envelope("ext-1"), envelope("ext-2")]);
    expect(n).toBe(2);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("mensagem sem contato ou lead aberto não é erro: segue sem log", async () => {
    const admin = adminFalso({ disparo_config: [ligado], messages: [ok(null)] });
    expect(await atenderEntradas(admin, ORG, [envelope("ext-1")])).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
