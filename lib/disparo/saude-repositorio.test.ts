/**
 * O repositório do Supabase nos dois pontos novos, contra um cliente falso com fila de respostas por tabela:
 * a seleção da abertura que respeita quarentena e frequência, e as linhas cruas da conta de saúde.
 * (O SQL em si — constraints, RLS, upsert — é do `test:db`.)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { RITMO_PADRAO } from "./config";
import { repositorioSupabase } from "./repositorio-supabase";
import { H } from "./ritmo";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const AGORA = new Date("2026-10-16T15:00:00Z");
const DIA = 24 * H;

type Resp = { data: unknown; error?: { message: string } | null };

/** Cada `from(tabela)` consome a próxima resposta da fila daquela tabela; guarda os passos para conferir. */
function dbEmFila(filas: Record<string, Resp[]>) {
  const chamadas: { tabela: string; passos: [string, unknown[]][] }[] = [];
  const db = {
    from(tabela: string) {
      const passos: [string, unknown[]][] = [];
      chamadas.push({ tabela, passos });
      const resp = filas[tabela]?.shift() ?? { data: [] };
      const proxy: unknown = new Proxy(
        {},
        {
          get(_a, nome: string) {
            if (nome === "then") return (ok: (v: unknown) => unknown) => ok({ data: resp.data, error: resp.error ?? null, count: null });
            return (...args: unknown[]) => (passos.push([nome, args]), proxy);
          },
        },
      );
      return proxy;
    },
  };
  return { db: db as unknown as SupabaseClient, chamadas };
}

const lead = (id: string) => ({ id, status: "open", custom_fields: {}, contact: { name: id, display_name: id, phone_number: "5511999990000", is_blocked: false, is_anonymized: false } });
const filtro = { quarentena: { cfg: RITMO_PADRAO.quarentena, agora: AGORA } };

describe("proximoLeadParaAbertura com quarentena", () => {
  it("busca primeiro a classe prioritária mesmo quando um frio tem posição anterior", async () => {
    const { db, chamadas } = dbEmFila({ crm_leads: [{ data: [lead("p1")] }], disparo_envios: [{ data: [] }] });
    const r = await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "stage", { classes: ["P1", "frio"] });
    expect(r?.id).toBe("p1");
    expect(chamadas[0]!.passos).toContainEqual(["eq", ["custom_fields->>classe", "P1"]]);
  });
  it("pula o lead em quarentena e fica com o próximo", async () => {
    const { db } = dbEmFila({
      crm_leads: [{ data: [lead("a"), lead("b")] }],
      disparo_envios: [{ data: [] }, { data: [] }],
      disparo_quarentena: [{ data: [{ lead_id: "a", ate: new Date(AGORA.getTime() + 10 * DIA).toISOString() }] }],
    });
    const r = await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "stage", filtro);
    expect(r?.id).toBe("b");
  });

  it("pula quem recebeu abordagem fria nos últimos 30 dias (de qualquer chip) e quem já tem 3 mensagens sem resposta", async () => {
    const recente = new Date(AGORA.getTime() - 10 * DIA).toISOString();
    const { db } = dbEmFila({
      crm_leads: [{ data: [lead("a"), lead("b"), lead("c")] }],
      disparo_envios: [
        { data: [] },
        {
          data: [
            { lead_id: "a", tipo: "abertura", enviado_em: recente },
            { lead_id: "b", tipo: "toque_2", enviado_em: recente },
            { lead_id: "b", tipo: "toque_3", enviado_em: recente },
            { lead_id: "b", tipo: "d2", enviado_em: recente },
          ],
        },
      ],
      disparo_quarentena: [{ data: [] }],
    });
    const r = await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "stage", filtro);
    expect(r?.id).toBe("c");
  });

  it("todos barrados na página: sem lead pronto (null)", async () => {
    const { db } = dbEmFila({
      crm_leads: [{ data: [lead("a")] }],
      disparo_envios: [{ data: [] }, { data: [] }],
      disparo_quarentena: [{ data: [{ lead_id: "a", ate: new Date(AGORA.getTime() + DIA).toISOString() }] }],
    });
    expect(await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "stage", filtro)).toBeNull();
  });

  it("as consultas de quarentena filtram a organização e só olham quarentena ainda vigente", async () => {
    const { db, chamadas } = dbEmFila({ crm_leads: [{ data: [lead("a")] }], disparo_envios: [{ data: [] }, { data: [] }], disparo_quarentena: [{ data: [] }] });
    await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "stage", filtro);
    const q = chamadas.find((c) => c.tabela === "disparo_quarentena")!;
    expect(q.passos).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(q.passos).toContainEqual(["gt", ["ate", AGORA.toISOString()]]);
    const recentes = chamadas.filter((c) => c.tabela === "disparo_envios")[1]!;
    expect(recentes.passos).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(recentes.passos).toContainEqual(["eq", ["origem", "motor"]]);
    expect(recentes.passos).toContainEqual(["gte", ["enviado_em", new Date(AGORA.getTime() - 30 * DIA).toISOString()]]);
  });

  it("sem o filtro de quarentena (organização desligou) não consulta quarentena nenhuma", async () => {
    const { db, chamadas } = dbEmFila({ crm_leads: [{ data: [lead("a")] }], disparo_envios: [{ data: [] }] });
    const r = await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "stage", {});
    expect(r?.id).toBe("a");
    expect(chamadas.some((c) => c.tabela === "disparo_quarentena")).toBe(false);
  });
});

describe("dadosDaSaude: as linhas cruas", () => {
  it("monta aberturas com ack, respostas de gente (sem as automáticas) e a conexão da sessão do chip", async () => {
    const enviado = new Date(AGORA.getTime() - 8 * H).toISOString();
    const { db, chamadas } = dbEmFila({
      disparo_envios: [{ data: [{ lead_id: "l1", estado: "enviado", enviado_em: enviado, ack: 1, entregue_em: null }, { lead_id: "l2", estado: "simulado", enviado_em: enviado, ack: null, entregue_em: null }] }],
      disparo_chips: [{ data: { channel_session_id: "sessao-1" } }],
      crm_leads: [{ data: [{ id: "l1", contact_id: "c1" }, { id: "l2", contact_id: "c2" }] }],
      messages: [
        {
          data: [
            { contact_id: "c1", body: "pare", metadata: null, created_at: AGORA.toISOString() },
            { contact_id: "c2", body: "Seja bem-vindo!", metadata: { automatica: true }, created_at: AGORA.toISOString() },
          ],
        },
      ],
      disparo_eventos_conexao: [{ data: [{ estado: "close", codigo: 428, ocorrido_em: AGORA.toISOString() }] }],
    });
    const desde = new Date(AGORA.getTime() - 3 * H);
    const r = await repositorioSupabase(db).dadosDaSaude!(ORG, "chip-1", { agora: AGORA, desde, janelaDias: 7 });

    expect(r.aberturas).toEqual([
      { leadId: "l1", estado: "enviado", enviadoEm: new Date(enviado), ack: 1, entregueEm: null },
      { leadId: "l2", estado: "simulado", enviadoEm: new Date(enviado), ack: null, entregueEm: null },
    ]);
    expect(r.respostas).toEqual([{ leadId: "l1", texto: "pare", em: AGORA }]);
    expect(r.conexao).toEqual([{ estado: "close", codigo: 428, em: AGORA }]);

    // Tudo escopado por organização e pelo chip; a janela é a mais ampla entre `desde` e `janelaDias`.
    const env = chamadas.find((c) => c.tabela === "disparo_envios")!;
    expect(env.passos).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(env.passos).toContainEqual(["eq", ["chip_id", "chip-1"]]);
    expect(env.passos).toContainEqual(["gte", ["enviado_em", new Date(AGORA.getTime() - 7 * DIA).toISOString()]]);
    const ev = chamadas.find((c) => c.tabela === "disparo_eventos_conexao")!;
    expect(ev.passos).toContainEqual(["eq", ["channel_session_id", "sessao-1"]]);
    expect(ev.passos).toContainEqual(["gte", ["ocorrido_em", desde.toISOString()]]);
  });

  it("chip sem canal: sem eventos de conexão (e sem consultar a tabela)", async () => {
    const { db, chamadas } = dbEmFila({ disparo_envios: [{ data: [] }], disparo_chips: [{ data: { channel_session_id: null } }] });
    const r = await repositorioSupabase(db).dadosDaSaude!(ORG, "chip-1", { agora: AGORA, desde: AGORA, janelaDias: 7 });
    expect(r).toEqual({ aberturas: [], respostas: [], conexao: [] });
    expect(chamadas.some((c) => c.tabela === "disparo_eventos_conexao")).toBe(false);
  });

  it("erro do banco sobe (o motor decide), não vira dado vazio que pareceria verde", async () => {
    const { db } = dbEmFila({ disparo_envios: [{ data: null, error: { message: "boom" } }], disparo_chips: [{ data: null }] });
    await expect(repositorioSupabase(db).dadosDaSaude!(ORG, "chip-1", { agora: AGORA, desde: AGORA, janelaDias: 7 })).rejects.toThrow("disparo_saude_aberturas");
  });
});

describe("semRespostaDesde e entrarEmQuarentena", () => {
  it("conta só as mensagens do motor depois da última resposta do lead", async () => {
    const resposta = new Date(AGORA.getTime() - 5 * DIA).toISOString();
    const { db, chamadas } = dbEmFila({
      crm_leads: [{ data: { contact_id: "c1" } }],
      messages: [{ data: [{ created_at: resposta }] }],
      disparo_envios: [{ data: null }],
    });
    await repositorioSupabase(db).semRespostaDesde!(ORG, "l1", new Date(AGORA.getTime() - 30 * DIA));
    const env = chamadas.find((c) => c.tabela === "disparo_envios")!;
    expect(env.passos).toContainEqual(["gt", ["enviado_em", resposta]]);
    expect(env.passos).toContainEqual(["eq", ["origem", "motor"]]);
  });

  it("a imagem e o fecho da abertura com prévia (abertura_pN) não contam como mensagens a mais", async () => {
    const { db, chamadas } = dbEmFila({ crm_leads: [{ data: { contact_id: null } }], disparo_envios: [{ data: null }] });
    await repositorioSupabase(db).semRespostaDesde!(ORG, "l1", new Date(AGORA.getTime() - 30 * DIA));
    const env = chamadas.find((c) => c.tabela === "disparo_envios")!;
    expect(env.passos).toContainEqual(["not", ["tipo", "like", "abertura_p%"]]);
  });

  it("re-entrar em quarentena não encurta a que já existe", async () => {
    const { db, chamadas } = dbEmFila({ disparo_quarentena: [{ data: { ate: new Date(AGORA.getTime() + 40 * DIA).toISOString() } }] });
    await repositorioSupabase(db).entrarEmQuarentena!(ORG, "l1", "chip-1", new Date(AGORA.getTime() + 10 * DIA));
    expect(chamadas.filter((c) => c.tabela === "disparo_quarentena")).toHaveLength(1);
  });

  it("primeira vez: grava com o fim pedido e o chip", async () => {
    const { db, chamadas } = dbEmFila({ disparo_quarentena: [{ data: null }, { data: null }] });
    const ate = new Date(AGORA.getTime() + 45 * DIA);
    await repositorioSupabase(db).entrarEmQuarentena!(ORG, "l1", "chip-1", ate);
    const grava = chamadas.filter((c) => c.tabela === "disparo_quarentena")[1]!;
    const [linha, opcoes] = grava.passos.find(([k]) => k === "upsert")![1] as [Record<string, unknown>, unknown];
    expect(linha).toMatchObject({ organization_id: ORG, lead_id: "l1", chip_id: "chip-1", ate: ate.toISOString(), motivo: "toques_sem_resposta" });
    expect(opcoes).toEqual({ onConflict: "organization_id,lead_id" });
  });
});

describe("situacaoDoKit (conferência na hora de enviar o follow-up do kit)", () => {
  const ate = new Date(AGORA.getTime() + 5 * DIA).toISOString();
  const leitura = (f: { trilha?: string; conversa?: unknown; atendimento?: unknown; quarentena?: string | null }) =>
    dbEmFila({
      crm_leads: [{ data: { custom_fields: f.trilha ? { trilha: f.trilha } : {} } }],
      disparo_conversas: [{ data: f.conversa ?? null }],
      disparo_config: [{ data: { atendimento: f.atendimento ?? null } }],
      disparo_quarentena: [{ data: f.quarentena ? { ate: f.quarentena } : null }],
    }).db;

  it("lead sem nada: tudo livre", async () => {
    expect(await repositorioSupabase(leitura({})).situacaoDoKit!(ORG, "l1")).toEqual({ cliente: false, metodoPago: false, precisaOperador: false, quarentenaAte: null });
  });

  it("Método pago, marca VIP, precisa_operador e quarentena aparecem", async () => {
    const pago = await repositorioSupabase(leitura({ conversa: { precisa_operador: true, dados: { metodo: { etapa: "pago" } } }, quarentena: ate })).situacaoDoKit!(ORG, "l1");
    expect(pago).toMatchObject({ metodoPago: true, precisaOperador: true, quarentenaAte: new Date(ate) });
    const vip = await repositorioSupabase(leitura({ conversa: { precisa_operador: false, dados: { vipDescontoPct: 10 } } })).situacaoDoKit!(ORG, "l1");
    expect(vip.metodoPago).toBe(true);
  });

  it("erro do banco sobe (o motor não manda no escuro)", async () => {
    const { db } = dbEmFila({ crm_leads: [{ data: null, error: { message: "boom" } }] });
    await expect(repositorioSupabase(db).situacaoDoKit!(ORG, "l1")).rejects.toThrow("kit_lead");
  });
});
