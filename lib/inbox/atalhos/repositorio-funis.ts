/**
 * Leitura e escrita dos funis do operador com o cliente da SESSÃO (a RLS de `operator_funnels`/`_steps` decide quem
 * vê e quem escreve). `organization_id` explícito em toda consulta, como manda a doutrina.
 *
 * Metadados e passos são gravados juntos pela RPC sob a RLS da sessão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { FunilInput } from "./schema-funil";
import type { PassoDoFunil } from "./tipos";

export type FunilGravado = Omit<FunilInput, "compartilhado"> & { id: string; owner_user_id: string | null };

const COLS = "id, nome, atalho, palavras_chave, favorito, owner_user_id, operator_funnel_steps(position, template_id, atraso_ms, presenca, presenca_ms)";

type Linha = {
  id: string;
  nome: string;
  atalho: string;
  palavras_chave: string[];
  favorito: boolean;
  owner_user_id: string | null;
  operator_funnel_steps: (PassoDoFunil & { position: number })[];
};

const paraFunil = (l: Linha): FunilGravado => ({
  id: l.id,
  nome: l.nome,
  atalho: l.atalho,
  palavras_chave: l.palavras_chave,
  favorito: l.favorito,
  owner_user_id: l.owner_user_id,
  passos: [...(l.operator_funnel_steps ?? [])]
    .sort((a, b) => a.position - b.position)
    .map(({ template_id, atraso_ms, presenca, presenca_ms }) => ({ template_id, atraso_ms, presenca, presenca_ms })),
});

export function repositorioFunisSupabase(db: SupabaseClient) {
  /**
   * Uma transação só no banco (`fn_salvar_funil_do_operador`, security invoker: a RLS da sessão manda): cria ou
   * atualiza os metadados, o dono (equipe toda x pessoal), confere que nenhum passo usa modelo pessoal alheio e regrava
   * os passos. Falhou em qualquer ponto, nada mudou — não há mais funil sem passo nem funil órfão.
   */
  async function salvar(org: string, id: string | null, f: FunilInput): Promise<string> {
    const { data, error } = await db.rpc("fn_salvar_funil_do_operador", {
      p_funnel: id,
      p_org: org,
      p_nome: f.nome,
      p_atalho: f.atalho,
      p_palavras: f.palavras_chave,
      p_favorito: f.favorito,
      p_compartilhado: f.compartilhado,
      p_passos: f.passos,
    });
    if (error) throw error;
    return (data as string | null) ?? id ?? "";
  }

  return {
    async listar(org: string): Promise<FunilGravado[]> {
      const { data, error } = await db.from("operator_funnels").select(COLS).eq("organization_id", org).eq("ativo", true).order("nome");
      if (error) throw error;
      return ((data ?? []) as unknown as Linha[]).map(paraFunil);
    },

    async criar(org: string, usuarioId: string, f: FunilInput): Promise<FunilGravado> {
      const id = await salvar(org, null, f);
      return { id, owner_user_id: f.compartilhado ? null : usuarioId, ...f };
    },

    async atualizar(org: string, usuarioId: string, id: string, f: FunilInput): Promise<FunilGravado | null> {
      const { data, error } = await db
        .from("operator_funnels")
        .select("id, owner_user_id")
        .eq("organization_id", org)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const atual = (data as { owner_user_id: string | null }).owner_user_id;
      await salvar(org, id, f);
      // Mesma regra da RPC: "equipe toda" = sem dono; senão fica com o dono que já tinha ou passa a ser de quem salvou.
      return { id, owner_user_id: f.compartilhado ? null : (atual ?? usuarioId), ...f };
    },

    async apagar(org: string, id: string): Promise<boolean> {
      const { data, error } = await db.from("operator_funnels").delete().eq("organization_id", org).eq("id", id).select("id").maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },

    /** Nomes dos funis que usam o modelo (para o 409 ao apagar modelo em uso). */
    async funisQueUsam(org: string, templateId: string): Promise<string[]> {
      const { data } = await db
        .from("operator_funnel_steps")
        .select("operator_funnels(nome)")
        .eq("organization_id", org)
        .eq("template_id", templateId);
      const nomes = ((data ?? []) as unknown as { operator_funnels: { nome: string } | null }[]).map((r) => r.operator_funnels?.nome).filter((n): n is string => !!n);
      return [...new Set(nomes)];
    },
  };
}
