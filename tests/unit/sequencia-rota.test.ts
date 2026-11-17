// @vitest-environment node
/**
 * Rotas da sequência do operador (`/funil-valores`): POST /api/v1/disparo/sequencia (agenda), DELETE (cancela) e
 * POST /api/v1/messages (recusa o comando como texto). Auth, Supabase e canal são falsos: nada sai de verdade, e a
 * rota nem tem como falar com canal (só grava linhas de fila).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configDoMotor } from "@/lib/disparo/apoio-do-motor-teste";
import type { Chip } from "@/lib/disparo/fila";
import type { EnvioDaSequencia, ModeloDaParte, RepositorioSequencia } from "@/lib/disparo/atendimento/sequencia-operador";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const estado = vi.hoisted(() => ({
  repo: null as unknown,
  visivel: true,
  erroFunil: false,
  ambiente: { DISPARO_REAL_LIBERADO: "sim" } as Record<string, string | undefined>,
  auditados: [] as { action: string; metadata?: Record<string, unknown> }[],
  enviados: [] as unknown[],
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, limit: () => q, maybeSingle: async () => ({ data: estado.visivel ? { id: CONVERSA } : null, error: estado.erroFunil ? { message: "erro" } : null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, k: string) => estado.ambiente[k] }),
}));
vi.mock("@/lib/audit", () => ({ audit: async (a: { action: string; metadata?: Record<string, unknown> }) => void estado.auditados.push(a) }));
vi.mock("@/lib/disparo/atendimento/sequencia-operador-supabase", () => ({ repositorioSequenciaSupabase: () => estado.repo }));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (...a: unknown[]) => {
    estado.enviados.push(a);
    return { id: "msg" };
  },
}));

import { DELETE as deletar, POST as postSequencia } from "@/app/api/v1/disparo/sequencia/route";
import { POST as postMensagem } from "@/app/api/v1/messages/route";

const chip: Chip = { id: "chip-1", nome: "celular-a", estado: "rampa", saude: "verde", diaRampa: 5, proximoEnvioEm: null, pausadoAte: null, enviosDesdePausa: 0, pausaACada: 15 };
const modelos = (): ModeloDaParte[] =>
  [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    atalho: `valores-${n}`, titulo: `${n}/7`, corpo: n % 2 === 0 ? "" : `texto ${n}`, midia: n % 2 === 0 ? { id: `m${n}`, kind: "image" as const, nome: `img${n}`, tamanhoBytes: 1000 } : null,
  }));

let gravados: EnvioDaSequencia[];
let cancelados: string[];

function montarRepo(p: { chip?: Chip | null } = {}) {
  const repo: RepositorioSequencia = {
    // A janela de resposta inteira: a rota usa o relógio de verdade e o teste não pode depender da hora em que roda.
    config: async () => ({ ...configDoMotor(ORG, "real"), janelaResposta: { inicioMin: 0, fimMin: 1440 } }),
    leadDaConversa: async () => "lead-1",
    lead: async () => ({ id: "lead-1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false }),
    garantirLead: async () => null,
    chipDaConversa: async () => (p.chip === undefined ? chip : p.chip),
    // O funil de valores como a migration 0248 o semeia (sem áudio aqui: 3 s entre os passos, "digitando" 2 s).
    funil: async (_o, _u, ref) =>
      ref.atalho === "funil-valores"
        ? { id: "f1", titulo: "Funil de valores", atalho: "funil-valores", passos: modelos().map((m, i) => ({ modelo: m, atrasoMs: i === 0 ? 0 : 3000, presenca: "digitando" as const, presencaMs: 2000 })) }
        : null,
    modeloPorId: async () => null,
    emAberto: async () => 0,
    enfileirar: async (_o, envios) => void gravados.push(...envios),
    cancelar: async (_o, _l, motivo) => {
      cancelados.push(motivo);
      return gravados.length;
    },
    repeticaoDoPedido: async (_o, conversa, chave) =>
      (estado.auditados.find((a) => a.metadata?.idempotency_key === chave && a.metadata?.conversa === conversa)?.metadata?.resposta as Record<string, unknown> | undefined) ?? null,
  };
  return repo;
}

const pedir = (rota: typeof postSequencia, corpo: unknown) =>
  rota(new NextRequest("http://localhost/api/v1/x", { method: "POST", body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  gravados = [];
  cancelados = [];
  estado.visivel = true;
  estado.erroFunil = false;
  estado.ambiente = { DISPARO_REAL_LIBERADO: "sim" };
  estado.auditados = [];
  estado.enviados = [];
  estado.repo = montarRepo();
});

describe("POST /api/v1/disparo/sequencia", () => {
  it("agenda as 7 mensagens, responde o resumo e audita; NADA é enviado ao canal pela rota", async () => {
    const r = await pedir(postSequencia, { conversation_id: CONVERSA, atalho: "funil-valores" });
    expect(r.status).toBe(201);
    const d = (await r.json()).data;
    expect(d).toMatchObject({ partes: 7, modo: "real", chip: "celular-a", motivo_simulado: null });
    // Sem áudio neste funil: a primeira começa de 2 a 5 s depois e chega 2 s depois ("digitando"), + 6 pausas de 3 s = 22 a 25 s.
    expect(d.duracao_seg).toBeGreaterThanOrEqual(22);
    expect(d.duracao_seg).toBeLessThanOrEqual(25);
    expect(new Date(d.ultima_em).getTime()).toBeGreaterThan(new Date(d.primeira_em).getTime());

    expect(gravados).toHaveLength(7);
    expect(gravados.map((g) => g.tipo)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `funil_valores:${n}`));
    expect(gravados.every((g) => g.estado === "pendente")).toBe(true);
    for (let i = 1; i < 7; i++) expect(gravados[i]!.enviarApos.getTime()).toBeGreaterThan(gravados[i - 1]!.enviarApos.getTime());
    expect(estado.enviados).toEqual([]);
    expect(estado.auditados.map((a) => a.action)).toEqual(["disparo.sequencia_agendada"]);
    expect(estado.auditados[0]!.metadata).toMatchObject({ partes: 7, modo: "real" });
  });

  it("trava fechada: 201 com modo `simulado` e as linhas nascem `simulado`", async () => {
    estado.ambiente = {};
    const r = await pedir(postSequencia, { conversation_id: CONVERSA, atalho: "funil-valores" });
    expect(r.status).toBe(201);
    expect((await r.json()).data).toMatchObject({ modo: "simulado" });
    expect(gravados.every((g) => g.estado === "simulado")).toBe(true);
  });

  it("chip parado: 409 `sequencia_chip` com o motivo, nada gravado, nada auditado", async () => {
    estado.repo = montarRepo({ chip: { ...chip, nome: "chip-gama", saude: "vermelho", pausadoAte: new Date(Date.now() + 3_600_000) } });
    const r = await pedir(postSequencia, { conversation_id: CONVERSA, atalho: "funil-valores" });
    expect(r.status).toBe(409);
    const e = (await r.json()).error;
    expect(e.code).toBe("sequencia_chip");
    expect(e.message).toMatch(/chip-gama/);
    expect(gravados).toEqual([]);
    expect(estado.auditados).toEqual([]);
  });

  it("conversa que o usuário não enxerga: 404 e nada gravado", async () => {
    estado.visivel = false;
    const r = await pedir(postSequencia, { conversation_id: CONVERSA, atalho: "funil-valores" });
    expect(r.status).toBe(404);
    expect(gravados).toEqual([]);
  });

  it("sequência que não existe: 422", async () => {
    const r = await pedir(postSequencia, { conversation_id: CONVERSA, atalho: "nao-existe" });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("sequencia_sequencia");
  });

  it("conversation_id inválido: 422 de validação", async () => {
    const r = await pedir(postSequencia, { conversation_id: "nao-e-uuid", atalho: "funil-valores" });
    expect(r.status).toBe(422);
  });
});

describe("POST /api/v1/disparo/sequencia: Idempotency-Key e confirmação", () => {
  const pedirComChave = (corpo: unknown, chave: string) =>
    postSequencia(
      new NextRequest("http://localhost/api/v1/x", {
        method: "POST",
        body: JSON.stringify(corpo),
        headers: { "content-type": "application/json", "idempotency-key": chave },
      }),
    );

  it("o mesmo pedido repetido com a mesma Idempotency-Key (retry do cliente, duplo clique): devolve o MESMO resultado e não agenda de novo", async () => {
    const corpo = { conversation_id: CONVERSA, atalho: "funil-valores" };
    const r1 = await pedirComChave(corpo, "chave-1");
    const r2 = await pedirComChave(corpo, "chave-1");
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect((await r2.json()).data).toEqual((await r1.json()).data);
    expect(gravados).toHaveLength(7);
    expect(estado.auditados.map((a) => a.action)).toEqual(["disparo.sequencia_agendada"]);
  });

  it("irmão: chave diferente é outro pedido", async () => {
    const corpo = { conversation_id: CONVERSA, atalho: "funil-valores" };
    await pedirComChave(corpo, "chave-1");
    await pedirComChave(corpo, "chave-2");
    expect(gravados).toHaveLength(14);
  });

  it("`confirmar: true` chega ao agendamento (reenvio consciente da mesma sequência)", async () => {
    const repo = montarRepo();
    repo.ultimoEnvioDaSequencia = async () => new Date(Date.now() - 3600_000);
    estado.repo = repo;
    const recusa = await pedir(postSequencia, { conversation_id: CONVERSA, atalho: "funil-valores" });
    expect(recusa.status).toBe(409);
    expect((await recusa.json()).error.code).toBe("sequencia_ja_enviada");
    const ok = await pedir(postSequencia, { conversation_id: CONVERSA, atalho: "funil-valores", confirmar: true });
    expect(ok.status).toBe(201);
  });
});

describe("DELETE /api/v1/disparo/sequencia", () => {
  const apagar = (conversa: string) => deletar(new NextRequest(`http://localhost/api/v1/disparo/sequencia?conversation_id=${conversa}`, { method: "DELETE" }));

  it("cancela o que não saiu e audita", async () => {
    gravados.push(...[1, 2, 3].map((n) => ({ tipo: `funil_valores:${n}` }) as EnvioDaSequencia));
    const r = await apagar(CONVERSA);
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ canceladas: 3 });
    expect(cancelados[0]).toMatch(/operador/);
    expect(estado.auditados.map((a) => a.action)).toEqual(["disparo.sequencia_cancelada"]);
  });

  it("nada a cancelar: 200 com 0 e sem auditoria", async () => {
    const r = await apagar(CONVERSA);
    expect((await r.json()).data).toEqual({ canceladas: 0 });
    expect(estado.auditados).toEqual([]);
  });

  it("conversation_id ausente: 422", async () => {
    const r = await deletar(new NextRequest("http://localhost/api/v1/disparo/sequencia", { method: "DELETE" }));
    expect(r.status).toBe(422);
  });
});

describe("POST /api/v1/messages recusa o comando da sequência como texto", () => {
  it.each(["/funil-valores", "  /FUNIL-VALORES  "])("%j não vai para a lead", async (body) => {
    const r = await pedir(postMensagem, { conversation_id: CONVERSA, body });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("sequencia_comando_nao_e_mensagem");
    expect(estado.enviados).toEqual([]);
  });

  it("recusa comando de funil exclu?do, inclusive com argumentos", async () => {
    estado.visivel = false;
    const r = await pedir(postMensagem, { conversation_id: CONVERSA, body: "/funil-valores agora" });
    expect(r.status).toBe(422);
    expect(estado.enviados).toEqual([]);
  });

  it("recusa atalho de funil excluido com nome arbitrario", async () => {
    estado.visivel = false;
    const r = await pedir(postMensagem, { conversation_id: CONVERSA, body: "/valores" });
    expect(r.status).toBe(422);
    expect(estado.enviados).toEqual([]);
  });

  it("falha fechada quando a consulta do funil falha", async () => {
    estado.visivel = false;
    estado.erroFunil = true;
    const r = await pedir(postMensagem, { conversation_id: CONVERSA, body: "/funil-valores" });
    expect(r.status).toBe(500);
    expect(estado.enviados).toEqual([]);
  });

  it("mensagem normal e `/valores-1` (modelo comum) seguem o caminho de sempre", async () => {
    expect((await pedir(postMensagem, { conversation_id: CONVERSA, body: "Oi, tudo bem?" })).status).toBe(201);
    expect((await pedir(postMensagem, { conversation_id: CONVERSA, body: "te mando o /funil-valores depois" })).status).toBe(201);
    expect(estado.enviados).toHaveLength(2);
  });
});
