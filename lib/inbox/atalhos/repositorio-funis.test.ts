// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { erroDoFunil } from "./resposta-funil";
import { repositorioFunisSupabase } from "./repositorio-funis";

const passo = { template_id: "t1", atraso_ms: 0, presenca: "nenhuma" as const, presenca_ms: 0 };
const funil = { nome: "Funil", atalho: "funil", palavras_chave: [], favorito: false, compartilhado: true, passos: [passo] };
const rpcArgs = (extra: Record<string, unknown>) => ({ p_funnel: null, p_org: "org", p_nome: "Funil", p_atalho: "funil", p_palavras: [], p_favorito: false, p_compartilhado: true, p_passos: [passo], ...extra });

/** Assinatura de `supabase.rpc(nome, args)`: deixa `rpc.mock.calls[0]?.[1]` tipado. */
type ChamadaRpc = (nome: string, args: Record<string, unknown>) => Promise<{ data: string; error: null }>;

/** Banco de mentira: `rpc` registra a chamada; `from(...).select().eq().eq().maybeSingle()` devolve o funil existente. */
function banco(rpc: ReturnType<typeof vi.fn>, existente: { id: string; owner_user_id: string | null } | null = null) {
  return {
    rpc,
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existente, error: null }) }) }) }) }),
  } as unknown as SupabaseClient;
}

describe("gravação de funis (uma transação só, pela RPC)", () => {
  it("criar: metadados e passos vão juntos na RPC, sem inserir tabela por fora", async () => {
    const rpc = vi.fn(async () => ({ data: "f-novo", error: null }));
    const salvo = await repositorioFunisSupabase(banco(rpc)).criar("org", "u1", funil);
    expect(rpc).toHaveBeenCalledWith("fn_salvar_funil_do_operador", rpcArgs({}));
    expect(salvo).toMatchObject({ id: "f-novo", owner_user_id: null });
  });

  it("criar pessoal: o dono é quem criou", async () => {
    const rpc = vi.fn(async () => ({ data: "f-novo", error: null }));
    const salvo = await repositorioFunisSupabase(banco(rpc)).criar("org", "u1", { ...funil, compartilhado: false });
    expect(rpc.mock.calls[0]).toEqual(["fn_salvar_funil_do_operador", rpcArgs({ p_compartilhado: false })]);
    expect(salvo.owner_user_id).toBe("u1");
  });

  it("atualizar: metadados e passos vão na mesma RPC", async () => {
    const rpc = vi.fn(async () => ({ data: "f1", error: null }));
    await repositorioFunisSupabase(banco(rpc, { id: "f1", owner_user_id: null })).atualizar("org", "u1", "f1", funil);
    expect(rpc).toHaveBeenCalledWith("fn_salvar_funil_do_operador", rpcArgs({ p_funnel: "f1" }));
  });

  it("atualizar: funil que a sessão não enxerga devolve null e não chama a RPC", async () => {
    const rpc = vi.fn();
    expect(await repositorioFunisSupabase(banco(rpc, null)).atualizar("org", "u1", "f1", funil)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("atualizar: tirar de 'para a equipe toda' passa a ser do usuário (o toggle persiste)", async () => {
    const rpc = vi.fn<ChamadaRpc>(async () => ({ data: "f1", error: null }));
    const salvo = await repositorioFunisSupabase(banco(rpc, { id: "f1", owner_user_id: null })).atualizar("org", "u1", "f1", { ...funil, compartilhado: false });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_compartilhado: false });
    expect(salvo?.owner_user_id).toBe("u1");
  });

  it("atualizar: marcar 'para a equipe toda' num funil pessoal vira da organização", async () => {
    const rpc = vi.fn<ChamadaRpc>(async () => ({ data: "f1", error: null }));
    const salvo = await repositorioFunisSupabase(banco(rpc, { id: "f1", owner_user_id: "u1" })).atualizar("org", "u1", "f1", funil);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_compartilhado: true });
    expect(salvo?.owner_user_id).toBeNull();
  });

  it("erro da RPC sobe como veio (a rota o traduz)", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "P0001", message: "funnel_modelo_pessoal" } }));
    await expect(repositorioFunisSupabase(banco(rpc)).criar("org", "u1", funil)).rejects.toMatchObject({ code: "P0001", message: "funnel_modelo_pessoal" });
  });
});

describe("erroDoFunil", () => {
  it("modelo pessoal em funil compartilhado (P0001 da RPC) vira 422 funnel_modelo_pessoal", async () => {
    const res = erroDoFunil({ code: "P0001", message: "funnel_modelo_pessoal" }, "req");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("funnel_modelo_pessoal");
  });
});
