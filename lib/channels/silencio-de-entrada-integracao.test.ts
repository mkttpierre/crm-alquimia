import { describe, expect, it } from "vitest";

import { sincronizarSaudeDaConexao } from "@/lib/channels/health";
import { sincronizarSilencioDeEntrada } from "@/lib/channels/silencio-de-entrada";

/**
 * Integração do alarme de silêncio com o banco (fake): avisa uma vez, resolve
 * quando volta a chegar, não pisa em outro episódio e só grava o episódio depois
 * de o aviso gravar (regra do item 4).
 */

const sp = (dia: number, hhmm: string) => new Date(`2026-11-${String(dia).padStart(2, "0")}T${hhmm}:00-03:00`);
const QUI = 5;
const SAB = 7;

interface Consulta {
  tabela: string;
  op: "select" | "insert" | "update" | "upsert";
  payload?: unknown;
  filtros: Array<[string, ...unknown[]]>;
}

interface Cenario {
  escalated?: string | null;
  /** conversas da sessão (own): last_inbound_at ISO */
  conversas?: string[];
  mensagens7d?: number;
  irmaoAtivo?: boolean;
  insertDoAvisoFalha?: boolean;
  upsertDoEpisodioFalha?: boolean;
  /** já existe um aviso de silêncio aberto desta sessão */
  avisoAberto?: boolean;
}

function banco(c: Cenario) {
  const consultas: Consulta[] = [];
  const admin = {
    from(tabela: string) {
      const nova = (op: Consulta["op"], payload?: unknown) => {
        const q: Consulta = { tabela, op, payload, filtros: [] };
        consultas.push(q);
        const resolver = () => {
          if (op === "insert" && tabela === "agent_inbox_items" && c.insertDoAvisoFalha) {
            return { data: null, error: { message: "db fora" } };
          }
          if (op === "upsert" && c.upsertDoEpisodioFalha) return { data: null, error: { message: "db fora no episodio" } };
          if (op !== "select") return { data: null, error: null };
          const doIrmao = q.filtros.some((f) => f[0] === "in" && f[1] === "channel_session_id");
          if (tabela === "conversations" && doIrmao) {
            return { data: c.irmaoAtivo ? [{ id: "irmao-1" }] : [], error: null };
          }
          if (tabela === "conversations") {
            const lista = (c.conversas ?? []).map((iso, i) => ({ id: `conv-${i}`, last_inbound_at: iso }));
            return { data: lista, error: null };
          }
          if (tabela === "messages") {
            return { data: Array.from({ length: c.mensagens7d ?? 0 }, (_, i) => ({ id: `m-${i}` })), error: null };
          }
          return { data: null, error: null };
        };
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop: string) {
              if (prop === "maybeSingle") {
                return async () => ({
                  data:
                    tabela === "channel_session_health"
                      ? { escalated_status: c.escalated ?? null }
                      : tabela === "agent_inbox_items" && c.avisoAberto
                        ? { id: "aviso-aberto" }
                        : null,
                  error: null,
                });
              }
              if (prop === "then") return (ok: (v: unknown) => unknown) => ok(resolver());
              return (...args: unknown[]) => {
                q.filtros.push([prop, ...args]);
                return proxy;
              };
            },
          },
        );
        return proxy;
      };
      return {
        select: () => nova("select"),
        insert: (p: unknown) => nova("insert", p),
        update: (p: unknown) => nova("update", p),
        upsert: (p: unknown) => nova("upsert", p),
      };
    },
  } as never;
  return { admin, consultas };
}

const sessao = { id: "sess-1", organization_id: "org-1" };
const opcoes = { apelido: "Celular 1", outrasSessoesIds: ["sess-2"], agora: sp(QUI, "12:00") };
const avisos = (cs: Consulta[]) => cs.filter((q) => q.tabela === "agent_inbox_items" && q.op === "insert");
const episodios = (cs: Consulta[]) => cs.filter((q) => q.tabela === "channel_session_health" && q.op === "upsert");

describe("sincronizarSilencioDeEntrada", () => {
  it("histórico + 4 h de silêncio: avisa (warn, sem telefone) e grava o episódio com a referência", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin, consultas } = banco({ conversas: [ultima, ultima, ultima] });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("avisado");

    const [aviso] = avisos(consultas);
    expect(aviso?.payload).toMatchObject({
      organization_id: "org-1",
      kind: "channel_number_alert",
      severity: "warn",
      ref_kind: "channel_session",
      ref_id: "sess-1",
    });
    expect(JSON.stringify(aviso?.payload)).toContain("suspeita");
    expect(episodios(consultas)[0]?.payload).toMatchObject({ escalated_status: `SILENCIO:${ultima}` });
  });

  it("o INSERT do aviso falha: lança e NÃO grava o episódio", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin, consultas } = banco({ conversas: [ultima, ultima, ultima], insertDoAvisoFalha: true });
    await expect(sincronizarSilencioDeEntrada(admin, sessao, opcoes)).rejects.toThrow(/aviso_nao_gravado/);
    expect(episodios(consultas)).toHaveLength(0);
  });

  it("o UPSERT do episódio falha depois do aviso: lança (não 'avisado' calado)", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin } = banco({ conversas: [ultima, ultima, ultima], upsertDoEpisodioFalha: true });
    await expect(sincronizarSilencioDeEntrada(admin, sessao, opcoes)).rejects.toThrow(/episodio_nao_gravado/);
  });

  it("rodada seguinte à marca que não gravou: aviso aberto NÃO é duplicado, e o episódio é gravado", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin, consultas } = banco({ conversas: [ultima, ultima, ultima], avisoAberto: true });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("avisado");
    expect(avisos(consultas)).toHaveLength(0);
    expect(episodios(consultas)[0]?.payload).toMatchObject({ escalated_status: `SILENCIO:${ultima}` });
  });

  it("chip frio (uma entrada antiga, 45 dias) NUNCA avisa por causa do irmão ativo", async () => {
    const antiga = new Date(opcoes.agora.getTime() - 45 * 24 * 3600_000).toISOString();
    const { admin, consultas } = banco({ conversas: [antiga], mensagens7d: 0, irmaoAtivo: true });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("sem_mudanca");
    expect(avisos(consultas)).toHaveLength(0);
  });

  it("chip com ao menos 1 entrada nos últimos 30 dias + irmão ativo ainda avisa", async () => {
    const recente = new Date(opcoes.agora.getTime() - 20 * 24 * 3600_000).toISOString();
    const { admin, consultas } = banco({ conversas: [recente], mensagens7d: 0, irmaoAtivo: true });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("avisado");
    expect(avisos(consultas)).toHaveLength(1);
  });

  it("segunda rodada no mesmo episódio: não avisa de novo", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin, consultas } = banco({ conversas: [ultima, ultima, ultima], escalated: `SILENCIO:${ultima}` });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("ja_avisado");
    expect(avisos(consultas)).toHaveLength(0);
  });

  it("chegou mensagem nova: resolve só o aviso de silêncio desta sessão e zera o episódio", async () => {
    const antiga = sp(QUI, "08:00").toISOString();
    const nova = sp(QUI, "11:30").toISOString();
    const { admin, consultas } = banco({ conversas: [nova, antiga, antiga], escalated: `SILENCIO:${antiga}` });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("resolvido");

    const fecha = consultas.find((q) => q.tabela === "agent_inbox_items" && q.op === "update");
    expect(fecha?.payload).toMatchObject({ status: "resolved" });
    expect(fecha?.filtros).toContainEqual(["eq", "ref_id", "sess-1"]);
    expect(fecha?.filtros).toContainEqual(["eq", "kind", "channel_number_alert"]);
    expect(fecha?.filtros).toContainEqual(["like", "title", "Sem mensagens recebidas em%"]);
    expect(episodios(consultas)[0]?.payload).toMatchObject({ escalated_status: null });
  });

  it("resolve até no sábado, sem nem olhar o horário", async () => {
    const antiga = sp(QUI, "08:00").toISOString();
    const nova = sp(QUI, "15:30").toISOString();
    const { admin } = banco({ conversas: [nova], escalated: `SILENCIO:${antiga}` });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, { ...opcoes, agora: sp(SAB, "10:00") })).toBe("resolvido");
  });

  it("fora do horário e sem episódio: não consulta o banco de mensagens e não avisa", async () => {
    const { admin, consultas } = banco({});
    expect(await sincronizarSilencioDeEntrada(admin, sessao, { ...opcoes, agora: sp(SAB, "10:00") })).toBe("sem_mudanca");
    expect(consultas.filter((q) => q.tabela === "conversations" || q.tabela === "messages")).toHaveLength(0);
  });

  it("não pisa em outro episódio (conexão caída ou empurrão do provedor)", async () => {
    const { admin, consultas } = banco({ escalated: "PUSH:SUSPENSO" });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("ocupado");
    expect(avisos(consultas)).toHaveLength(0);
    expect(episodios(consultas)).toHaveLength(0);
  });

  it("sem histórico e SEM chip irmão ativo: não avisa", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin, consultas } = banco({ conversas: [ultima], mensagens7d: 1, irmaoAtivo: false });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("sem_mudanca");
    expect(avisos(consultas)).toHaveLength(0);
  });

  it("sem histórico mas com chip irmão ativo: avisa", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin, consultas } = banco({ conversas: [ultima], mensagens7d: 1, irmaoAtivo: true });
    expect(await sincronizarSilencioDeEntrada(admin, sessao, opcoes)).toBe("avisado");
    expect(JSON.stringify(avisos(consultas)[0]?.payload)).toContain("outro número");
  });

  it("a consulta de conversas ignora grupo (is_group = false) e é escopada por organização", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin, consultas } = banco({ conversas: [ultima, ultima, ultima] });
    await sincronizarSilencioDeEntrada(admin, sessao, opcoes);
    const q = consultas.find((c) => c.tabela === "conversations");
    expect(q?.filtros).toContainEqual(["eq", "is_group", false]);
    expect(q?.filtros).toContainEqual(["eq", "organization_id", "org-1"]);
  });

  it("reconexão recente zera a contagem: não avisa", async () => {
    const ultima = sp(QUI, "08:00").toISOString();
    const { admin } = banco({ conversas: [ultima, ultima, ultima] });
    const r = await sincronizarSilencioDeEntrada(admin, { ...sessao, desdeEm: sp(QUI, "11:00") }, opcoes);
    expect(r).toBe("sem_mudanca");
  });
});

describe("a saúde da conexão não fecha o episódio de silêncio", () => {
  it("WORKING com episódio SILENCIO aberto: sincronizarSaudeDaConexao deixa como está", async () => {
    const { admin, consultas } = banco({ escalated: "SILENCIO:2026-11-05T11:00:00.000Z" });
    const r = await sincronizarSaudeDaConexao(
      admin,
      { id: "sess-1", organization_id: "org-1", status: "WORKING" },
      { reachable: true, status: "WORKING", detail: null },
      "Celular 1",
    );
    expect(r).toBe("sem_mudanca");
    expect(consultas.filter((q) => q.op === "update" || q.op === "upsert")).toHaveLength(0);
  });
});
