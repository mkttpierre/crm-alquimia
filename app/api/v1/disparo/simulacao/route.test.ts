// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { bancoDuble } from "@/tests/helpers/disparo-db-double";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";

type Resposta = {
  data: {
    perfil: string;
    perfil_atual: string;
    porChip: { nome: string; envios: string[]; diaRampa: number; parado: string | null }[];
    totalNovas: number;
  };
};

let banco: ReturnType<typeof bancoDuble>;

beforeEach(() => {
  vi.clearAllMocks();
  // Terça 17/11/2026, 7h em São Paulo: o dia inteiro pela frente.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } } as never);
  banco = bancoDuble({
    disparo_config: [
      { organization_id: ORG, ritmo: { rampa: [3, 4] }, teto_diario: null },
      { organization_id: OUTRA, ritmo: { rampa: [30] }, teto_diario: null },
    ],
    disparo_chips: [
      { id: "c1", organization_id: ORG, nome: "ativo", estado: "ativo", saude: "verde", dia_rampa: 5, pausado_ate: null, proximo_envio_em: null },
      // Em rampa, dia de ontem ainda aberto e mandou anteontem: o motor sobe para o dia 2 ao abrir hoje.
      { id: "c2", organization_id: ORG, nome: "rampa", estado: "rampa", saude: "verde", dia_rampa: 1, pausado_ate: null, proximo_envio_em: "2026-11-16T20:00:00.000Z" },
      { id: "c3", organization_id: ORG, nome: "desligado", estado: "desligado", saude: "verde", dia_rampa: 5, pausado_ate: null, proximo_envio_em: null },
      { id: "c4", organization_id: ORG, nome: "pausado", estado: "pausado", saude: "verde", dia_rampa: 5, pausado_ate: null, proximo_envio_em: null },
      { id: "c6", organization_id: ORG, nome: "vermelho", estado: "ativo", saude: "vermelho", dia_rampa: 5, pausado_ate: "2026-11-18T10:00:00.000Z", proximo_envio_em: null },
      { id: "c5", organization_id: OUTRA, nome: "da outra", estado: "ativo", saude: "verde", dia_rampa: 5, pausado_ate: null, proximo_envio_em: null },
    ],
    disparo_envios: [
      { id: "e1", organization_id: ORG, chip_id: "c2", estado: "simulado", enviado_em: "2026-11-15T13:00:00.000Z" },
      // Da outra organização, no MESMO id de chip: não pode contar como "mandou recente".
      { id: "e2", organization_id: OUTRA, chip_id: "c1", estado: "enviado", enviado_em: "2026-11-15T13:00:00.000Z" },
    ],
  });
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
});
afterEach(() => vi.useRealTimers());

const get = (q = "") => new NextRequest(`http://localhost/api/v1/disparo/simulacao${q}`);

describe("GET /api/v1/disparo/simulacao", () => {
  it("simula o dia de hoje para os chips da organização, com o ritmo dela; parados aparecem com o motivo", async () => {
    const { GET } = await import("./route");
    const res = await GET(get());
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Resposta;
    const porNome = Object.fromEntries(data.porChip.map((c) => [c.nome, c]));
    expect(Object.keys(porNome).sort()).toEqual(["ativo", "desligado", "pausado", "rampa", "vermelho"]);
    // Rampa da organização [3, 4]; a da outra organização (30) não vaza.
    expect(porNome.ativo).toMatchObject({ diaRampa: 5, parado: null });
    expect(porNome.ativo!.envios).toHaveLength(4);
    expect(porNome.rampa).toMatchObject({ diaRampa: 2, parado: null });
    expect(porNome.rampa!.envios).toHaveLength(4);
    expect(porNome.desligado).toMatchObject({ envios: [], parado: "chip desligado" });
    expect(porNome.pausado).toMatchObject({ envios: [], parado: "chip pausado" });
    expect(porNome.vermelho).toMatchObject({ envios: [], parado: "saúde vermelha: parado" });
    expect(data.totalNovas).toBe(8);
    expect((data as unknown as { janela: unknown }).janela).toEqual([{ inicio: 480, fim: 1140 }]); // terça: 8h às 19h
    expect(data.perfil_atual).toBe("personalizado");
    expect(banco.escritas).toHaveLength(0);
  });

  it("?perfil= pré-visualiza sem salvar", async () => {
    const { GET } = await import("./route");
    const { data } = (await (await GET(get("?perfil=conservador"))).json()) as Resposta;
    expect(data.perfil).toBe("conservador");
    // Conservador: 8 no dia 2 (o chip em rampa sobe hoje) e 14 no dia 5.
    const porNome = Object.fromEntries(data.porChip.map((c) => [c.nome, c.envios.length]));
    expect(porNome.rampa).toBeLessThanOrEqual(8);
    expect(porNome.rampa).toBeGreaterThan(4);
    expect(porNome.ativo).toBeLessThanOrEqual(14);
    expect(porNome.ativo).toBeGreaterThan(3);
    expect(banco.escritas).toHaveLength(0);
    expect(banco.linhas("disparo_config")[0]?.ritmo).toEqual({ rampa: [3, 4] });
  });

  it("perfil desconhecido: 422", async () => {
    const { GET } = await import("./route");
    expect((await GET(get("?perfil=turbo"))).status).toBe(422);
  });

  it("nega abaixo de manager", async () => {
    const { fail } = await import("@/lib/api/wrappers");
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "x", 403) } as never);
    const { GET } = await import("./route");
    expect((await GET(get())).status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
  });
});
