// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { bancoDuble } from "@/tests/helpers/disparo-db-double";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const CONEXAO = "44444444-4444-4444-8444-444444444444";
const CONEXAO_SEM_NOME = "45454545-4545-4545-8545-454545454545";
const CONEXAO_ARQUIVADA = "46464646-4646-4646-8646-464646464646";
const CONEXAO_DA_OUTRA = "55555555-5555-4555-8555-555555555555";
const CHIP = "66666666-6666-4666-8666-666666666666";
const CHIP_DA_OUTRA = "77777777-7777-4777-8777-777777777777";
const CHIP_VIZINHO = "88888888-8888-4888-8888-888888888888";

const conexao = (id: string, org: string, extra: Record<string, unknown> = {}) => ({
  id,
  organization_id: org,
  display_name: "Comercial",
  phone_number: "5511999990000",
  status: "WORKING",
  archived_at: null,
  ...extra,
});
const chip = (id: string, org: string, extra: Record<string, unknown> = {}) => ({
  id,
  organization_id: org,
  channel_session_id: null,
  nome: "chip",
  estado: "ativo",
  saude: "verde",
  dia_rampa: 9,
  pausado_ate: null,
  saude_motivo: null,
  ...extra,
});
const envio = (id: string, org: string, chipId: string, estado: string) => ({ id, organization_id: org, chip_id: chipId, estado, motivo: null });

let banco: ReturnType<typeof bancoDuble>;
function montar(inicial: Parameters<typeof bancoDuble>[0] = {}) {
  banco = bancoDuble({
    channel_sessions: [
      conexao(CONEXAO, ORG),
      conexao(CONEXAO_SEM_NOME, ORG, { display_name: null, phone_number: "5511888880000" }),
      conexao(CONEXAO_ARQUIVADA, ORG, { archived_at: "2026-11-01T00:00:00Z" }),
      conexao(CONEXAO_DA_OUTRA, OUTRA),
    ],
    ...inicial,
  });
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
  vi.mocked(createAdminClient).mockReturnValue(banco.cliente as never);
}

const post = (corpo: unknown) =>
  new NextRequest("http://localhost/api/v1/disparo/chips", { method: "POST", body: JSON.stringify(corpo), headers: { "content-type": "application/json" } });
const del = (id: string) => new NextRequest(`http://localhost/api/v1/disparo/chips/${id}`, { method: "DELETE" });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const chipsDaOrg = () => banco.linhas("disparo_chips").filter((c) => c.organization_id === ORG);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } } as never);
  montar();
});

describe("POST /api/v1/disparo/chips — usar uma conexão no motor", () => {
  it("registra a conexão da organização no dia 1 da rampa, saúde verde, com o apelido da conexão", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ channel_session_id: CONEXAO }));
    expect(res.status).toBe(201);
    expect(chipsDaOrg()).toHaveLength(1);
    expect(chipsDaOrg()[0]).toMatchObject({ channel_session_id: CONEXAO, nome: "Comercial", estado: "rampa", dia_rampa: 1, saude: "verde" });
    expect(vi.mocked(audit).mock.calls.at(-1)?.[0]).toMatchObject({ action: "disparo.config_atualizada", resourceType: "disparo_chips" });
  });

  it("sem apelido usa o telefone; nome repetido ganha sufixo", async () => {
    montar({ disparo_chips: [chip(CHIP_VIZINHO, ORG, { nome: "Comercial" })] });
    const { POST } = await import("./route");
    expect((await POST(post({ channel_session_id: CONEXAO }))).status).toBe(201);
    expect((await POST(post({ channel_session_id: CONEXAO_SEM_NOME }))).status).toBe(201);
    expect(chipsDaOrg().map((c) => c.nome).sort()).toEqual(["5511888880000", "Comercial", "Comercial (2)"]);
  });

  it("conexão de outra organização: 404 e nada gravado", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ channel_session_id: CONEXAO_DA_OUTRA }))).status).toBe(404);
    expect(banco.escritas).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("conexão arquivada: 422", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ channel_session_id: CONEXAO_ARQUIVADA }))).status).toBe(422);
    expect(banco.escritas).toHaveLength(0);
  });

  it("corpo sem uuid: 422", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ channel_session_id: "x" }))).status).toBe(422);
    expect((await POST(post({ channel_session_id: CONEXAO, organization_id: OUTRA }))).status).toBe(422);
  });

  it("a mesma conexão já no motor: 200 sem escrever de novo", async () => {
    montar({ disparo_chips: [chip(CHIP, ORG, { channel_session_id: CONEXAO, nome: "Comercial" })] });
    const { POST } = await import("./route");
    expect((await POST(post({ channel_session_id: CONEXAO }))).status).toBe(200);
    expect(banco.escritas).toHaveLength(0);
    expect(chipsDaOrg()[0]).toMatchObject({ estado: "ativo", dia_rampa: 9 });
  });

  it("registrar de novo a conexão de um chip retirado reativa a mesma linha no dia 1, sem soltar o freio de saúde", async () => {
    montar({
      disparo_chips: [chip(CHIP, ORG, { channel_session_id: CONEXAO, nome: "Comercial", estado: "desligado", saude: "vermelho", dia_rampa: 7, pausado_ate: "2026-11-20T00:00:00Z", saude_motivo: "chip mudo" })],
    });
    const { POST } = await import("./route");
    expect((await POST(post({ channel_session_id: CONEXAO }))).status).toBe(200);
    expect(chipsDaOrg()).toHaveLength(1);
    // Retirar e registrar de novo não é atalho para limpar a saúde: o chip vermelho continua vermelho e parado.
    expect(chipsDaOrg()[0]).toMatchObject({
      id: CHIP,
      estado: "rampa",
      dia_rampa: 1,
      saude: "vermelho",
      pausado_ate: "2026-11-20T00:00:00Z",
      saude_motivo: "chip mudo",
    });
    const escrita = banco.escritas.find((e) => e.tabela === "disparo_chips")!;
    expect(Object.keys(escrita.valores).sort()).toEqual(["dia_rampa", "estado"]);
  });
});

describe("DELETE /api/v1/disparo/chips/[id] — tirar o chip do motor", () => {
  it("desliga o chip, cancela só os pendentes dele e não apaga a conexão", async () => {
    montar({
      disparo_chips: [chip(CHIP, ORG, { channel_session_id: CONEXAO }), chip(CHIP_VIZINHO, ORG, { nome: "vizinho" })],
      disparo_envios: [
        envio("e1", ORG, CHIP, "pendente"),
        envio("e2", ORG, CHIP, "pendente"),
        envio("e3", ORG, CHIP, "enviado"),
        envio("e4", ORG, CHIP_VIZINHO, "pendente"),
      ],
    });
    const { DELETE } = await import("./[id]/route");
    const res = await DELETE(del(CHIP), params(CHIP));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { cancelados: number } }).data.cancelados).toBe(2);

    const linha = banco.linhas("disparo_chips").find((c) => c.id === CHIP);
    expect(linha).toMatchObject({ estado: "desligado", channel_session_id: CONEXAO });
    const estados = Object.fromEntries(banco.linhas("disparo_envios").map((e) => [e.id, e.estado]));
    expect(estados).toEqual({ e1: "cancelado", e2: "cancelado", e3: "enviado", e4: "pendente" });
    expect(banco.linhas("channel_sessions").find((c) => c.id === CONEXAO)).toBeDefined();
    expect(banco.escritas.some((e) => e.tabela === "channel_sessions")).toBe(false);
    expect(vi.mocked(audit).mock.calls.at(-1)?.[0]).toMatchObject({ resourceType: "disparo_chips", resourceId: CHIP });
  });

  it("chip de outra organização: 404 e nada muda", async () => {
    montar({ disparo_chips: [chip(CHIP_DA_OUTRA, OUTRA)], disparo_envios: [envio("e9", OUTRA, CHIP_DA_OUTRA, "pendente")] });
    const { DELETE } = await import("./[id]/route");
    expect((await DELETE(del(CHIP_DA_OUTRA), params(CHIP_DA_OUTRA))).status).toBe(404);
    expect(banco.escritas).toHaveLength(0);
  });

  it("id que não é uuid: 422", async () => {
    const { DELETE } = await import("./[id]/route");
    expect((await DELETE(del("abc"), params("abc"))).status).toBe(422);
  });
});

describe("PATCH /api/v1/disparo/chips/[id] — pausar e retomar", () => {
  const patch = (id: string, corpo: unknown) =>
    new NextRequest(`http://localhost/api/v1/disparo/chips/${id}`, { method: "PATCH", body: JSON.stringify(corpo), headers: { "content-type": "application/json" } });
  const AGORA = new Date("2026-11-17T13:00:00Z"); // terça, 10h em São Paulo

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AGORA);
  });
  afterEach(() => vi.useRealTimers());

  it("pausar: estado pausado, a fila do chip fica como está, audita", async () => {
    montar({ disparo_chips: [chip(CHIP, ORG, { estado: "ativo" })], disparo_envios: [envio("e1", ORG, CHIP, "pendente")] });
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(patch(CHIP, { acao: "pausar" }), params(CHIP));
    expect(res.status).toBe(200);
    expect(chipsDaOrg()[0]?.estado).toBe("pausado");
    expect(banco.linhas("disparo_envios")[0]?.estado).toBe("pendente");
    expect(banco.escritas.some((e) => e.tabela === "disparo_envios")).toBe(false);
    expect(vi.mocked(audit).mock.calls.at(-1)?.[0]).toMatchObject({
      resourceType: "disparo_chips",
      resourceId: CHIP,
      metadata: { operacao: "pausar_chip", antes: { estado: "ativo" }, depois: { estado: "pausado" } },
    });
    expect(vi.mocked(requireRole).mock.calls.at(-1)?.[0]).toBe("manager");
  });

  it("retomar: ativo a partir do dia maduro da organização, rampa antes; saúde e pausa não mudam", async () => {
    montar({
      disparo_config: [{ organization_id: ORG, ritmo: { diaMaduro: 5 } }],
      disparo_chips: [
        chip(CHIP, ORG, { estado: "pausado", dia_rampa: 5 }),
        chip(CHIP_VIZINHO, ORG, { nome: "vizinho", estado: "pausado", dia_rampa: 4 }),
      ],
    });
    const { PATCH } = await import("./[id]/route");
    const maduro = await PATCH(patch(CHIP, { acao: "retomar" }), params(CHIP));
    expect(maduro.status).toBe(200);
    expect(((await maduro.json()) as { data: { aviso: string | null } }).data.aviso).toBeNull();
    expect((await PATCH(patch(CHIP_VIZINHO, { acao: "retomar" }), params(CHIP_VIZINHO))).status).toBe(200);
    const porId = Object.fromEntries(chipsDaOrg().map((c) => [c.id, c]));
    expect(porId[CHIP]).toMatchObject({ estado: "ativo", saude: "verde", pausado_ate: null, dia_rampa: 5 });
    expect(porId[CHIP_VIZINHO]).toMatchObject({ estado: "rampa", dia_rampa: 4 });
  });

  it("retomar chip vermelho em pausa de saúde: estado volta, saúde e pausado_ate ficam, e a resposta diz até quando", async () => {
    montar({ disparo_chips: [chip(CHIP, ORG, { estado: "pausado", saude: "vermelho", dia_rampa: 2, pausado_ate: "2026-11-17T17:30:00Z" })] });
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(patch(CHIP, { acao: "retomar" }), params(CHIP));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { aviso: string; estado: string } };
    expect(data.estado).toBe("rampa");
    expect(data.aviso).toBe("Chip retomado; continua parado pela saúde até 14:30");
    expect(chipsDaOrg()[0]).toMatchObject({ estado: "rampa", saude: "vermelho", pausado_ate: "2026-11-17T17:30:00Z" });
    const escrita = banco.escritas.find((e) => e.tabela === "disparo_chips")!;
    expect(Object.keys(escrita.valores)).toEqual(["estado"]);
  });

  it("retomar chip vermelho sem prazo: avisa que só a saúde o solta", async () => {
    montar({ disparo_chips: [chip(CHIP, ORG, { estado: "pausado", saude: "vermelho", pausado_ate: null })] });
    const { PATCH } = await import("./[id]/route");
    const { data } = (await (await PATCH(patch(CHIP, { acao: "retomar" }), params(CHIP))).json()) as { data: { aviso: string } };
    expect(data.aviso).toMatch(/^Chip retomado; continua parado pela saúde/);
  });

  it("chip retirado (desligado): 409 nas duas ações, nada muda", async () => {
    montar({ disparo_chips: [chip(CHIP, ORG, { estado: "desligado" })] });
    const { PATCH } = await import("./[id]/route");
    expect((await PATCH(patch(CHIP, { acao: "retomar" }), params(CHIP))).status).toBe(409);
    expect((await PATCH(patch(CHIP, { acao: "pausar" }), params(CHIP))).status).toBe(409);
    expect(banco.escritas).toHaveLength(0);
  });

  it("retomar que corre junto com um retirar não reativa o chip retirado: 409", async () => {
    montar({ disparo_chips: [chip(CHIP, ORG, { estado: "pausado" })] });
    // A leitura vê o chip pausado; entre a leitura e o UPDATE, um DELETE concorrente o desliga.
    const original = banco.cliente.from;
    let leituras = 0;
    banco.cliente.from = (tabela: string) => {
      if (tabela === "disparo_chips" && ++leituras === 2) banco.linhas("disparo_chips")[0]!.estado = "desligado";
      return original(tabela);
    };
    const { PATCH } = await import("./[id]/route");
    expect((await PATCH(patch(CHIP, { acao: "retomar" }), params(CHIP))).status).toBe(409);
    expect(chipsDaOrg()[0]?.estado).toBe("desligado");
    expect(audit).not.toHaveBeenCalled();
  });

  it("chip de outra organização: 404; ação desconhecida: 422; repetir a ação: 200 sem escrever", async () => {
    montar({ disparo_chips: [chip(CHIP_DA_OUTRA, OUTRA, { estado: "ativo" }), chip(CHIP, ORG, { estado: "pausado" })] });
    const { PATCH } = await import("./[id]/route");
    expect((await PATCH(patch(CHIP_DA_OUTRA, { acao: "pausar" }), params(CHIP_DA_OUTRA))).status).toBe(404);
    expect((await PATCH(patch(CHIP, { acao: "desligar" }), params(CHIP))).status).toBe(422);
    expect((await PATCH(patch(CHIP, { acao: "pausar", organization_id: OUTRA }), params(CHIP))).status).toBe(422);
    expect((await PATCH(patch(CHIP, { acao: "pausar" }), params(CHIP))).status).toBe(200);
    expect(banco.escritas).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });
});
