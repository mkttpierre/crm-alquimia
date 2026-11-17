/**
 * O passo do wizard com a Evolution: achar a conexão, ler o estado ao vivo e pedir o QR.
 * A Evolution é dublada por `fetch`; o banco, por um construtor de consultas em memória.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => null }));

import {
  carregarCanalDoOnboardingEvolution,
  qrDoOnboardingEvolution,
  statusDoOnboardingEvolution,
} from "./onboarding-evolution";

const ORG = "11111111-2222-3333-4444-555555555555";
const CANAL = { id: "canal-1", evolution_instance_name: "crm_11111111_onboarding", status: "STARTING" };

interface Estado {
  linha: Record<string, unknown> | null;
  erro: { message: string } | null;
  filtros: Array<[string, unknown]>;
  atualizacao: Record<string, unknown> | null;
  erroDoUpdate: { message: string } | null;
}
let estado: Estado;

function banco() {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.update = (corpo: Record<string, unknown>) => {
    estado.atualizacao = corpo;
    const u: Record<string, unknown> = {};
    u.eq = (c: string, v: unknown) => {
      estado.filtros.push([c, v]);
      return u;
    };
    u.then = (resolve: (v: unknown) => void) => resolve({ error: estado.erroDoUpdate });
    return u;
  };
  for (const m of ["eq", "is", "order", "limit"]) {
    q[m] = (c?: string, v?: unknown) => {
      if (m === "eq" || m === "is") estado.filtros.push([m === "is" ? `${c} is` : String(c), v]);
      return q;
    };
  }
  q.maybeSingle = async () => ({ data: estado.linha, error: estado.erro });
  return { from: () => q } as never;
}

function evolutionFalsa(estadoDaInstancia: string, base64?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const caminho = new URL(String(url)).pathname;
      if (caminho.includes("/instance/connectionState")) return Response.json({ instance: { state: estadoDaInstancia } });
      if (caminho.includes("/settings/find")) return Response.json({ syncFullHistory: false });
      if (caminho.includes("/settings/set")) return Response.json({});
      if (caminho.includes("/instance/connect")) return Response.json(base64 ? { base64 } : {});
      return new Response("nao esperado", { status: 500 });
    }),
  );
}

beforeEach(() => {
  estado = { linha: CANAL, erro: null, filtros: [], atualizacao: null, erroDoUpdate: null };
  vi.stubEnv("EVOLUTION_API_BASE_URL", "http://evolution:8080");
  vi.stubEnv("EVOLUTION_API_KEY", "chave-do-servidor");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("carregarCanalDoOnboardingEvolution", () => {
  it("busca a conexão do wizard da organização, só Evolution, só não arquivada", async () => {
    const canal = await carregarCanalDoOnboardingEvolution(banco(), ORG);
    expect(canal).toEqual(CANAL);
    expect(estado.filtros).toContainEqual(["organization_id", ORG]);
    expect(estado.filtros).toContainEqual(["provider", "evolution"]);
    expect(estado.filtros).toContainEqual(["metadata->>onboarding", "true"]);
    expect(estado.filtros).toContainEqual(["archived_at is", null]);
  });

  it("sem conexão: null; consulta com erro: lança", async () => {
    estado.linha = null;
    expect(await carregarCanalDoOnboardingEvolution(banco(), ORG)).toBeNull();
    estado.erro = { message: "boom" };
    await expect(carregarCanalDoOnboardingEvolution(banco(), ORG)).rejects.toThrow("boom");
  });
});

describe("statusDoOnboardingEvolution", () => {
  it("instância fechada ou conectando: o wizard mostra o QR (SCAN_QR_CODE) e nada é gravado", async () => {
    for (const s of ["close", "connecting"]) {
      evolutionFalsa(s);
      expect(await statusDoOnboardingEvolution(banco(), banco(), ORG, CANAL)).toBe("SCAN_QR_CODE");
    }
    expect(estado.atualizacao).toBeNull();
  });

  it("instância aberta: WORKING, e a conexão é gravada como WORKING na organização certa", async () => {
    evolutionFalsa("open");
    expect(await statusDoOnboardingEvolution(banco(), banco(), ORG, CANAL)).toBe("WORKING");
    expect(estado.atualizacao).toMatchObject({ status: "WORKING" });
    expect(estado.filtros).toContainEqual(["organization_id", ORG]);
    expect(estado.filtros).toContainEqual(["id", "canal-1"]);
  });

  it("já gravada como WORKING: não escreve de novo", async () => {
    evolutionFalsa("open");
    await statusDoOnboardingEvolution(banco(), banco(), ORG, { ...CANAL, status: "WORKING" });
    expect(estado.atualizacao).toBeNull();
  });

  it("Evolution fora do ar: lança (a rota devolve 502)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    await expect(statusDoOnboardingEvolution(banco(), banco(), ORG, CANAL)).rejects.toThrow();
  });

  it("falha ao gravar o WORKING: lança", async () => {
    evolutionFalsa("open");
    estado.erroDoUpdate = { message: "x" };
    await expect(statusDoOnboardingEvolution(banco(), banco(), ORG, CANAL)).rejects.toThrow("connection_sync_failed");
  });
});

describe("qrDoOnboardingEvolution", () => {
  it("devolve os bytes do PNG do QR", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
    evolutionFalsa("close", `data:image/png;base64,${png}`);
    const bytes = await qrDoOnboardingEvolution(banco(), ORG, CANAL);
    expect(Array.from(bytes ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  });

  it("sem QR ainda, ou base64 que não é PNG: null", async () => {
    evolutionFalsa("close");
    expect(await qrDoOnboardingEvolution(banco(), ORG, CANAL)).toBeNull();
    evolutionFalsa("close", "data:text/html;base64,PGI+");
    expect(await qrDoOnboardingEvolution(banco(), ORG, CANAL)).toBeNull();
  });
});
