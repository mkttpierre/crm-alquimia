// @vitest-environment node
/**
 * Presença, `conversa.esperando`, o bloco de conexão e o guia.
 *
 *   - presença: no máximo UMA escrita a cada 30 s por agente;
 *   - `conversa.esperando`: uma vez por conversa por espera — rodar o cron duas vezes não avisa duas vezes; o cliente
 *     escrever de novo depois de respondido abre outra espera, que avisa; grupo e organização sem assinatura, nunca;
 *   - o bloco de conexão de cada atalho;
 *   - o guia servido pelo MCP é cópia fiel de `docs/agentes-externos.md`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { blocoDeConexao } from "@/lib/agentes-externos/conexao";
import { avisarConversasEsperando, minutosDeEspera, podarEsperasAvisadas } from "@/lib/agentes-externos/esperando";
import { GUIA_DO_AGENTE_EXTERNO } from "@/lib/agentes-externos/guia";
import {
  TETO_DA_MEMORIA_DE_PRESENCA,
  esquecerPresencasParaTeste,
  registrarPresenca,
  tamanhoDaMemoriaDePresenca,
} from "@/lib/agentes-externos/presenca";
import { falaDePrecoOuPagamento, linkDePagamento } from "@/lib/mcp/fechamento-humano";
import { bancoDuble } from "@/tests/helpers/disparo-db-double";

const ORG = "22222222-2222-4222-8222-222222222222";
const SEM_REGRA = "33333333-3333-4333-8333-333333333333";
const TOKEN = "44444444-4444-4444-8444-444444444444";

describe("presença do agente", () => {
  beforeEach(() => esquecerPresencasParaTeste());

  it("grava no máximo uma vez a cada 30 s", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const admin = { rpc } as never;
    const t0 = new Date("2026-11-13T12:00:00Z");
    const em = (s: number) => new Date(t0.getTime() + s * 1000);

    expect(await registrarPresenca(admin, TOKEN, "crm_list_tasks", em(0))).toBe(true);
    expect(await registrarPresenca(admin, TOKEN, "crm_disparo_estado", em(5))).toBe(false);
    expect(await registrarPresenca(admin, TOKEN, "crm_disparo_fila", em(29))).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await registrarPresenca(admin, TOKEN, "crm_disparo_chips", em(30))).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    // A ação gravada é o NOME da ferramenta, e quem decide de verdade é a função do banco (0256).
    expect(rpc).toHaveBeenLastCalledWith("fn_marcar_uso_do_agente_externo", {
      p_api_token_id: TOKEN,
      p_acao: "crm_disparo_chips",
    });
  });

  it("cada agente tem a sua janela, e erro do banco não lança", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "fora do ar" } }));
    const agora = new Date();
    expect(await registrarPresenca({ rpc } as never, "a", "x", agora)).toBe(false);
    expect(await registrarPresenca({ rpc } as never, "b", "x", agora)).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("conversa.esperando", () => {
  const AGORA = new Date("2026-11-13T15:00:00Z");
  const minutosAtras = (m: number) => new Date(AGORA.getTime() - m * 60_000).toISOString();
  const conversa = (id: string, org: string, extra: Record<string, unknown>) => ({
    id,
    organization_id: org,
    contact_id: `c-${id}`,
    assigned_to_user_id: null,
    status: "open",
    is_group: false,
    last_outbound_at: null,
    ...extra,
  });

  function montar() {
    return bancoDuble({
      automation_rules: [{ id: "r1", organization_id: ORG, trigger_event: "conversa.esperando", is_active: true }],
      organizations: [
        { id: ORG, settings: {} },
        { id: SEM_REGRA, settings: {} },
      ],
      conversations: [
        conversa("esperando-20", ORG, { last_inbound_at: minutosAtras(20) }),
        conversa("respondida", ORG, { last_inbound_at: minutosAtras(40), last_outbound_at: minutosAtras(30) }),
        conversa("recente", ORG, { last_inbound_at: minutosAtras(5) }),
        conversa("grupo", ORG, { last_inbound_at: minutosAtras(60), is_group: true }),
        conversa("fechada", ORG, { last_inbound_at: minutosAtras(60), status: "closed" }),
        conversa("velha", ORG, { last_inbound_at: minutosAtras(60 * 30) }),
        conversa("de-quem-nao-assina", SEM_REGRA, { last_inbound_at: minutosAtras(60) }),
      ],
    });
  }
  const eventos = (b: ReturnType<typeof bancoDuble>) => b.rpcs.filter((r) => r.args.p_event_type === "conversa.esperando");

  it("dispara uma vez por conversa por espera, só onde alguém assina, nunca para grupo", async () => {
    const banco = montar();
    const primeira = await avisarConversasEsperando(banco.cliente as never, AGORA);
    expect(primeira).toMatchObject({ avisadas: 1, organizacoes: 1, falhas: [] });
    expect(eventos(banco).map((e) => e.args.p_entity_id)).toEqual(["esperando-20"]);
    expect(eventos(banco)[0]!.args).toMatchObject({
      p_organization_id: ORG,
      p_entity_kind: "conversation",
      p_payload: { contact_id: "c-esperando-20", minutos_esperando: 20, limite_minutos: 15 },
    });

    // A mesma espera, cinco minutos depois: não avisa de novo.
    const segunda = await avisarConversasEsperando(banco.cliente as never, new Date(AGORA.getTime() + 5 * 60_000));
    expect(segunda.avisadas).toBe(0);
    expect(eventos(banco)).toHaveLength(1);

    // Alguém respondeu e o cliente escreveu de novo: é OUTRA espera, e ela avisa quando passar do limite.
    const linha = banco.linhas("conversations").find((c) => c.id === "esperando-20")!;
    linha.last_outbound_at = minutosAtras(-1);
    linha.last_inbound_at = minutosAtras(-2);
    const depois = new Date(AGORA.getTime() + 20 * 60_000);
    // Nesta rodada a "recente" (5 min às 15h) também passou do limite: é a primeira espera DELA.
    expect((await avisarConversasEsperando(banco.cliente as never, depois)).avisadas).toBe(2);
    expect(eventos(banco).filter((e) => e.args.p_entity_id === "esperando-20")).toHaveLength(2);
    expect(eventos(banco).filter((e) => e.args.p_entity_id === "recente")).toHaveLength(1);
  });

  it("o N vem da organização (1 a 1440), senão 15", () => {
    expect(minutosDeEspera({ agentes_externos: { minutos_conversa_esperando: 30 } })).toBe(30);
    expect(minutosDeEspera({ agentes_externos: { minutos_conversa_esperando: 0 } })).toBe(15);
    expect(minutosDeEspera(null)).toBe(15);
  });

  it("organização sem regra assinando o evento não gera evento nenhum", async () => {
    const banco = montar();
    banco.linhas("automation_rules")[0]!.is_active = false;
    expect((await avisarConversasEsperando(banco.cliente as never, AGORA)).avisadas).toBe(0);
    expect(banco.rpcs).toHaveLength(0);
  });
});

describe("preço e pagamento: o detector é ESTREITO", () => {
  it.each([
    "R$ 297",
    "fica 297 reais",
    "manda a chave pix que eu pago",
    "Pix copia e cola abaixo",
    "34191.79001 01043.510047 91020.150008 1 96610000029700",
    "34191790010104351004791020150008196610000029700",
    "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR",
    "paga em https://www.mercadopago.com.br/checkout/v1/redirect?x=1",
    "https://link.mercadopago.com.br/loja",
    "acesse https://checkout.dominio.com/abc",
    "acesse https://dominio.com/pagar/123",
    "https://minhaloja.com.br/x",
    // Sem esquema nem www, e linha digitável com número na frente
    "paga aqui: mpago.la/abc",
    "link pag.ae/x",
    "nubank.com.br/pagar/123",
    "minhaloja.com.br/x",
    "Pedido 1234 34191.79001 01043.510047 91020.150008 1 96610000029700",
  ])("%s é recusado", (texto) => expect(falaDePrecoOuPagamento(texto, ["minhaloja.com.br"])).toBe(true));

  it.each([
    "posso pagar no boleto?",
    "o boleto vence amanhã",
    "tenho 1,75 m",
    "tomo 2,50 mg por dia",
    "Oi, tudo bem? Posso te ligar às 14h?",
    "veja https://boston.com/noticia",
    "https://button.com",
    "https://pixabay.com/foto",
    "https://empresa.com/payroll",
    "https://empresa.com/pixel",
    // Texto comum sem esquema não vira link
    "obs.: ok",
    "Fim do atendimento.Obrigado pela visita",
    "meu e-mail é joao@pagar.me",
    "site.com.br/contato",
    "Pedido 1234 e CEP 01310-100",
  ])("%s passa", (texto) => expect(falaDePrecoOuPagamento(texto)).toBe(false));

  it("mídia: o link do arquivo também é olhado", () => {
    expect(linkDePagamento("https://pay.hotmart.com/X123")).toBe(true);
    expect(linkDePagamento("https://cdn.exemplo.com/catalogo.pdf")).toBe(false);
    // Percent malformado não lança: sem host de pagamento, não é link de pagamento; com host, continua sendo.
    expect(() => linkDePagamento("https://exemplo.com/%E0%A4%A")).not.toThrow();
    expect(linkDePagamento("https://exemplo.com/%E0%A4%A")).toBe(false);
    expect(linkDePagamento("https://mpago.la/%E0%A4%A")).toBe(true);
  });
});

describe("memória da presença", () => {
  beforeEach(() => esquecerPresencasParaTeste());
  it("tem teto: passa de 1.000 tokens e o mais antigo sai", async () => {
    const admin = { rpc: async () => ({ data: true, error: null }) } as never;
    const agora = new Date();
    for (let i = 0; i < TETO_DA_MEMORIA_DE_PRESENCA + 5; i += 1) await registrarPresenca(admin, `t${i}`, "x", agora);
    expect(tamanhoDaMemoriaDePresenca()).toBe(TETO_DA_MEMORIA_DE_PRESENCA);
    // O primeiro saiu: ele grava de novo mesmo dentro dos 30 s; o mais recente, não.
    expect(await registrarPresenca(admin, "t0", "x", agora)).toBe(true);
    expect(await registrarPresenca(admin, `t${TETO_DA_MEMORIA_DE_PRESENCA + 4}`, "x", agora)).toBe(false);
  });
});

describe("retenção das travas de conversa esperando", () => {
  it("o data-retention apaga as de mais de 30 dias e só elas", async () => {
    const agora = new Date("2026-12-31T12:00:00Z");
    const banco = bancoDuble({
      conversa_esperas_avisadas: [
        { organization_id: ORG, conversation_id: "a", desde: "x", avisado_em: "2026-11-01T00:00:00.000Z" },
        { organization_id: ORG, conversation_id: "b", desde: "y", avisado_em: "2026-12-30T00:00:00.000Z" },
      ],
    });
    const cliente = {
      ...banco.cliente,
      from: (t: string) => {
        const q = banco.cliente.from(t) as Record<string, unknown>;
        // O dublê não tem delete: apaga as linhas que casarem o filtro de data.
        q.delete = () => ({
          lt: (_c: string, limite: string) => ({
            select: async () => {
              const todas = banco.linhas(t);
              const fora = todas.filter((l) => (l.avisado_em as string) < limite);
              banco.tabelas[t] = todas.filter((l) => !fora.includes(l));
              return { data: fora, error: null };
            },
          }),
        });
        return q;
      },
    };
    expect(await podarEsperasAvisadas(cliente as never, agora)).toBe(1);
    expect(banco.linhas("conversa_esperas_avisadas").map((l) => l.conversation_id)).toEqual(["b"]);
  });
});

describe("bloco de conexão por atalho", () => {
  const APP = "https://crm.exemplo.com/";
  it("OpenBot e Claude Code: mcpServers http com a URL e o Bearer", () => {
    for (const tipo of ["openbot", "claude_code"] as const) {
      expect(JSON.parse(blocoDeConexao(tipo, APP, "dsk_x"))).toEqual({
        mcpServers: {
          "crm-alquimia": { type: "http", url: "https://crm.exemplo.com/api/mcp", headers: { Authorization: "Bearer dsk_x" } },
        },
      });
    }
  });
  it("Codex: config.toml com a URL e o token numa variável de ambiente", () => {
    const bloco = blocoDeConexao("codex", APP, "dsk_x");
    expect(bloco).toContain("[mcp_servers.crm-alquimia]");
    expect(bloco).toContain('url = "https://crm.exemplo.com/api/mcp"');
    expect(bloco).toContain('bearer_token_env_var = "CRM_ALQUIMIA_TOKEN"');
    expect(bloco).toContain('export CRM_ALQUIMIA_TOKEN="dsk_x"');
  });
  it("Outro: URL e header; sem token, o marcador", () => {
    expect(blocoDeConexao("outro", APP)).toBe("URL: https://crm.exemplo.com/api/mcp\nHeader: Authorization: Bearer <token>");
  });
});

describe("o guia do agente", () => {
  it("é cópia fiel de docs/agentes-externos.md e traz as regras", () => {
    const fonte = readFileSync(join(__dirname, "..", "..", "docs", "agentes-externos.md"), "utf8");
    expect(GUIA_DO_AGENTE_EXTERNO).toBe(fonte);
    expect(GUIA_DO_AGENTE_EXTERNO).toContain("Fechamento é com uma pessoa da equipe: crie uma tarefa para ela.");
    expect(GUIA_DO_AGENTE_EXTERNO).toContain("DISPARO_REAL_LIBERADO=sim");
  });
});
