import { describe, expect, it } from "vitest";

import { sincronizarSaudeDaConexao } from "@/lib/channels/health";

/**
 * Item 4 (auditoria 05/11/2026): o INSERT do aviso na Central falhava, e o
 * episódio era gravado como "já escalado" do mesmo jeito. O dedup passava a
 * achar que o operador foi avisado, e a queda ficava sem aviso até o estado
 * mudar. Só se grava o episódio se o aviso foi gravado.
 */

interface Op {
  tabela: string;
  op: string;
  payload?: unknown;
}

function bancoQue(insertDeAvisoFalha: boolean, extra: { upsertFalha?: boolean; avisoAberto?: boolean } = {}) {
  const ops: Op[] = [];
  const chain = (tabela: string, op: string, payload?: unknown) => {
    ops.push({ tabela, op, payload });
    const erro =
      op === "insert" && tabela === "agent_inbox_items" && insertDeAvisoFalha
        ? { message: "db fora" }
        : op === "upsert" && tabela === "channel_session_health" && extra.upsertFalha
          ? { message: "db fora no episodio" }
          : null;
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle") {
            return async () => ({
              data: tabela === "agent_inbox_items" ? (extra.avisoAberto ? { id: "aviso-aberto" } : null) : { escalated_status: null },
              error: null,
            });
          }
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: erro });
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  const admin = {
    from: (t: string) => ({
      select: () => chain(t, "select"),
      insert: (p: unknown) => chain(t, "insert", p),
      update: (p: unknown) => chain(t, "update", p),
      upsert: (p: unknown) => chain(t, "upsert", p),
    }),
  } as never;
  return { admin, ops };
}

const sessao = { id: "sess-1", organization_id: "org-1", status: "FAILED" };
const caiu = { reachable: true, status: "FAILED", detail: null };

describe("aviso que não gravou não vira episódio escalado", () => {
  it("INSERT do aviso falhou → NÃO grava o episódio (a próxima rodada tenta de novo)", async () => {
    const { admin, ops } = bancoQue(true);
    await sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas").catch(() => undefined);
    const episodio = ops.find((o) => o.tabela === "channel_session_health" && o.op === "upsert");
    expect(episodio, "gravou o episódio sem ter gravado o aviso").toBeUndefined();
  });

  it("INSERT do aviso falhou → a falha SOBE (cron registra, webhook é reentregue), nunca 'avisado'", async () => {
    const { admin } = bancoQue(true);
    await expect(sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas")).rejects.toThrow(/aviso_nao_gravado/);
  });

  it("INSERT ok → grava o aviso E o episódio (comportamento de sempre)", async () => {
    const { admin, ops } = bancoQue(false);
    expect(await sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas")).toBe("avisado");
    expect(ops.find((o) => o.tabela === "channel_session_health" && o.op === "upsert")?.payload).toMatchObject({
      escalated_status: "FAILED",
    });
  });

  it("o UPSERT do episódio falha (aviso já gravado): a falha SOBE, não 'avisado' calado", async () => {
    const { admin } = bancoQue(false, { upsertFalha: true });
    await expect(sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas")).rejects.toThrow(/episodio_nao_gravado/);
  });

  it("rodada seguinte à marca que não gravou: aviso já aberto NÃO é inserido de novo (sem duplicar), e o episódio é gravado", async () => {
    const { admin, ops } = bancoQue(false, { avisoAberto: true });
    expect(await sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas")).toBe("avisado");
    expect(ops.filter((o) => o.tabela === "agent_inbox_items" && o.op === "insert")).toHaveLength(0);
    expect(ops.find((o) => o.tabela === "channel_session_health" && o.op === "upsert")?.payload).toMatchObject({ escalated_status: "FAILED" });
  });
});
