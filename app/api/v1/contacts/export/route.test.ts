// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { BOM } from "@/lib/exportacao/csv";
import { logger } from "@/lib/logger";
import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { bancoFalso, type Linha } from "@/tests/helpers/postgrest-falso";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";

function contato(n: number, extra: Linha = {}): Linha {
  return {
    id: `c-${String(n).padStart(6, "0")}`,
    organization_id: ORG_ID,
    display_name: `Pessoa ${n}`,
    name: null,
    phone_number: `+5511999${String(n).padStart(6, "0")}`,
    email: `pessoa${n}@exemplo.com`,
    tags: ["vip"],
    source: "manual",
    created_at: "2026-11-01T12:00:00.000Z",
    custom_fields: {},
    is_anonymized: false,
    is_merged_into: null,
    ...extra,
  };
}

function pedido(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/contacts/export${query}`);
}

async function corpo(resposta: Response): Promise<{ bytes: Uint8Array; texto: string }> {
  const bytes = new Uint8Array(await resposta.arrayBuffer());
  return { bytes, texto: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
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
  vi.mocked(createClient).mockResolvedValue(bancoFalso({ contacts: [contato(1)] }).db);
});

describe("GET /api/v1/contacts/export — permissão", () => {
  it("exige manager ou acima e repassa a recusa de quem não tem", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Sem permissão.", 403),
    } as never);
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    // Recusado: nada de rate limit, banco ou audit.
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem login, repassa o 401", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401),
    } as never);
    const { GET } = await import("./route");
    expect((await GET(pedido())).status).toBe(401);
  });
});

describe("GET /api/v1/contacts/export — limite de uso", () => {
  it("5 por minuto por usuário; estourou, 429 com Retry-After e sem tocar no banco", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 6, limit: 5, window_sec: 60 });
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(429);
    expect(resposta.headers.get("Retry-After")).toBe("60");
    const [bucket, limite, janela] = vi.mocked(checkRateLimit).mock.calls[0]!;
    expect(bucket).toContain(USER_ID);
    expect(limite).toBe(5);
    expect(janela).toBe(60);
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/contacts/export — o arquivo", () => {
  it("devolve text/csv UTF-8, anexo contatos-AAAA-MM-DD.csv no fuso de São Paulo, BOM e cabeçalho", async () => {
    // 01:30 UTC de 14/11 = 22:30 de 13/11 em São Paulo.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T01:30:00Z"));
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(resposta.headers.get("Content-Disposition")).toBe('attachment; filename="contatos-2026-11-13.csv"');
    expect(resposta.headers.get("Cache-Control")).toBe("no-store");
    expect(resposta.headers.get("X-Request-Id")).toBeTruthy();
    const { bytes, texto } = await corpo(resposta);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(texto.startsWith(`${BOM}Nome exibido,Nome,Telefone,E-mail,Etiquetas,Origem,Criado em\r\n`)).toBe(true);
    expect(texto).toContain("Pessoa 1,,");
  });

  it("separador ponto e vírgula opcional", async () => {
    const { GET } = await import("./route");
    const { texto } = await corpo(await GET(pedido("?separador=ponto-e-virgula")));
    expect(texto.startsWith(`${BOM}Nome exibido;Nome;Telefone;E-mail;Etiquetas;Origem;Criado em\r\n`)).toBe(true);
  });

  it("separador desconhecido é 422", async () => {
    const { GET } = await import("./route");
    expect((await GET(pedido("?separador=tab"))).status).toBe(422);
  });

  it("injeção de fórmula: nome que começa com = sai com apóstrofo", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({ contacts: [contato(1, { display_name: '=HYPERLINK("http://x")' })] }).db,
    );
    const { GET } = await import("./route");
    const { texto } = await corpo(await GET(pedido()));
    expect(texto).toContain(`"'=HYPERLINK(""http://x"")"`);
  });

  it("respeita os filtros da tela (search, tag, source)", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({
        contacts: [
          contato(1, { display_name: "Ana", tags: ["vip"], source: "whatsapp" }),
          contato(2, { display_name: "Ana B", tags: [], source: "whatsapp" }),
          contato(3, { display_name: "Zé", tags: ["vip"], source: "whatsapp" }),
        ],
      }).db,
    );
    const { GET } = await import("./route");
    const { texto } = await corpo(await GET(pedido("?search=ana&tag=vip&source=whatsapp")));
    const linhas = texto.trim().split("\r\n");
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toContain("Ana,");
  });

  it("ISOLAMENTO: não sai contato de outra organização", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({ contacts: [contato(1), contato(2, { organization_id: OUTRA_ORG, display_name: "Vazou" })] }).db,
    );
    const { GET } = await import("./route");
    const { texto } = await corpo(await GET(pedido()));
    expect(texto).not.toContain("Vazou");
    expect(texto.trim().split("\r\n")).toHaveLength(2);
  });

  it("MAIS de 1.000 contatos saem inteiros (o PostgREST corta em 1.000)", async () => {
    const todos = Array.from({ length: 2600 }, (_, i) => contato(i + 1));
    vi.mocked(createClient).mockResolvedValue(bancoFalso({ contacts: todos }).db);
    const { GET } = await import("./route");
    const { texto } = await corpo(await GET(pedido()));
    expect(texto.trim().split("\r\n")).toHaveLength(2601);
  });

  it("erro do banco antes do primeiro byte vira 500 em JSON, não um arquivo vazio", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso({ contacts: [contato(1)] }, { falharEm: "contacts" }).db);
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(500);
    expect(resposta.headers.get("Content-Type")).toContain("application/json");
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/contacts/export — auditoria", () => {
  it("grava contacts.exported UMA vez, com contagem e filtros, sem nenhum dado de contato", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({ contacts: [contato(1, { display_name: "Segredo Silva", email: "segredo@x.com" }), contato(2)] }).db,
    );
    const { GET } = await import("./route");
    await corpo(await GET(pedido("?search=pessoa&tag=vip")));
    // O corpo inteiro foi lido: o stream já fechou e a auditoria foi gravada.
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada.action).toBe("contacts.exported");
    expect(entrada.organizationId).toBe(ORG_ID);
    expect(entrada.actorUserId).toBe(USER_ID);
    expect(entrada.metadata).toMatchObject({
      linhas: expect.any(Number),
      completo: true,
      // M2: a busca é dado pessoal em potencial (nome, telefone): só se havia e o tamanho, nunca o termo.
      filtros: { busca_informada: true, busca_tamanho: 6, tag: "vip" },
    });
    const serializado = JSON.stringify(entrada);
    expect(serializado).not.toContain("pessoa");
    expect(serializado).not.toContain('"search"');
    expect(serializado).not.toContain("Segredo");
    expect(serializado).not.toContain("segredo@x.com");
    expect(serializado).not.toContain("+5511999");
  });

  it("a contagem auditada é a do arquivo", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({ contacts: Array.from({ length: 1200 }, (_, i) => contato(i + 1)) }).db,
    );
    const { GET } = await import("./route");
    await corpo(await GET(pedido()));
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({ linhas: 1200 });
  });
});

describe("GET /api/v1/contacts/export — casos de borda", () => {
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

  it("busca longa demais é 422 (limite de tamanho), sem tocar no banco", async () => {
    const { GET } = await import("./route");
    const resposta = await GET(pedido(`?search=${"a".repeat(201)}`));
    expect(resposta.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("erro do banco: resposta genérica (nunca a mensagem crua) e a causa vai para o logger", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso({ contacts: [contato(1)] }, { falharEm: "contacts" }).db);
    const { GET } = await import("./route");
    const resposta = await GET(pedido());
    expect(resposta.status).toBe(500);
    const texto = JSON.stringify(await resposta.json());
    expect(texto).not.toContain("banco caiu");
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).toContain("banco caiu");
  });
});
