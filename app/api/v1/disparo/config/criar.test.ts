// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerRitmo, RITMO_PADRAO } from "@/lib/disparo/config";
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
const ETAPA_DA_ORG = "44444444-4444-4444-8444-444444444444";
const ETAPA_DA_OUTRA = "55555555-5555-4555-8555-555555555555";

const RANK = { viewer: 1, agent: 2, manager: 3, admin: 4 } as const;
type Papel = keyof typeof RANK;

/** `requireRole` de verdade no que importa aqui: nega abaixo do mínimo, com o 403 padronizado. */
function comoPapel(papel: Papel) {
  vi.mocked(requireRole).mockImplementation(async (min) =>
    RANK[papel] >= RANK[min as Papel]
      ? ({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG, role: papel } } as never)
      : ({ ok: false, response: fail("forbidden_role", "Permissão insuficiente.", 403) } as never),
  );
}

let banco: ReturnType<typeof bancoDuble>;
function montar(config: Record<string, unknown>[] = []) {
  banco = bancoDuble({
    disparo_config: config,
    crm_stages: [
      { id: ETAPA_DA_ORG, organization_id: ORG, is_archived: false },
      { id: ETAPA_DA_OUTRA, organization_id: OUTRA, is_archived: false },
    ],
  });
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
  vi.mocked(createAdminClient).mockReturnValue(banco.cliente as never);
}

const configDaOrg = (org: string, extra: Record<string, unknown> = {}) => ({
  organization_id: org,
  ligado: false,
  modo: "simulado",
  teto_diario: null,
  cadencia: "reativacao_3_toques",
  fonte_stage_id: null,
  ritmo: { intervaloNova: { min: 19, max: 23 } },
  modelos: { abertura: ["Oi {nome}"] },
  proibidos: [],
  ...extra,
});

const pedido = (metodo: "POST" | "PATCH", corpo?: unknown) =>
  new NextRequest("http://localhost/api/v1/disparo/config", {
    method: metodo,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }),
  });

const escritasEm = (tabela: string) => banco.escritas.filter((e) => e.tabela === tabela);
const ultimoAudit = () => vi.mocked(audit).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  comoPapel("manager");
  montar();
});

describe("POST /api/v1/disparo/config — criar o motor", () => {
  it("cria com o ritmo recomendado, simulado e desligado; a segunda vez devolve 200 sem escrever", async () => {
    montar([configDaOrg(OUTRA)]);
    const { POST } = await import("./route");

    const primeira = await POST(pedido("POST"));
    expect(primeira.status).toBe(201);
    const criada = banco.linhas("disparo_config").find((l) => l.organization_id === ORG);
    // Grava só o necessário: o ritmo vazio é lido como o recomendado, e o recomendado de amanhã chega sozinho.
    expect(criada).toMatchObject({ modo: "simulado", ligado: false, ritmo: {} });
    expect(JSON.stringify(criada?.ritmo)).not.toContain("feriados");
    expect(lerRitmo(criada?.ritmo)).toEqual(RITMO_PADRAO);
    expect(ultimoAudit()).toMatchObject({ action: "disparo.config_atualizada", organizationId: ORG });

    const segunda = await POST(pedido("POST"));
    expect(segunda.status).toBe(200);
    expect(((await segunda.json()) as { data: { criada: boolean } }).data.criada).toBe(false);
    expect(escritasEm("disparo_config")).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
    // A da outra organização ficou como estava.
    expect(banco.linhas("disparo_config").find((l) => l.organization_id === OUTRA)?.ritmo).toEqual({ intervaloNova: { min: 19, max: 23 } });
  });

  it("duas criações chegando juntas: a que perde a corrida devolve 200, não 500", async () => {
    const { POST } = await import("./route");
    // A primeira leitura não vê a linha; outra requisição a grava antes do INSERT desta.
    const original = banco.cliente.from;
    let primeiraLeitura = true;
    banco.cliente.from = (tabela: string) => {
      if (tabela === "disparo_config" && primeiraLeitura) {
        primeiraLeitura = false;
        banco.linhas("disparo_config").push(configDaOrg(ORG));
        const vazio = original("disparo_config").eq("organization_id", "__nenhuma__");
        return vazio;
      }
      return original(tabela);
    };
    expect((await POST(pedido("POST"))).status).toBe(200);
  });

  it("agent não cria", async () => {
    comoPapel("agent");
    const { POST } = await import("./route");
    expect((await POST(pedido("POST"))).status).toBe(403);
    expect(banco.escritas).toHaveLength(0);
  });
});

describe("PATCH /api/v1/disparo/config — o motor inteiro pela tela", () => {
  it("fonte_stage_id de outra organização: 422 e nada gravado", async () => {
    montar([configDaOrg(ORG)]);
    const { PATCH } = await import("./route");
    const res = await PATCH(pedido("PATCH", { fonte_stage_id: ETAPA_DA_OUTRA }));
    expect(res.status).toBe(422);
    expect(escritasEm("disparo_config")).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("fonte_stage_id da organização grava e audita antes e depois", async () => {
    montar([configDaOrg(ORG)]);
    const { PATCH } = await import("./route");
    expect((await PATCH(pedido("PATCH", { fonte_stage_id: ETAPA_DA_ORG }))).status).toBe(200);
    expect(banco.linhas("disparo_config")[0]?.fonte_stage_id).toBe(ETAPA_DA_ORG);
    expect(ultimoAudit()?.metadata).toMatchObject({ antes: { fonte_stage_id: null }, depois: { fonte_stage_id: ETAPA_DA_ORG } });
  });

  it("ritmo, cadência e mensagens: mescla no gravado e audita só o que mudou", async () => {
    montar([configDaOrg(ORG)]);
    const { PATCH } = await import("./route");
    const corpo = {
      cadencia: "prospeccao_14_dias",
      ritmo: { rampa: [5, 8], naoEntregue: { ligado: false } },
      modelos: { abertura: ["Oi {nome}"], d2: ["Conseguiu ver?"] },
      proibidos: [{ padrao: "frete gr[aá]tis", motivo: "promessa de frete" }],
    };
    expect((await PATCH(pedido("PATCH", corpo))).status).toBe(200);
    const linha = banco.linhas("disparo_config")[0]!;
    expect(linha.ritmo).toEqual({ intervaloNova: { min: 19, max: 23 }, rampa: [5, 8], naoEntregue: { ligado: false } });
    expect(linha.cadencia).toBe("prospeccao_14_dias");
    expect(linha.modelos).toEqual(corpo.modelos);
    const meta = ultimoAudit()?.metadata as { antes: Record<string, unknown>; depois: Record<string, unknown> };
    expect(meta.antes).toEqual({
      cadencia: "reativacao_3_toques",
      ritmo: { rampa: null, naoEntregue: null },
      modelos: { d2: null },
      proibidos: [],
    });
    expect(meta.depois.modelos).toEqual({ d2: ["Conseguiu ver?"] });
  });

  it("perfil é atalho: mescla os campos do perfil no ritmo gravado e a auditoria diz qual", async () => {
    montar([configDaOrg(ORG, { ritmo: { feriados: ["2026-12-24"], maxEnviosHora: 30 } })]);
    const { PATCH } = await import("./route");
    expect((await PATCH(pedido("PATCH", { perfil: "acelerado" }))).status).toBe(200);
    expect(banco.linhas("disparo_config")[0]?.ritmo).toMatchObject({ feriados: ["2026-12-24"], maxEnviosHora: 16, intervaloNovaPisoMin: 8 });
    expect(ultimoAudit()?.metadata).toMatchObject({ perfil: "acelerado", depois: { ritmo: { maxEnviosHora: 16 } } });
    expect((await PATCH(pedido("PATCH", { perfil: "turbo" }))).status).toBe(422);
  });

  it("modo: manager recebe 403 e nada muda; admin troca", async () => {
    montar([configDaOrg(ORG)]);
    const { PATCH } = await import("./route");
    expect((await PATCH(pedido("PATCH", { modo: "real" }))).status).toBe(403);
    expect(banco.linhas("disparo_config")[0]?.modo).toBe("simulado");
    expect(escritasEm("disparo_config")).toHaveLength(0);

    comoPapel("admin");
    expect((await PATCH(pedido("PATCH", { modo: "real" }))).status).toBe(200);
    expect(banco.linhas("disparo_config")[0]?.modo).toBe("real");
    expect(ultimoAudit()?.metadata).toMatchObject({ antes: { modo: "simulado" }, depois: { modo: "real" } });
  });

  it("422 diz o caminho de cada campo com problema, para a tela mostrar no campo", async () => {
    montar([configDaOrg(ORG)]);
    const { PATCH } = await import("./route");
    const res = await PATCH(pedido("PATCH", { ritmo: { intervaloNovaMaduro: { min: 20, max: 10 } } }));
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { details: { campos: { caminho: string }[] } } };
    expect(corpo.error.details.campos.map((c) => c.caminho)).toContain("ritmo.intervaloNovaMaduro");
  });

  it("imagem da abertura: só imagem da biblioteca da organização; vídeo ou mídia de outra organização é 422 no campo", async () => {
    const IMAGEM = "88888888-8888-4888-8888-888888888888";
    const VIDEO = "99999999-9999-4999-8999-999999999999";
    const DA_OUTRA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    montar([configDaOrg(ORG)]);
    banco.linhas("media_library").push(
      { id: IMAGEM, organization_id: ORG, mime: "image/png" },
      { id: VIDEO, organization_id: ORG, mime: "video/mp4" },
      { id: DA_OUTRA, organization_id: OUTRA, mime: "image/jpeg" },
    );
    const { PATCH } = await import("./route");
    for (const id of [VIDEO, DA_OUTRA, "nao-e-uuid"]) {
      const res = await PATCH(pedido("PATCH", { ritmo: { aberturaMidiaId: id } }));
      expect(res.status, id).toBe(422);
      const corpo = (await res.json()) as { error: { details: { campos: { caminho: string; mensagem: string }[] } } };
      expect(corpo.error.details.campos).toEqual([{ caminho: "ritmo.aberturaMidiaId", mensagem: "A abertura aceita só imagem; vídeo ainda não é enviado pelo motor." }]);
    }
    expect(escritasEm("disparo_config")).toHaveLength(0);
    expect((await PATCH(pedido("PATCH", { ritmo: { aberturaMidiaId: IMAGEM } }))).status).toBe(200);
    expect((banco.linhas("disparo_config")[0]!.ritmo as { aberturaMidiaId: string }).aberturaMidiaId).toBe(IMAGEM);
    // Tirar a imagem (null) não consulta a biblioteca.
    expect((await PATCH(pedido("PATCH", { ritmo: { aberturaMidiaId: null } }))).status).toBe(200);
  });

  it("organization_id no corpo: 422", async () => {
    montar([configDaOrg(ORG)]);
    const { PATCH } = await import("./route");
    expect((await PATCH(pedido("PATCH", { organization_id: OUTRA, ligado: true }))).status).toBe(422);
    expect(banco.escritas).toHaveLength(0);
  });

  it("só a outra organização tem motor: 404 e a dela fica intacta", async () => {
    montar([configDaOrg(OUTRA)]);
    const { PATCH } = await import("./route");
    expect((await PATCH(pedido("PATCH", { ligado: true, ritmo: { rampa: [1] } }))).status).toBe(404);
    expect(banco.escritas).toHaveLength(0);
    expect(banco.linhas("disparo_config")[0]).toMatchObject({ organization_id: OUTRA, ligado: false });
  });

  it("sem motor criado: 404", async () => {
    const { PATCH } = await import("./route");
    expect((await PATCH(pedido("PATCH", { ligado: true }))).status).toBe(404);
  });

  it("nada mudou de valor: 200, sem escrita e sem auditoria", async () => {
    montar([configDaOrg(ORG)]);
    const { PATCH } = await import("./route");
    const res = await PATCH(pedido("PATCH", { ligado: false, ritmo: { intervaloNova: { min: 19, max: 23 } } }));
    expect(res.status).toBe(200);
    expect(escritasEm("disparo_config")).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/disparo/config — o que a tela edita", () => {
  it("traz as etapas ativas da organização com o funil, e quantos leads há na etapa escolhida", async () => {
    banco = bancoDuble({
      disparo_config: [configDaOrg(ORG, { fonte_stage_id: ETAPA_DA_ORG })],
      crm_pipelines: [
        { id: "p1", organization_id: ORG, name: "Vendas", position: 1, is_archived: false },
        { id: "p9", organization_id: OUTRA, name: "Da outra", position: 1, is_archived: false },
      ],
      crm_stages: [
        { id: ETAPA_DA_ORG, organization_id: ORG, name: "Novo", pipeline_id: "p1", position: 1, is_archived: false },
        { id: "arquivada", organization_id: ORG, name: "Velha", pipeline_id: "p1", position: 2, is_archived: true },
        { id: ETAPA_DA_OUTRA, organization_id: OUTRA, name: "Dela", pipeline_id: "p9", position: 1, is_archived: false },
      ],
      crm_leads: [
        { id: "l1", organization_id: ORG, stage_id: ETAPA_DA_ORG },
        { id: "l2", organization_id: ORG, stage_id: ETAPA_DA_ORG },
        { id: "l3", organization_id: OUTRA, stage_id: ETAPA_DA_ORG },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
    const { GET } = await import("./route");
    const { data } = (await (await GET(pedido("PATCH") as never)).json()) as {
      data: { etapas: { id: string; funil: string }[]; leads_na_etapa: number; perfil: string };
    };
    expect(data.etapas).toEqual([{ id: ETAPA_DA_ORG, nome: "Novo", funil_id: "p1", funil: "Vendas" }]);
    expect(data.leads_na_etapa).toBe(2);
    expect(data.perfil).toBe("personalizado");
    expect((data as unknown as { etapa_arquivada: unknown }).etapa_arquivada).toBeNull();
  });

  it("a etapa escolhida que foi arquivada volta com o nome, para a tela mostrar desabilitada", async () => {
    banco = bancoDuble({
      disparo_config: [configDaOrg(ORG, { fonte_stage_id: "arquivada" })],
      crm_pipelines: [{ id: "p1", organization_id: ORG, name: "Vendas", position: 1, is_archived: false }],
      crm_stages: [{ id: "arquivada", organization_id: ORG, name: "Velha", pipeline_id: "p1", position: 2, is_archived: true }],
      crm_leads: [],
    });
    vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
    const { GET } = await import("./route");
    const { data } = (await (await GET(pedido("PATCH") as never)).json()) as { data: { etapas: unknown[]; etapa_arquivada: unknown } };
    expect(data.etapas).toEqual([]);
    expect(data.etapa_arquivada).toEqual({ id: "arquivada", nome: "Velha" });
  });
});
