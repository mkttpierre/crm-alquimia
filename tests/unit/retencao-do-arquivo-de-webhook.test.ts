import { describe, expect, it } from "vitest";

import { LOTE_PADRAO, podarArquivoDeWebhooks } from "@/lib/channels/retencao-do-arquivo";

/**
 * A PODA NÃO PODE VIRAR O PROBLEMA QUE ELA RESOLVE.
 *
 * ─── O defeito que ela conserta ─────────────────────────────────────────────
 *
 * `webhook_events_log` nunca foi podado. Medido numa instalação real em
 * 20/08/2026: 468 MB de 545 MB do banco inteiro (86%), todas as 56.291 linhas
 * dos últimos 20 dias — ~23 MB/dia, sem teto, contra os 500 MB do plano
 * gratuito do Supabase.
 *
 * ─── Por que os casos são sobre o que ela NÃO faz ───────────────────────────
 *
 * Uma poda erra de três formas, e as três são caras de descobrir em produção:
 * apagando o que ainda serve, segurando a tabela em que todo webhook escreve,
 * ou escrevendo de novo o que já escreveu. Por isso quase todo caso aqui é um
 * limite, não um caminho feliz.
 */

/** Duble mínimo do client: registra a chamada RPC e devolve o que mandarem. */
function fakeAdmin(resposta: { data?: unknown; error?: { message: string } | null } = {}) {
  const chamadas: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    // A poda NÃO pode voltar a montar `.in("id", [...])` na URL: 500 ids
    // estouravam o limite do PostgREST ("URI too long") a cada 5 minutos.
    from() {
      throw new Error("a poda deve passar pela função SQL, não pela URL");
    },
    rpc(fn: string, args: Record<string, unknown>) {
      chamadas.push({ fn, args });
      return Promise.resolve({ data: resposta.data ?? null, error: resposta.error ?? null });
    },
  };
  return { admin: admin as never, chamadas };
}

describe("a poda roda dentro do banco, em lote", () => {
  it("chama a função SQL com os horizontes e o lote", async () => {
    const { admin, chamadas } = fakeAdmin({ data: { esvaziadas: 2, apagadas: 1 } });
    const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 300 });
    expect(chamadas).toEqual([
      {
        fn: "fn_podar_webhook_events_log",
        args: { p_dias_com_corpo: 7, p_dias_para_apagar: 90, p_lote: 300 },
      },
    ]);
    expect(r).toMatchObject({ esvaziadas: 2, apagadas: 1 });
  });

  it("usa o lote padrão quando não pedem outro", async () => {
    const { admin, chamadas } = fakeAdmin({ data: { esvaziadas: 0, apagadas: 0 } });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    expect(chamadas[0]?.args.p_lote).toBe(LOTE_PADRAO);
  });
});

describe("o lote é o que impede a poda de derrubar a entrada", () => {
  it("lote cheio significa que ainda há fila", async () => {
    const { admin } = fakeAdmin({ data: { esvaziadas: 3, apagadas: 0 } });
    const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 3 });
    expect(r.temMais).toBe(true);
  });

  it("lote com folga significa fila vazia", async () => {
    const { admin } = fakeAdmin({ data: { esvaziadas: 1, apagadas: 0 } });
    const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 500 });
    expect(r.temMais).toBe(false);
  });
});

describe("falha do banco não derruba a rodada", () => {
  it("erro da função devolve zero, não lança", async () => {
    const { admin } = fakeAdmin({ error: { message: "timeout" } });
    await expect(podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 }))
      .resolves.toMatchObject({ esvaziadas: 0, apagadas: 0, temMais: false });
  });

  it("resposta sem forma esperada vira zero", async () => {
    const { admin } = fakeAdmin({ data: null });
    await expect(podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 }))
      .resolves.toMatchObject({ esvaziadas: 0, apagadas: 0 });
  });
});
