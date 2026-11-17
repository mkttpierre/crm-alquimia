/**
 * `RepositorioSequencia` sobre o Supabase (admin client, service role).
 *
 * Service role bypassa RLS: TODA consulta abaixo filtra `organization_id`, que vem da sessão do operador (resolvida
 * na rota), nunca do corpo da requisição (anti-pattern nº 10 do CLAUDE.md). A conversa, o lead, o chip e os modelos
 * são sempre buscados com a organização explícita.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { garantirLeadDaConversa } from "../../leads/nascimento-do-lead";
import { chipNaVolta } from "../fila";
import { chipDaLinha, COLUNAS_DO_CHIP, type LinhaChip } from "../repositorio-supabase";
import { repositorioAtendimentoSupabase } from "./repositorio-supabase";
import {
  ErroDaSequencia,
  kitAposFunilLigado,
  planejarKitAposFunilDoOperador,
  type ModeloDaParte,
  type Presenca,
  type RepositorioSequencia,
  type TipoDeMidia,
} from "./sequencia-operador";

function lancar(onde: string, erro: { message: string } | null): void {
  if (erro) throw new Error(`sequencia_operador.${onde}: ${erro.message}`);
}

type LinhaModelo = { id: string; shortcut: string | null; title: string; body: string; owner_user_id: string | null; media_id: string | null };

/** Anexos dos modelos, da biblioteca da org. Anexo que sumiu: o modelo não pode sair como se fosse só texto. */
async function comMidias(db: SupabaseClient, org: string, rows: LinhaModelo[]): Promise<Map<string, ModeloDaParte>> {
  const mediaIds = [...new Set(rows.map((r) => r.media_id).filter((m): m is string => !!m))];
  const midias = new Map<string, { id: string; kind: TipoDeMidia; name: string; size_bytes: number }>();
  if (mediaIds.length) {
    const { data: lib, error } = await db.from("media_library").select("id, kind, name, size_bytes").eq("organization_id", org).in("id", mediaIds);
    lancar("midias", error);
    for (const m of (lib ?? []) as { id: string; kind: TipoDeMidia; name: string; size_bytes: number }[]) midias.set(m.id, m);
  }
  const saida = new Map<string, ModeloDaParte>();
  for (const r of rows) {
    const m = r.media_id ? midias.get(r.media_id) : undefined;
    const nome = r.shortcut?.replace(/^\//, "") || r.title;
    if (r.media_id && !m) throw new Error(`sequencia_operador.midias: o anexo da mensagem "${nome}" não está na biblioteca da organização`);
    saida.set(r.id, {
      atalho: nome,
      titulo: r.title,
      corpo: r.body,
      midia: m ? { id: m.id, kind: m.kind, nome: m.name, tamanhoBytes: Number(m.size_bytes) } : null,
    });
  }
  return saida;
}

const COLUNAS_DO_MODELO = "id, shortcut, title, body, owner_user_id, media_id";

export function repositorioSequenciaSupabase(db: SupabaseClient): RepositorioSequencia {
  const atendimento = repositorioAtendimentoSupabase(db);
  /** Toques do kit e oferta do Método pendentes da lead (origem `motor`), só com `aposFunilDoOperador` ligado. */
  const cancelarKitDoLead = async (org: string, leadId: string, motivo: string): Promise<number> => {
    if (!kitAposFunilLigado((await atendimento.config(org))?.atendimento)) return 0;
    const { data, error } = await db
      .from("disparo_envios")
      .update({ estado: "cancelado", motivo })
      .eq("organization_id", org)
      .eq("lead_id", leadId)
      .eq("origem", "motor")
      .eq("estado", "pendente")
      .or("tipo.like.kit_t*,tipo.like.metodo_oferta_*")
      .select("id");
    lancar("cancelar_kit", error);
    return (data ?? []).length;
  };
  return {
    async config(org) {
      return (await atendimento.config(org))?.disparo ?? null;
    },

    async leadDaConversa(org, conversationId) {
      return (await atendimento.leadDaConversa?.(org, conversationId)) ?? null;
    },

    async lead(org, leadId) {
      const l = await atendimento.lead(org, leadId);
      return l ? { id: l.id, nome: l.nome, telefone: l.telefone, status: l.status, bloqueado: l.bloqueado, anonimizado: l.anonimizado } : null;
    },

    async chipDaConversa(org, conversationId) {
      const { data: conv, error } = await db
        .from("conversations")
        .select("channel_session_id")
        .eq("organization_id", org)
        .eq("id", conversationId)
        .maybeSingle();
      lancar("conversa", error);
      const sessao = conv?.channel_session_id as string | null | undefined;
      if (!sessao) return null;
      const { data: linhas, error: e2 } = await db
        .from("disparo_chips")
        .select(COLUNAS_DO_CHIP)
        .eq("organization_id", org)
        .eq("channel_session_id", sessao)
        .order("nome");
      lancar("chip", e2);
      const chips = ((linhas ?? []) as LinhaChip[]).map(chipDaLinha);
      // Mais de um chip na mesma sessão não é o esperado; se houver, vale o que o motor consegue usar.
      const agora = new Date();
      return chips.find((c) => chipNaVolta(c, agora).ok) ?? chips[0] ?? null;
    },

    async garantirLead(org, conversationId) {
      const { data: conv, error } = await db
        .from("conversations")
        .select("contact_id, contacts(display_name, name)")
        .eq("organization_id", org)
        .eq("id", conversationId)
        .maybeSingle();
      lancar("conversa_do_lead", error);
      const c = conv as { contact_id: string | null; contacts: { display_name: string | null; name: string | null } | null } | null;
      if (!c?.contact_id) return null;
      const r = await garantirLeadDaConversa(db, {
        organizationId: org,
        contactId: c.contact_id,
        conversationId,
        nomeDoContato: c.contacts?.display_name ?? c.contacts?.name ?? null,
      });
      if (r.criado) return r.leadId;
      // Já havia lead aberto (corrida com a entrada da conversa): é o dele.
      return (await atendimento.leadDaConversa?.(org, conversationId)) ?? null;
    },

    async funil(org, usuarioId, ref) {
      let q = db
        .from("operator_funnels")
        .select("id, nome, atalho, owner_user_id, operator_funnel_steps(position, template_id, atraso_ms, presenca, presenca_ms)")
        .eq("organization_id", org)
        .eq("ativo", true)
        // O que o operador enxerga na tela: os compartilhados e os dele (a RLS faz o mesmo para a sessão).
        .or(`owner_user_id.is.null,owner_user_id.eq.${usuarioId}`);
      q = ref.funnelId ? q.eq("id", ref.funnelId) : q.eq("atalho", ref.atalho ?? "");
      const { data, error } = await q.limit(1);
      lancar("funil", error);
      const f = data?.[0] as
        | { id: string; nome: string; atalho: string; owner_user_id: string | null; operator_funnel_steps: { position: number; template_id: string; atraso_ms: number; presenca: Presenca; presenca_ms: number }[] }
        | undefined;
      if (!f) return null;
      const passos = [...(f.operator_funnel_steps ?? [])].sort((x, y) => x.position - y.position);
      const ids = [...new Set(passos.map((x) => x.template_id))];
      const { data: linhas, error: e2 } = ids.length
        ? await db.from("message_templates").select(COLUNAS_DO_MODELO).eq("organization_id", org).in("id", ids)
        : { data: [], error: null };
      lancar("modelos_do_funil", e2);
      if (((linhas ?? []) as LinhaModelo[]).some((m) => m.owner_user_id !== null && m.owner_user_id !== f.owner_user_id)) {
        throw new ErroDaSequencia("modelo", "Este funil contém um modelo pessoal que não pertence ao dono do funil.", 422);
      }
      const modelos = await comMidias(db, org, (linhas ?? []) as LinhaModelo[]);
      return {
        id: f.id,
        titulo: f.nome,
        atalho: f.atalho,
        passos: passos.map((x) => {
          const modelo = modelos.get(x.template_id);
          if (!modelo) throw new Error(`sequencia_operador.funil: o funil "${f.nome}" aponta para uma mensagem que não existe`);
          return { modelo, atrasoMs: x.atraso_ms, presenca: x.presenca, presencaMs: x.presenca_ms };
        }),
      };
    },

    async modeloPorId(org, usuarioId, templateId) {
      const { data, error } = await db
        .from("message_templates")
        .select(COLUNAS_DO_MODELO)
        .eq("organization_id", org)
        .eq("id", templateId)
        .or(`owner_user_id.is.null,owner_user_id.eq.${usuarioId}`)
        .maybeSingle();
      lancar("modelo", error);
      if (!data) return null;
      return (await comMidias(db, org, [data as LinhaModelo])).get(templateId) ?? null;
    },

    async emAberto(org, leadId) {
      const { count, error } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", "operador")
        .in("estado", ["pendente", "enviando"]);
      lancar("em_aberto", error);
      return count ?? 0;
    },

    async enfileirar(org, envios) {
      // UM insert: o Postgres grava as partes juntas ou nenhuma (uma sequência pela metade nunca fica na fila).
      const { error } = await db.rpc("fn_enfileirar_funil_do_operador", {
        p_org: org,
        p_lead: envios[0]?.leadId,
        p_linhas: envios.map((e) => ({
          organization_id: org,
          lead_id: e.leadId,
          chip_id: e.chipId,
          tipo: e.tipo,
          origem: "operador",
          texto: e.texto,
          midia: e.midiaNome,
          midia_id: e.midiaId,
          enviar_apos: e.enviarApos.toISOString(),
          presenca: e.presenca,
          presenca_ms: e.presencaMs,
          estado: e.estado,
          enviado_em: e.estado === "simulado" ? e.enviarApos.toISOString() : null,
          motivo: e.motivo,
          da_parada: false,
        })),
      });
      // Índice único parcial `disparo_envios_operador_em_aberto` (migration 0246): outro pedido igual chegou junto
      // (duplo clique, duas abas) e já gravou. Nada desta vez foi gravado (um insert só).
      if (error?.code === "23505" || (error?.code === "P0001" && error.message === "funil_em_andamento")) {
        throw new ErroDaSequencia("ja_agendada", "Já há uma sequência em andamento para esta lead (outro pedido chegou junto). Nada foi agendado de novo.", 409);
      }
      lancar("enfileirar", error);
    },

    async ultimoEnvioDaSequencia(org, leadId, prefixo, desde) {
      const { data, error } = await db
        .from("disparo_envios")
        .select("enviado_em")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", "operador")
        .eq("estado", "enviado")
        .like("tipo", `${prefixo.replaceAll("_", "\\_")}:%`)
        .gte("enviado_em", desde.toISOString())
        .order("enviado_em", { ascending: false })
        .limit(1);
      lancar("ultimo_envio", error);
      const v = data?.[0]?.enviado_em as string | undefined;
      return v ? new Date(v) : null;
    },

    async repeticaoDoPedido(org, conversationId, chave) {
      const { data, error } = await db
        .from("api_audit_log")
        .select("metadata")
        .eq("organization_id", org)
        .eq("action", "disparo.sequencia_agendada")
        .eq("resource_type", "conversation")
        .eq("resource_id", conversationId)
        .eq("metadata->>idempotency_key", chave)
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(1);
      lancar("repeticao", error);
      const resposta = (data?.[0]?.metadata as Record<string, unknown> | undefined)?.["resposta"];
      return resposta && typeof resposta === "object" ? (resposta as Record<string, unknown>) : null;
    },

    async andamento(org, leadId, desde) {
      const { data, error } = await db
        .from("disparo_envios")
        .select("tipo, estado, enviar_apos, created_at")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", "operador")
        .gte("created_at", desde.toISOString())
        .order("created_at", { ascending: false });
      lancar("andamento", error);
      const linhas = (data ?? []) as { tipo: string; estado: string; enviar_apos: string; created_at: string }[];
      // Só o funil mais recente (as partes de um pedido nascem juntas, no mesmo insert).
      const ultimo = linhas[0]?.created_at;
      const doPedido = linhas.filter((l) => l.created_at === ultimo && l.estado !== "cancelado");
      const pendentes = doPedido.filter((l) => l.estado === "pendente" || l.estado === "enviando");
      const proxima = pendentes.map((l) => new Date(l.enviar_apos)).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
      return {
        enviadas: doPedido.filter((l) => l.estado === "enviado").length,
        total: doPedido.length,
        pendentes: pendentes.length,
        proximaEm: proxima,
        prefixo: doPedido[0]?.tipo.split(":")[0] ?? null,
      };
    },

    cancelarKitDoLead,

    async planejarKitAposFunil(org, p) {
      return planejarKitAposFunilDoOperador({ repo: atendimento, cancelarKit: cancelarKitDoLead }, org, p);
    },

    async cancelar(org, leadId, motivo) {
      const { data, error } = await db
        .from("disparo_envios")
        .update({ estado: "cancelado", motivo })
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", "operador")
        .eq("estado", "pendente")
        .select("id");
      lancar("cancelar", error);
      return (data ?? []).length;
    },
  };
}
