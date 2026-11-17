/**
 * "Conectar novo WhatsApp" sem WAHA: cria a instância na Evolution e a linha da conexão.
 * A Evolution é dublada por `fetch`; o banco, por um construtor de consultas em memória.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";

import { ChannelConnectionError } from "./connect-waha";
import {
  connectEvolutionChannel,
  nomeDaInstancia,
  nomeDaInstanciaDoOnboarding,
  servidorDeQrConfigurado,
} from "./connect-evolution";

const ORG = "11111111-2222-3333-4444-555555555555";
const CHAVE = "7f1c2b6e-0a41-4f6e-9d0c-1a2b3c4d5e6f";
const PEDIDO = { organizationId: ORG, idempotencyKey: CHAVE, userId: "user-1", requestId: "req-1" };

interface Estado {
  existente: Record<string, unknown> | null;
  insercao: Record<string, unknown> | null;
  erroDaInsercao: { code: string } | null;
  linhaInserida: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
}

function bancoFalso(estado: Estado) {
  const consulta: Record<string, unknown> = {};
  consulta.select = () => consulta;
  consulta.eq = (c: string, v: unknown) => {
    estado.filtros.push([c, v]);
    return consulta;
  };
  consulta.is = (c: string, v: unknown) => {
    estado.filtros.push([`${c} is`, v]);
    return consulta;
  };
  consulta.maybeSingle = async () => ({ data: estado.existente, error: null });
  consulta.single = async () =>
    estado.erroDaInsercao
      ? { data: null, error: estado.erroDaInsercao }
      : { data: estado.linhaInserida, error: null };
  consulta.insert = (linha: Record<string, unknown>) => {
    estado.insercao = linha;
    return consulta;
  };
  return { from: () => consulta } as never;
}

let estado: Estado;
let chamadas: Array<{ url: string; corpo: unknown; apikey: string | null }>;

function evolutionFalsa(resposta: { status: number; corpo?: string }) {
  chamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      chamadas.push({
        url: String(url),
        corpo: init?.body ? JSON.parse(String(init.body)) : undefined,
        apikey: new Headers(init?.headers).get("apikey"),
      });
      return new Response(resposta.corpo ?? "{}", { status: resposta.status });
    }),
  );
}

beforeEach(() => {
  estado = {
    existente: null,
    insercao: null,
    erroDaInsercao: null,
    linhaInserida: { id: "canal-1", provider: "evolution", status: "STARTING", display_name: null },
    filtros: [],
  };
  vi.stubEnv("EVOLUTION_API_BASE_URL", "http://evolution:8080/");
  vi.stubEnv("EVOLUTION_API_KEY", "chave-do-servidor");
  vi.mocked(audit).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("servidorDeQrConfigurado", () => {
  it("exige endereço E chave", () => {
    expect(servidorDeQrConfigurado()).toBe(true);
    vi.stubEnv("EVOLUTION_API_KEY", "");
    expect(servidorDeQrConfigurado()).toBe(false);
    vi.stubEnv("EVOLUTION_API_KEY", "x");
    vi.stubEnv("EVOLUTION_API_BASE_URL", "  ");
    expect(servidorDeQrConfigurado()).toBe(false);
  });
});

describe("nomeDaInstancia", () => {
  it("só tem [a-z0-9_], é estável para a mesma chave e muda com a chave", () => {
    const a = nomeDaInstancia(ORG, CHAVE);
    expect(a).toMatch(/^crm_[a-z0-9]{8}_[a-f0-9]{12}$/);
    expect(nomeDaInstancia(ORG, CHAVE.toUpperCase())).toBe(a);
    expect(nomeDaInstancia(ORG, "00000000-0000-4000-8000-000000000000")).not.toBe(a);
  });
});

describe("connectEvolutionChannel", () => {
  it("cria a instância no servidor e grava a conexão STARTING, sem copiar a chave do servidor", async () => {
    evolutionFalsa({ status: 201 });
    const r = await connectEvolutionChannel(bancoFalso(estado), { ...PEDIDO, displayName: "Vendas" });

    expect(r.replay).toBe(false);
    expect(r.channel).toMatchObject({ id: "canal-1", provider: "evolution" });

    // chamou o servidor certo, com a chave no CABEÇALHO e o nome da instância no corpo
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("http://evolution:8080/instance/create");
    expect(chamadas[0]!.apikey).toBe("chave-do-servidor");
    expect(chamadas[0]!.corpo).toMatchObject({
      instanceName: nomeDaInstancia(ORG, CHAVE),
      integration: "WHATSAPP-BAILEYS",
    });

    // a linha: organização da sessão, provider, instância, status e nenhuma credencial copiada
    expect(estado.insercao).toMatchObject({
      organization_id: ORG,
      provider: "evolution",
      evolution_instance_name: nomeDaInstancia(ORG, CHAVE),
      display_name: "Vendas",
      status: "STARTING",
      created_by: "user-1",
    });
    expect(estado.insercao).not.toHaveProperty("evolution_token_encrypted");
    expect(estado.insercao).not.toHaveProperty("evolution_base_url");
    expect(JSON.stringify(estado.insercao)).not.toContain("chave-do-servidor");
    // modo de teste do canal novo (IA só para quem o dono autorizar)
    expect(estado.insercao?.metadata).toMatchObject({ ai_gate: "allowlist" });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.connected", organizationId: ORG, resourceId: "canal-1" }),
    );
  });

  it("o mesmo clique reenviado devolve a conexão que já existe, sem criar nada de novo", async () => {
    evolutionFalsa({ status: 201 });
    estado.existente = { id: "canal-1", provider: "evolution", status: "STARTING" };
    const r = await connectEvolutionChannel(bancoFalso(estado), PEDIDO);

    expect(r.replay).toBe(true);
    expect(chamadas).toHaveLength(0);
    expect(estado.insercao).toBeNull();
    // e a busca é da organização, da instância e só entre as não arquivadas
    expect(estado.filtros).toContainEqual(["organization_id", ORG]);
    expect(estado.filtros).toContainEqual(["evolution_instance_name", nomeDaInstancia(ORG, CHAVE)]);
    expect(estado.filtros).toContainEqual(["archived_at is", null]);
  });

  it("nome já em uso na Evolution (403) não é erro: segue e grava a conexão", async () => {
    evolutionFalsa({ status: 403, corpo: '{"response":{"message":["This name \\"x\\" is already in use."]}}' });
    const r = await connectEvolutionChannel(bancoFalso(estado), PEDIDO);
    expect(r.replay).toBe(false);
    expect(estado.insercao).not.toBeNull();
  });

  it("corrida: outro pedido gravou antes (23505) devolve a linha dele", async () => {
    evolutionFalsa({ status: 201 });
    estado.erroDaInsercao = { code: "23505" };
    // a primeira busca não acha; a de depois da corrida acha
    let buscas = 0;
    const banco = bancoFalso(estado) as unknown as { from: () => { maybeSingle: () => Promise<unknown> } };
    const consulta = banco.from();
    consulta.maybeSingle = async () => {
      buscas += 1;
      return { data: buscas === 1 ? null : { id: "canal-9", provider: "evolution", status: "STARTING" }, error: null };
    };
    const r = await connectEvolutionChannel({ from: () => consulta } as never, PEDIDO);
    expect(r.replay).toBe(true);
    expect(r.channel.id).toBe("canal-9");
  });

  it("Evolution fora do ar: erro de reparo sem vazar o corpo do servidor, e nada é gravado", async () => {
    evolutionFalsa({ status: 500, corpo: "segredo-interno-do-servidor" });
    const erro = await connectEvolutionChannel(bancoFalso(estado), PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ChannelConnectionError);
    expect((erro as ChannelConnectionError).code).toBe("connection_repair_required");
    expect((erro as ChannelConnectionError).status).toBe(502);
    expect(JSON.stringify((erro as ChannelConnectionError).technical ?? {})).not.toContain("segredo-interno");
    expect(estado.insercao).toBeNull();
  });

  it("sem Idempotency-Key uuid: 422, sem falar com ninguém", async () => {
    evolutionFalsa({ status: 201 });
    const erro = await connectEvolutionChannel(bancoFalso(estado), { ...PEDIDO, idempotencyKey: "abc" }).catch((e: unknown) => e);
    expect((erro as ChannelConnectionError).status).toBe(422);
    expect(chamadas).toHaveLength(0);
  });

  it("passo do wizard: uma instância fixa por organização, sem exigir Idempotency-Key, marcada em metadata.onboarding", async () => {
    evolutionFalsa({ status: 201 });
    const r = await connectEvolutionChannel(bancoFalso(estado), { ...PEDIDO, idempotencyKey: "", onboarding: true });
    expect(r.replay).toBe(false);
    expect((chamadas[0]!.corpo as { instanceName: string }).instanceName).toBe(nomeDaInstanciaDoOnboarding(ORG));
    expect(nomeDaInstanciaDoOnboarding(ORG)).toBe("crm_11111111_onboarding");
    expect(estado.insercao).toMatchObject({
      evolution_instance_name: "crm_11111111_onboarding",
      metadata: expect.objectContaining({ onboarding: true, ai_gate: "allowlist" }),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { provider: "evolution", origin: "onboarding" } }),
    );
  });

  it("passo do wizard aberto de novo: reaproveita a conexão que já existe", async () => {
    evolutionFalsa({ status: 201 });
    estado.existente = { id: "canal-1", provider: "evolution", status: "STARTING" };
    const r = await connectEvolutionChannel(bancoFalso(estado), { ...PEDIDO, idempotencyKey: "", onboarding: true });
    expect(r.replay).toBe(true);
    expect(chamadas).toHaveLength(0);
    expect(estado.filtros).toContainEqual(["evolution_instance_name", "crm_11111111_onboarding"]);
  });

  it("servidor não configurado: 503", async () => {
    vi.stubEnv("EVOLUTION_API_KEY", "");
    const erro = await connectEvolutionChannel(bancoFalso(estado), PEDIDO).catch((e: unknown) => e);
    expect((erro as ChannelConnectionError).code).toBe("evolution_not_configured");
    expect((erro as ChannelConnectionError).status).toBe(503);
  });

  it("falha ao gravar a linha: 503, sem audit", async () => {
    evolutionFalsa({ status: 201 });
    estado.erroDaInsercao = { code: "XX000" };
    const erro = await connectEvolutionChannel(bancoFalso(estado), PEDIDO).catch((e: unknown) => e);
    expect((erro as ChannelConnectionError).status).toBe(503);
    expect(audit).not.toHaveBeenCalled();
  });
});
