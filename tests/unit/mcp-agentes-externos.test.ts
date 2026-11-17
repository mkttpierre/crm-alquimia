// @vitest-environment node
/**
 * O MCP visto por um agente externo da equipe, pelo servidor DE VERDADE (`createMcpServer`) e um
 * cliente MCP de verdade, ligados em memória — a mesma despacha de ferramenta, os mesmos gates e a mesma auditoria
 * que o `/api/mcp` usa.
 *
 *   - papel `agent` não alcança ferramenta de gestor (o motor);
 *   - venda e produto com preço recusam `actor:ai_agent` com a frase do dono, e a recusa fica no histórico;
 *   - `pode_motor = false` recusa as ferramentas do motor mesmo com papel admin;
 *   - ajuste de ritmo inválido pelo MCP volta com a MESMA mensagem da tela (`PATCH /api/v1/disparo/config`);
 *   - pausar o chip pelo MCP grava e audita com o agente NOMEADO como autor.
 */
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { esquecerPresencasParaTeste } from "@/lib/agentes-externos/presenca";
import { audit } from "@/lib/audit";
import { ABERTURA_SO_IMAGEM } from "@/lib/disparo/config";
import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import type { McpAuthResult } from "@/lib/mcp/auth";
import { MENSAGEM_DE_FECHAMENTO_HUMANO, MENSAGEM_PROIBIDO_NAO_SAI, recusaDeFechamento } from "@/lib/mcp/fechamento-humano";
import { MENSAGEM_SEM_MOTOR, createMcpServer } from "@/lib/mcp/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { bancoDuble } from "@/tests/helpers/disparo-db-double";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "44444444-4444-4444-8444-444444444444";
const AGENTE = "55555555-5555-4555-8555-555555555555";
const CHIP = "66666666-6666-4666-8666-666666666666";
const ETAPA_GANHO = "77777777-7777-4777-8777-777777777777";
const LEAD = "88888888-8888-4888-8888-888888888888";
const PIPELINE = "99999999-9999-4999-8999-999999999999";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const LEAD_DA_OUTRA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIDEO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IMAGEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const IMAGEM_DA_OUTRA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let banco: ReturnType<typeof bancoDuble>;
beforeEach(() => {
  vi.clearAllMocks();
  esquecerPresencasParaTeste();
  banco = bancoDuble({
    disparo_config: [{ organization_id: ORG, ligado: true, modo: "simulado", teto_diario: null, cadencia: "reativacao_3_toques", fonte_stage_id: null, ritmo: {}, atendimento: {}, modelos: {}, proibidos: [] }],
    disparo_chips: [{ id: CHIP, organization_id: ORG, nome: "chip de teste", estado: "ativo", saude: "verde", dia_rampa: 30, pausado_ate: null }],
    crm_stages: [{ id: ETAPA_GANHO, organization_id: ORG, is_won: true }],
    crm_leads: [{ id: LEAD_DA_OUTRA, organization_id: OUTRA }],
    media_library: [
      { id: VIDEO, organization_id: ORG, mime: "video/mp4" },
      { id: IMAGEM, organization_id: ORG, mime: "image/jpeg" },
      { id: IMAGEM_DA_OUTRA, organization_id: OUTRA, mime: "image/png" },
    ],
    organizations: [{ id: ORG, settings: { agentes_externos: { dominios_de_pagamento: ["minhaloja.com.br"] } } }],
    orders: [
      { id: "o1", organization_id: ORG, contact_id: LEAD, status: "paid", total_cents: 29700, currency: "BRL", ordered_at: "2026-11-01T10:00:00Z" },
    ],
  });
  banco.linhas("disparo_config")[0]!.proibidos = [{ padrao: "frete gr[aá]tis", motivo: "promessa" }];
  vi.mocked(createAdminClient).mockReturnValue(banco.cliente as never);
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
});

function authDoAgente(papel: Role, podeMotor = true): McpAuthResult {
  return {
    organizationId: ORG,
    role: papel,
    actor: { type: "ai_agent", id: TOKEN, role: papel, api_token_id: TOKEN },
    apiTokenId: TOKEN,
    scopes: ["actor:ai_agent", `role:${papel}`, "mcp:read", "mcp:write"],
    agenteExterno: { id: AGENTE, nome: "Head", pode_motor: podeMotor },
  };
}

async function chamar(auth: McpAuthResult, ferramenta: string, args: Record<string, unknown> = {}) {
  const server = createMcpServer(auth, "req-1");
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  await server.connect(doServidor);
  const cliente = new Client({ name: "teste", version: "0.0.0" });
  await cliente.connect(doCliente);
  const r = (await cliente.callTool({ name: ferramenta, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  await cliente.close();
  return { erro: r.isError === true, texto: r.content[0]?.text ?? "" };
}

const chamadasDaFerramenta = () =>
  vi.mocked(audit).mock.calls.map((c) => c[0]).filter((e) => e.action === "mcp.tool_called");

describe("papel do agente", () => {
  it("papel agent não alcança ferramenta de gestor (o motor)", async () => {
    const r = await chamar(authDoAgente("agent"), "crm_disparo_estado");
    expect(r.erro).toBe(true);
    expect(r.texto).toMatch(/insufficient/);
    expect(banco.escritas).toHaveLength(0);
  });

  it("papel admin alcança e lê o estado", async () => {
    const r = await chamar(authDoAgente("admin"), "crm_disparo_estado");
    expect(r.erro).toBe(false);
    expect(JSON.parse(r.texto)).toMatchObject({ ok: true, existe: true, ligado: true });
  });
});

describe("o agente para antes de fechar a venda", () => {
  it.each([
    ["crm_close_demand", { lead_id: LEAD, outcome: "won" }],
    ["crm_create_lead", { pipeline_id: PIPELINE, stage_id: ETAPA_GANHO, title: "Venda fechada" }],
    ["crm_send_whatsapp_message", { conversation_id: LEAD, type: "document", media_url: "https://www.mercadopago.com.br/boleto/123.pdf" }],
    ["crm_send_whatsapp_message", { conversation_id: LEAD, type: "image", media_url: "https://cdn.exemplo.com/a.png", body: "Pix copia e cola: 00020126580014br.gov.bcb.pix0136abc" }],
    ["crm_send_whatsapp_message", { conversation_id: LEAD, body: "Segue: https://minhaloja.com.br/x" }],
    ["crm_disparo_ajustar_ritmo", { modelos: { abertura: ["Oi {nome}", "Hoje sai por R$ 297"] } }],
    ["crm_update_lead", { lead_id: LEAD, value_cents: 19700 }],
    ["crm_move_lead_stage", { lead_id: LEAD, to_stage_id: ETAPA_GANHO }],
    // Marcar uma etapa como de ganho é fechar pelo funil: os negócios que estão nela passam a contar como venda.
    ["crm_update_stage", { pipeline_id: PIPELINE, stage_id: ETAPA_GANHO, is_won: true }],
    ["crm_send_whatsapp_message", { conversation_id: LEAD, body: "Fica 197 reais no pix" }],
    ["crm_send_whatsapp_message", { conversation_id: LEAD, body: "Paga aqui: https://checkout.exemplo.com/abc" }],
  ])("%s recusa com a frase do dono e a recusa fica no histórico", async (ferramenta, args) => {
    const r = await chamar(authDoAgente("admin"), ferramenta, args);
    expect(r.erro).toBe(true);
    expect(r.texto).toBe(MENSAGEM_DE_FECHAMENTO_HUMANO);
    expect(MENSAGEM_DE_FECHAMENTO_HUMANO).toBe("Fechamento é com uma pessoa da equipe: crie uma tarefa para ela.");
    const registro = chamadasDaFerramenta().at(-1)!;
    expect(registro.metadata).toMatchObject({
      tool_name: ferramenta,
      success: false,
      error: MENSAGEM_DE_FECHAMENTO_HUMANO,
      agente_externo: { id: AGENTE, nome: "Head" },
    });
    expect(banco.escritas).toHaveLength(0);
  });
});

describe("etapa de ganho pelo agente", () => {
  it("só marcar is_won: true é recusado; renomear, reordenar ou tirar a marca seguem a regra da ferramenta", async () => {
    const contexto = { supabase: banco.cliente as never, organizationId: ORG };
    expect(await recusaDeFechamento("crm_update_stage", { pipeline_id: PIPELINE, stage_id: ETAPA_GANHO, is_won: true }, contexto)).toBe(
      MENSAGEM_DE_FECHAMENTO_HUMANO,
    );
    for (const args of [{ name: "Fechado" }, { is_won: false }, { is_lost: true }, { after_stage_id: null }]) {
      expect(await recusaDeFechamento("crm_update_stage", { pipeline_id: PIPELINE, stage_id: ETAPA_GANHO, ...args }, contexto)).toBeNull();
    }
  });
});

describe("catálogo e compras sem preço", () => {
  it("as compras do cliente chegam ao agente sem valor, com o aviso", async () => {
    const r = await chamar(authDoAgente("admin"), "crm_list_contact_orders", { contact_id: LEAD });
    expect(r.erro).toBe(false);
    const corpo = JSON.parse(r.texto) as { pedidos: Record<string, unknown>[]; aviso_de_preco: string };
    expect(corpo.pedidos).toHaveLength(1);
    expect(corpo.pedidos[0]).toMatchObject({ id: "o1", status: "paid" });
    expect(r.texto).not.toMatch(/29700|total_cents/);
    expect(corpo.aviso_de_preco).toMatch(/equipe/);
  });
});

describe("palavras proibidas do motor pelo agente", () => {
  it("acrescentar pode; tirar não", async () => {
    const mais = await chamar(authDoAgente("admin"), "crm_disparo_ajustar_ritmo", {
      proibidos: [
        { padrao: "frete gr[aá]tis", motivo: "promessa" },
        { padrao: "garantido", motivo: "promessa" },
      ],
    });
    expect(JSON.parse(mais.texto)).toMatchObject({ ok: true });
    expect((banco.linhas("disparo_config")[0]!.proibidos as unknown[]).length).toBe(2);

    const menos = await chamar(authDoAgente("admin"), "crm_disparo_ajustar_ritmo", { proibidos: [] });
    expect(menos.erro).toBe(true);
    expect(menos.texto).toBe(MENSAGEM_PROIBIDO_NAO_SAI);
    expect((banco.linhas("disparo_config")[0]!.proibidos as unknown[]).length).toBe(2);
  });

  it("manter o padrão e afrouxar a regra (excetoUltimo ligado, motivo trocado) também é tirar", async () => {
    for (const regra of [
      { padrao: "frete gr[aá]tis", motivo: "promessa", excetoUltimo: true },
      { padrao: "frete gr[aá]tis", motivo: "outro motivo" },
    ]) {
      const r = await chamar(authDoAgente("admin"), "crm_disparo_ajustar_ritmo", { proibidos: [regra] });
      expect(r.erro).toBe(true);
      expect(r.texto).toBe(MENSAGEM_PROIBIDO_NAO_SAI);
    }
    expect(banco.linhas("disparo_config")[0]!.proibidos).toEqual([{ padrao: "frete gr[aá]tis", motivo: "promessa" }]);
  });
});

describe("tarefa pelo agente", () => {
  it("vínculo de outra organização é recusado e nada é gravado", async () => {
    const r = await chamar(authDoAgente("agent"), "crm_create_task", { titulo: "Fechar a venda", lead_id: LEAD_DA_OUTRA });
    expect(JSON.parse(r.texto)).toMatchObject({ criada: false, motivo: "vinculo_inexistente" });
    expect(banco.linhas("crm_tasks")).toHaveLength(0);
  });
});

describe("chave do motor por agente", () => {
  it("token de IA sem cadastro na equipe não opera o motor", async () => {
    const r = await chamar({ ...authDoAgente("admin"), agenteExterno: null }, "crm_disparo_estado");
    expect(r.erro).toBe(true);
    expect(r.texto).toBe(MENSAGEM_SEM_MOTOR);
  });

  it("pode_motor = false recusa a ferramenta do motor mesmo com papel admin", async () => {
    const r = await chamar(authDoAgente("admin", false), "crm_disparo_pausar_chip", { chip_id: CHIP });
    expect(r.erro).toBe(true);
    expect(r.texto).toBe(MENSAGEM_SEM_MOTOR);
    expect(banco.linhas("disparo_chips")[0]?.estado).toBe("ativo");
  });

  it("pausar o chip pelo MCP grava e audita com o agente como autor", async () => {
    const r = await chamar(authDoAgente("admin"), "crm_disparo_pausar_chip", { chip_id: CHIP });
    expect(JSON.parse(r.texto)).toMatchObject({ ok: true, estado: "pausado" });
    expect(banco.linhas("disparo_chips")[0]?.estado).toBe("pausado");
    const mudanca = vi.mocked(audit).mock.calls.map((c) => c[0]).find((e) => e.action === "disparo.config_atualizada");
    expect(mudanca).toMatchObject({
      actorUserId: null,
      actorApiTokenId: TOKEN,
      metadata: { operacao: "pausar_chip", autor: { tipo: "agente_externo", id: AGENTE, nome: "Head" } },
    });
  });

  it("pausar o motor pelo MCP emite motor.parou", async () => {
    await chamar(authDoAgente("admin"), "crm_disparo_pausar_motor");
    expect(banco.linhas("disparo_config")[0]?.ligado).toBe(false);
    expect(banco.rpcs.map((r) => r.args.p_event_type)).toContain("motor.parou");
  });

  it("trocar o modo exige admin; o manager é recusado e nada muda", async () => {
    const r = await chamar(authDoAgente("manager"), "crm_disparo_trocar_modo", { modo: "real" });
    expect(r.erro).toBe(true);
    expect(banco.linhas("disparo_config")[0]?.modo).toBe("simulado");
  });
});

describe("as validações da tela do motor valem para o agente", () => {
  it("imagem da abertura: vídeo e imagem de outra organização recusados com o campo; imagem da organização aceita", async () => {
    for (const id of [VIDEO, IMAGEM_DA_OUTRA]) {
      const r = JSON.parse((await chamar(authDoAgente("admin"), "crm_disparo_ajustar_ritmo", { ritmo: { aberturaMidiaId: id } })).texto) as {
        ok: boolean;
        mensagem: string;
        detalhes: { campos: { caminho: string }[] };
      };
      expect(r.ok).toBe(false);
      expect(r.mensagem).toBe(ABERTURA_SO_IMAGEM);
      expect(r.detalhes.campos[0]!.caminho).toBe("ritmo.aberturaMidiaId");
    }
    expect(banco.escritas).toHaveLength(0);
    const ok = JSON.parse((await chamar(authDoAgente("admin"), "crm_disparo_ajustar_ritmo", { ritmo: { aberturaMidiaId: IMAGEM } })).texto);
    expect(ok).toMatchObject({ ok: true });
  });

  it("mescla profunda: mudar um subcampo de uma seção não apaga os irmãos", async () => {
    banco.linhas("disparo_config")[0]!.ritmo = { saude: { horasSemEntrega: 8, bloqueio: { amarelo: 0.03, vermelho: 0.06 } } };
    await chamar(authDoAgente("admin"), "crm_disparo_ajustar_ritmo", { ritmo: { saude: { bloqueio: { amarelo: 0.04 } } } });
    expect(banco.linhas("disparo_config")[0]!.ritmo).toEqual({ saude: { horasSemEntrega: 8, bloqueio: { amarelo: 0.04, vermelho: 0.06 } } });
  });

  it("corpo inválido volta com o caminho do campo (details.campos), como na tela", async () => {
    const r = JSON.parse((await chamar(authDoAgente("admin"), "crm_disparo_ajustar_ritmo", { ritmo: { maxEnviosHora: 999 } })).texto);
    expect(r.detalhes.campos.map((c: { caminho: string }) => c.caminho)).toContain("ritmo.maxEnviosHora");
  });

  it("retomar chip retirado no meio (UPDATE condicionado) é 409", async () => {
    banco.linhas("disparo_chips")[0]!.estado = "pausado";
    // O chip some do motor entre a leitura e a escrita: o UPDATE condicionado não acha linha.
    const original = banco.cliente.from;
    banco.cliente.from = (t: string) => {
      const q = original(t) as { update: (v: unknown) => unknown };
      if (t === "disparo_chips") {
        const update = q.update.bind(q);
        q.update = (v: unknown) => {
          banco.linhas("disparo_chips")[0]!.estado = "desligado";
          return update(v);
        };
      }
      return q as never;
    };
    const r = JSON.parse((await chamar(authDoAgente("admin"), "crm_disparo_retomar_chip", { chip_id: CHIP })).texto);
    expect(r).toMatchObject({ ok: false, motivo: "state_conflict" });
    expect(banco.linhas("disparo_chips")[0]!.estado).toBe("desligado");
  });
});

describe("ajuste de ritmo inválido", () => {
  it("o MCP recusa com a mesma mensagem da tela", async () => {
    const corpo = { ritmo: { maxEnviosHora: 999 } };
    const r = await chamar(authDoAgente("admin"), "crm_disparo_ajustar_ritmo", corpo);
    const doMcp = JSON.parse(r.texto) as { ok: boolean; mensagem: string };
    expect(doMcp.ok).toBe(false);

    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    } as never);
    const { PATCH } = await import("@/app/api/v1/disparo/config/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/v1/disparo/config", {
        method: "PATCH",
        body: JSON.stringify(corpo),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(422);
    const daTela = ((await res.json()) as { error: { message: string } }).error.message;
    expect(doMcp.mensagem).toBe(daTela);
    expect(banco.escritas).toHaveLength(0);
  });
});
