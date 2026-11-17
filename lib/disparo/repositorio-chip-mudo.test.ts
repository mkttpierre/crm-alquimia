/**
 * E3 e E4 no repositório do Supabase, contra um cliente falso com fila de respostas por tabela: o que a conta do chip
 * mudo lê (só envio real, com external_id), a leitura da fila presa (situação dos chips, vencidos por chip) e o aviso
 * vivo (um aberto por prefixo, atualizado no lugar, fechado sem apagar).
 * (O SQL em si é do `test:db`.)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { repositorioSupabase } from "./repositorio-supabase";

const ORG = "00000000-0000-4000-8000-0000000000a3";
const AGORA = new Date("2026-11-10T15:00:00Z");

type Resp = { data: unknown; error?: { message: string } | null };

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

describe("enviosRecentesDoChip", () => {
  it("lê só envio real do chip, com external_id, do mais novo ao mais antigo, e traduz os acks", async () => {
    const { db, chamadas } = dbEmFila({
      disparo_envios: [{ data: [{ enviado_em: "2026-11-10T14:00:00Z", ack: null, entregue_em: null, lido_em: null }, { enviado_em: "2026-11-10T13:00:00Z", ack: 2, entregue_em: "2026-11-10T13:00:05Z", lido_em: null }] }],
    });
    const r = await repositorioSupabase(db).enviosRecentesDoChip!(ORG, "chip-1", new Date(AGORA.getTime() - 3600_000), 100);
    expect(r).toEqual([
      { enviadoEm: new Date("2026-11-10T14:00:00Z"), ack: null, entregueEm: null, lidoEm: null },
      { enviadoEm: new Date("2026-11-10T13:00:00Z"), ack: 2, entregueEm: new Date("2026-11-10T13:00:05Z"), lidoEm: null },
    ]);
    const p = chamadas[0]!.passos;
    expect(p).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(p).toContainEqual(["eq", ["chip_id", "chip-1"]]);
    expect(p).toContainEqual(["eq", ["estado", "enviado"]]);
    expect(p).toContainEqual(["not", ["external_id", "is", null]]);
    expect(p).toContainEqual(["order", ["enviado_em", { ascending: false }]]);
  });
});

describe("E4: situação dos chips e fila vencida (só leitura)", () => {
  it("todos os chips da organização, com a conexão de cada um (arquivada conta como parada; sem sessão = null)", async () => {
    const { db, chamadas } = dbEmFila({
      disparo_chips: [{ data: [
        { id: "c1", nome: "chip-gama", estado: "rampa", saude: "vermelho", pausado_ate: "2026-11-12T00:00:00Z", channel_session_id: "s1" },
        { id: "c2", nome: "chip-frio", estado: "desligado", saude: "verde", pausado_ate: null, channel_session_id: "s2" },
        { id: "c3", nome: "ficticio", estado: "desligado", saude: "verde", pausado_ate: null, channel_session_id: null },
      ] }],
      channel_sessions: [{ data: [{ id: "s1", status: "STOPPED", archived_at: null }, { id: "s2", status: "WORKING", archived_at: "2026-11-01T00:00:00Z" }] }],
    });
    const r = await repositorioSupabase(db).situacaoDosChips!(ORG);
    expect(r.map((c) => [c.nome, c.conexao])).toEqual([["chip-gama", "STOPPED"], ["chip-frio", "ARQUIVADA"], ["ficticio", null]]);
    expect(r[0]!.pausadoAte).toEqual(new Date("2026-11-12T00:00:00Z"));
    expect(chamadas[0]!.passos).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(chamadas[0]!.passos.some(([n]) => n === "in")).toBe(false); // todos os estados, não só os da volta
    expect(chamadas[1]!.passos).toContainEqual(["eq", ["organization_id", ORG]]);
  });

  it("vencidos do chip: só `pendente`, fora lembretes, com enviar_apos já passado; nada é escrito", async () => {
    const { db, chamadas } = dbEmFila({ disparo_envios: [{ data: null }, { data: { enviar_apos: "2026-11-05T13:05:00Z" } }] });
    const r = await repositorioSupabase(db).vencidosDoChip!(ORG, "c1", AGORA);
    expect(r.desde).toEqual(new Date("2026-11-05T13:05:00Z"));
    for (const c of chamadas) {
      expect(c.passos).toContainEqual(["eq", ["organization_id", ORG]]);
      expect(c.passos).toContainEqual(["eq", ["chip_id", "c1"]]);
      expect(c.passos).toContainEqual(["eq", ["estado", "pendente"]]);
      expect(c.passos).toContainEqual(["neq", ["origem", "lembrete"]]);
      expect(c.passos).toContainEqual(["lte", ["enviar_apos", AGORA.toISOString()]]);
      expect(c.passos.some(([n]) => ["update", "insert", "delete", "upsert"].includes(n))).toBe(false);
    }
  });
});

describe("E2: saidaNaConversa (conferência antes de reenviar, só leitura)", () => {
  const desde = new Date("2026-11-10T12:00:00Z");

  it("procura saída para o contato do lead, com o mesmo corpo, desde a criação do envio; devolve o id simples", async () => {
    const { db, chamadas } = dbEmFila({
      crm_leads: [{ data: { contact_id: "ct-1" } }],
      messages: [{ data: { external_id: "true_5511999990000@c.us_3EB0ABC", created_at: "2026-11-10T13:00:01Z", sent_at: "2026-11-10T13:00:00Z" } }],
    });
    const r = await repositorioSupabase(db).saidaNaConversa!(ORG, "l1", { texto: "  Oi Maria  ", soMidia: false, desde });
    expect(r).toEqual({ externalId: "3EB0ABC", em: new Date("2026-11-10T13:00:00Z") });
    const p = chamadas[1]!.passos;
    expect(p).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(p).toContainEqual(["eq", ["contact_id", "ct-1"]]);
    expect(p).toContainEqual(["eq", ["direction", "outbound"]]);
    expect(p).toContainEqual(["eq", ["body", "Oi Maria"]]);
    expect(p).toContainEqual(["gte", ["created_at", desde.toISOString()]]);
    expect(chamadas.flatMap((c) => c.passos).some(([n]) => ["update", "insert", "delete", "upsert"].includes(n))).toBe(false);
  });

  it("mídia sem legenda: qualquer mídia que saiu depois conta", async () => {
    const { db, chamadas } = dbEmFila({ crm_leads: [{ data: { contact_id: "ct-1" } }], messages: [{ data: null }] });
    expect(await repositorioSupabase(db).saidaNaConversa!(ORG, "l1", { texto: "", soMidia: true, desde })).toBeNull();
    expect(chamadas[1]!.passos.some(([n, a]) => n === "in" && a[0] === "type")).toBe(true);
    expect(chamadas[1]!.passos.some(([n, a]) => n === "eq" && a[0] === "body")).toBe(false);
  });

  it("erro na consulta LANÇA (o motor não reenvia nesta volta), nunca vira 'não achou'", async () => {
    const { db } = dbEmFila({ crm_leads: [{ data: { contact_id: "ct-1" } }], messages: [{ data: null, error: { message: "timeout" } }] });
    await expect(repositorioSupabase(db).saidaNaConversa!(ORG, "l1", { texto: "x", soMidia: false, desde })).rejects.toThrow(/saida_na_conversa/);
  });
});

describe("aviso vivo", () => {
  const chave = { prefixo: "Disparo: chip sem confirmação de entrega (chip_1)", chipId: "chip-1" };

  it("acha o aberto e o último pelo prefixo do título (com `_` escapado), sempre na organização", async () => {
    const { db, chamadas } = dbEmFila({
      agent_inbox_items: [
        { data: { id: "a1", title: "t", body: "c", created_at: "2026-11-10T12:00:00Z" } },
        { data: { id: "a1", title: "t", body: "c", created_at: "2026-11-10T12:00:00Z" } },
      ],
    });
    const r = await repositorioSupabase(db).avisoVivo!(ORG, chave);
    expect(r.aberto).toEqual({ id: "a1", titulo: "t", corpo: "c", criadoEm: new Date("2026-11-10T12:00:00Z") });
    expect(r.ultimoEm).toEqual(new Date("2026-11-10T12:00:00Z"));
    for (const c of chamadas) {
      expect(c.passos).toContainEqual(["eq", ["organization_id", ORG]]);
      expect(c.passos).toContainEqual(["like", ["title", "Disparo: chip sem confirmação de entrega (chip\\_1)%"]]);
    }
    expect(chamadas[0]!.passos).toContainEqual(["eq", ["status", "open"]]);
  });

  it("sem aberto, cria um com o instante da volta; com aberto, atualiza o mesmo (não empilha)", async () => {
    const novo = dbEmFila({ agent_inbox_items: [{ data: null }, { data: null }] });
    await repositorioSupabase(novo.db).gravarAvisoVivo!(ORG, chave, { titulo: "T", corpo: "C", nivel: "critical" }, AGORA);
    expect(novo.chamadas[1]!.passos[0]).toEqual(["insert", [expect.objectContaining({ organization_id: ORG, kind: "other", title: "T", body: "C", severity: "critical", created_at: AGORA.toISOString() })]]);

    const existente = dbEmFila({ agent_inbox_items: [{ data: { id: "a1" } }, { data: null }] });
    await repositorioSupabase(existente.db).gravarAvisoVivo!(ORG, chave, { titulo: "T2", corpo: "C2", nivel: "critical" }, AGORA);
    expect(existente.chamadas[1]!.passos[0]).toEqual(["update", [{ title: "T2", body: "C2", severity: "critical" }]]);
    expect(existente.chamadas[1]!.passos).toContainEqual(["eq", ["id", "a1"]]);
  });

  it("fechar = `resolved` com a hora, só os abertos do prefixo (nunca apaga)", async () => {
    const { db, chamadas } = dbEmFila({ agent_inbox_items: [{ data: null }] });
    await repositorioSupabase(db).gravarAvisoVivo!(ORG, chave, null, AGORA);
    expect(chamadas[0]!.passos[0]).toEqual(["update", [{ status: "resolved", resolved_at: AGORA.toISOString() }]]);
    expect(chamadas[0]!.passos).toContainEqual(["eq", ["status", "open"]]);
    expect(chamadas[0]!.passos.some(([n]) => n === "delete")).toBe(false);
  });
});
