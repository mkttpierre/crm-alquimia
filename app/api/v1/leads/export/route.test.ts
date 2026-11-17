// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { BOM } from "@/lib/exportacao/csv";
import { idsDeContatosNoIntervalo } from "@/lib/exportacao/intervalo-de-compra";
import { logger } from "@/lib/logger";
import { LimiteDeLeituraExcedido } from "@/lib/negocio/limite-de-leitura";
import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { bancoFalso, type Linha } from "@/tests/helpers/postgrest-falso";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/exportacao/intervalo-de-compra", () => ({ idsDeContatosNoIntervalo: vi.fn() }));
vi.mock("@/lib/negocio/nomes-dos-atendentes", () => ({
  nomesDosAtendentes: vi.fn(async () => new Map<string, string | null>()),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const OUTRO_FUNIL = "55555555-5555-4555-8555-555555555555";

const CONTATO = { display_name: "Maria", name: null, phone_number: "+5511999990001", tags: ["vip"], is_anonymized: false };

function tabelas(leads: Linha[]): Record<string, Linha[]> {
  return {
    crm_pipelines: [{ id: FUNIL, organization_id: ORG_ID, name: "Vendas" }],
    crm_stages: [{ id: "e1", organization_id: ORG_ID, pipeline_id: FUNIL, name: "Novo" }],
    ai_agents: [],
    crm_leads: leads,
  };
}

function lead(n: number, extra: Linha = {}): Linha {
  return {
    id: `l-${String(n).padStart(6, "0")}`,
    organization_id: ORG_ID,
    contact_id: "ct1",
    pipeline_id: FUNIL,
    stage_id: "e1",
    status: "open",
    title: `Negócio ${n}`,
    owner_kind: null,
    owner_user_id: null,
    owner_agent_id: null,
    value_cents: 123456,
    valor_sigiloso: false,
    tags: [],
    custom_fields: {},
    created_at: "2026-11-01T12:00:00.000Z",
    updated_at: "2026-11-02T12:00:00.000Z",
    contacts: CONTATO,
    ...extra,
  };
}

function pedido(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/export${query}`);
}

async function texto(resposta: Response): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(await resposta.arrayBuffer()));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 5, window_sec: 60 });
  vi.mocked(createClient).mockResolvedValue(bancoFalso(tabelas([lead(1)])).db);
});

describe("GET /api/v1/leads/export — permissão e limite", () => {
  it("exige manager ou acima", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Sem permissão.", 403),
    } as never);
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("5 por minuto por usuário; estourou, 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 6, limit: 5, window_sec: 60 });
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(429);
    expect(resposta.headers.get("Retry-After")).toBe("60");
    const [bucket, limite, janela] = vi.mocked(checkRateLimit).mock.calls[0]!;
    expect(bucket).toContain(USER_ID);
    expect(limite).toBe(5);
    expect(janela).toBe(60);
    expect(audit).not.toHaveBeenCalled();
  });

  it("os dois exports têm baldes de limite separados", async () => {
    const { GET } = await import("./route");
    await GET(pedido());
    const [bucket] = vi.mocked(checkRateLimit).mock.calls[0]!;
    expect(bucket).toContain("leads");
  });
});

describe("GET /api/v1/leads/export — o arquivo", () => {
  it("text/csv UTF-8, anexo leads-AAAA-MM-DD.csv, BOM e cabeçalho da decisão", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T01:30:00Z"));
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(resposta.headers.get("Content-Disposition")).toBe('attachment; filename="leads-2026-11-13.csv"');
    const corpo = await texto(resposta);
    expect(corpo.startsWith(`${BOM}Nome,Telefone,Funil,Etapa,Dono,Valor,Etiquetas,Criado em,Última atualização\r\n`)).toBe(true);
    // Valor em reais, com vírgula decimal, entre aspas porque o separador também é vírgula.
    expect(corpo).toContain('"1234,56"');
  });

  it("a COMISSÃO NUNCA SAI: negócio sigiloso vai sem valor, e o valor sigiloso não aparece em lugar nenhum do arquivo", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso(
        tabelas([
          lead(1, { valor_sigiloso: true, value_cents: 98765, custom_fields: { valor_comissao: "R$ 987,65", cidade: "Recife" } }),
          lead(2, { valor_sigiloso: false, value_cents: 5000 }),
        ]),
      ).db,
    );
    const { GET } = await import("./route");
    const corpo = await texto(await GET(pedido()));
    expect(corpo).not.toContain("987,65");
    expect(corpo).not.toContain("98765");
    expect(corpo).not.toContain("valor_comissao");
    expect(corpo).toContain("50,00");
    expect(corpo).toContain("Recife");
  });

  it("filtros da tela de Leads: busca, tag e funil", async () => {
    const ana = { display_name: "Ana Souza", name: null, phone_number: "+5511911110000", tags: ["vip"], is_anonymized: false };
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso(
        tabelas([
          lead(1, { contacts: ana }),
          lead(2, { contacts: { ...ana, display_name: "Bruno" } }),
          lead(3, { contacts: ana, pipeline_id: OUTRO_FUNIL }),
        ]),
      ).db,
    );
    const { GET } = await import("./route");
    const corpo = await texto(await GET(pedido(`?busca=ana&tag=vip&pipeline=${FUNIL}`)));
    const linhas = corpo.trim().split("\r\n");
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toContain("Ana Souza");
  });

  it("ISOLAMENTO: não sai negócio de outra organização", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso(tabelas([lead(1), lead(2, { organization_id: OUTRA_ORG, contacts: { ...CONTATO, display_name: "Vazou" } })])).db,
    );
    const { GET } = await import("./route");
    const corpo = await texto(await GET(pedido()));
    expect(corpo).not.toContain("Vazou");
    expect(corpo.trim().split("\r\n")).toHaveLength(2);
  });

  it("MAIS de 1.000 negócios saem inteiros", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso(tabelas(Array.from({ length: 2100 }, (_, i) => lead(i + 1)))).db,
    );
    const { GET } = await import("./route");
    const corpo = await texto(await GET(pedido()));
    expect(corpo.trim().split("\r\n")).toHaveLength(2101);
  });

  it("erro do banco antes do primeiro byte vira 500 em JSON", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso(tabelas([lead(1)]), { falharEm: "crm_leads" }).db);
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(500);
    expect(resposta.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("GET /api/v1/leads/export — auditoria", () => {
  it("grava leads.exported uma vez, com contagem e filtros, sem dados de negócio", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso(tabelas([lead(1, { title: "Segredo da Silva" }), lead(2)])).db,
    );
    const { GET } = await import("./route");
    await texto(await GET(pedido(`?busca=maria&pipeline=${FUNIL}`)));
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada.action).toBe("leads.exported");
    expect(entrada.organizationId).toBe(ORG_ID);
    // M2: só se havia busca e o tamanho, nunca o termo.
    expect(entrada.metadata).toMatchObject({
      linhas: 2,
      completo: true,
      filtros: { busca_informada: true, busca_tamanho: 5, pipeline: FUNIL },
    });
    const serializado = JSON.stringify(entrada);
    expect(serializado).not.toContain("maria");
    expect(serializado).not.toContain('"busca"');
    expect(serializado).not.toContain("Segredo");
    expect(serializado).not.toContain("+5511999");
    // O valor do negócio (123456 centavos) não entra na auditoria. (Não se testa "1234" solto: o requestId é um UUID
    // aleatório e poderia conter essa sequência por acaso.)
    expect(serializado).not.toContain("123456");
    expect(serializado).not.toContain("1234,56");
  });
});

describe("GET /api/v1/leads/export — casos de borda", () => {
  it("modo SUPORTE (sessão de acompanhamento administrativo) não exporta: 403 claro, sem ler o banco nem auditar", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER_ID, idioma: "pt-BR", support: { access_mode: "full", status: "active", organization_id: ORG_ID } },
      org: { orgId: ORG_ID },
    } as never);
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(403);
    const json = (await resposta.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("forbidden");
    expect(json.error.message).toMatch(/acompanhamento/i);
    expect(createClient).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("429 leva X-RateLimit-Limit/Remaining/Reset além de Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 6, limit: 5, window_sec: 60 });
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(429);
    expect(resposta.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(resposta.headers.get("X-RateLimit-Remaining")).toBe("0");
    const reinicio = Number(resposta.headers.get("X-RateLimit-Reset"));
    expect(Number.isInteger(reinicio)).toBe(true);
    expect(reinicio).toBeGreaterThan(Math.floor(Date.now() / 1000) - 1);
    expect(reinicio).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 61);
  });

  it("funil que não é UUID é 422, sem tocar no banco", async () => {
    const { GET } = await import("./route");
    const resposta = await GET(pedido("?pipeline=nao-e-uuid"));
    expect(resposta.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("busca longa demais é 422 (limite de tamanho)", async () => {
    const { GET } = await import("./route");
    const resposta = await GET(pedido(`?busca=${"a".repeat(201)}`));
    expect(resposta.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("datas de/ate fora do formato AAAA-MM-DD são 422", async () => {
    const { GET } = await import("./route");
    expect((await GET(pedido("?de=ontem"))).status).toBe(422);
    expect((await GET(pedido("?ate=2026-13-45"))).status).toBe(422);
  });

  it("erro do banco: resposta genérica (nunca a mensagem crua) e a causa vai para o logger", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso(tabelas([lead(1)]), { falharEm: "crm_leads" }).db);
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(500);
    const texto = JSON.stringify(await resposta.json());
    expect(texto).not.toContain("banco caiu");
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).toContain("banco caiu");
  });
});

describe("GET /api/v1/leads/export — intervalo de última compra (I2)", () => {
  it("de/ate valem: só saem os negócios dos contatos que a regra da tela deixa no intervalo, e a auditoria guarda as datas", async () => {
    vi.mocked(idsDeContatosNoIntervalo).mockResolvedValue(new Set(["ct-dentro"]));
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso(
        tabelas([
          lead(1, { contact_id: "ct-dentro", contacts: { ...CONTATO, display_name: "Dentro" } }),
          lead(2, { contact_id: "ct-fora", contacts: { ...CONTATO, display_name: "Fora" } }),
        ]),
      ).db,
    );
    const { GET } = await import("./route");
    const corpo = await texto(await GET(pedido("?de=2026-03-01&ate=2026-03-31")));
    expect(corpo).toContain("Dentro");
    expect(corpo).not.toContain("Fora");
    expect(vi.mocked(idsDeContatosNoIntervalo).mock.calls[0]![1]).toBe(ORG_ID);
    expect(vi.mocked(idsDeContatosNoIntervalo).mock.calls[0]![2]).toMatchObject({ de: "2026-03-01", ate: "2026-03-31" });
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({ filtros: { de: "2026-03-01", ate: "2026-03-31" } });
  });

  // M4: base grande demais para ler inteira (teto de 20 mil linhas) com o intervalo ativo: mensagem própria, nunca o 500 genérico.
  it("teto de leitura excedido: 422 com mensagem que manda estreitar o filtro, no idioma do usuário, sem 500", async () => {
    vi.mocked(idsDeContatosNoIntervalo).mockRejectedValue(new LimiteDeLeituraExcedido());
    vi.mocked(createClient).mockResolvedValue(bancoFalso(tabelas([lead(1)])).db);
    const { GET } = await import("./route");
    const resposta = await GET(pedido("?de=2026-03-01"));
    expect(resposta.status).toBe(422);
    expect(resposta.headers.get("Content-Type")).toContain("application/json");
    const corpo = (await resposta.json()) as { error: { message: string } };
    expect(corpo.error.message).toBe("A base é grande demais para esse intervalo; estreite o filtro.");
    expect(audit).not.toHaveBeenCalled();

    vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER_ID, idioma: "es" }, org: { orgId: ORG_ID } } as never);
    const emEspanhol = (await (await GET(pedido("?de=2026-03-01"))).json()) as { error: { message: string } };
    expect(emEspanhol.error.message).toContain("demasiado grande");
  });
});
