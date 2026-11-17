/**
 * `RepositorioAtendimento` sobre o Supabase (admin client, service role).
 *
 * Service role bypassa RLS: TODA consulta abaixo filtra `organization_id`, que
 * vem de quem chama — o gancho de entrada a resolve do TOKEN DO CAMINHO do
 * webhook (via `channel_sessions`), nunca do corpo (anti-pattern nº 10).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { cadenciaPorId } from "../cadencia";
import { naoContatarMarcado } from "../regras";

export { naoContatarMarcado };
import { chipDaConversaId, chipDasConversasDoLead } from "../chip-da-conversa";
import { escolhaSchema, lerRitmo, modelosSchema, proibidosSchema, slotsSchema } from "../config";
import { ESTADOS_SAIDOS } from "../fila";
import { TIPO_TOQUE_DO_KIT } from "../kit-followup";
import { tomarTrava, soltarTrava } from "../travas-supabase";
import { TRAVA_DO_LEAD_MS, type ConversaGuardada, type RepositorioAtendimento } from "./atendimento";
import { lerConfigAtendimento } from "./config";
import { ETAPAS_ATENDIMENTO, type EtapaAtendimento, lerDados } from "./estado";
import { moverCardDoAtendimento, moverCardParaEtapa, ORIGEM_DO_ATENDIMENTO } from "./funil";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { situacaoHumanaDoLead } from "./humano-supabase";
import { EVENTO_RETORNO_RESERVA, TIPO_RETORNO_RESERVA } from "./retorno-reserva";

function lancar(contexto: string, erro: { message: string } | null): void {
  if (erro) throw new Error(`atendimento_${contexto}: ${erro.message}`);
}

/** Título que identifica o aviso do atendimento na Central (kind `other`, ligado ao lead). */
export const PREFIXO_DO_AVISO = "Atendimento";
const SEVERIDADE = { compra: "warn", operador: "info", info: "info" } as const;

/** Conversas do contato do lead que contam: a da mensagem (mesmo encerrada) e as abertas. */
async function conversasDoContato(db: SupabaseClient, org: string, leadId: string, conversationId: string | null): Promise<string[]> {
  const { data: lead, error } = await db.from("crm_leads").select("contact_id").eq("organization_id", org).eq("id", leadId).maybeSingle();
  lancar("conversas_lead", error);
  const contatoId = (lead?.contact_id as string | null | undefined) ?? null;
  if (!contatoId) return [];
  const { data, error: e2 } = await db.from("conversations").select("id, status").eq("organization_id", org).eq("contact_id", contatoId).limit(50);
  lancar("conversas_contato", e2);
  return (data ?? []).filter((c) => c.id === conversationId || !["closed", "archived"].includes(String(c.status))).map((c) => c.id as string);
}

export function repositorioAtendimentoSupabase(db: SupabaseClient): RepositorioAtendimento {
  return {
    async config(org) {
      const { data: l, error } = await db
        .from("disparo_config")
        .select("organization_id, ligado, modo, teto_diario, cadencia, fonte_stage_id, ritmo, modelos, proibidos, slots, escolha, atendimento")
        .eq("organization_id", org)
        .maybeSingle();
      lancar("config", error);
      if (!l) return null;
      return {
        disparo: {
          organizationId: org,
          ligado: Boolean(l.ligado),
          modo: l.modo === "real" ? "real" : "simulado",
          tetoDiario: (l.teto_diario as number | null) ?? null,
          cadencia: cadenciaPorId(l.cadencia as string).id,
          fonteStageId: (l.fonte_stage_id as string | null) ?? null,
          ritmo: lerRitmo(l.ritmo),
          modelos: modelosSchema.catch({}).parse(l.modelos),
          proibidos: proibidosSchema.catch([]).parse(l.proibidos),
          slots: slotsSchema.catch({ fixos: {}, semNomeQuando: [] }).parse(l.slots),
          escolha: escolhaSchema.catch([]).parse(l.escolha),
          janelaResposta: lerConfigAtendimento(l.atendimento)?.janelaResposta ?? null,
        },
        atendimento: lerConfigAtendimento(l.atendimento),
      };
    },

    async lead(org, leadId) {
      const { data: l, error } = await db
        .from("crm_leads")
        .select("id, status, custom_fields, contact:contacts(name, phone_number, is_blocked, is_anonymized)")
        .eq("organization_id", org)
        .eq("id", leadId)
        .maybeSingle();
      lancar("lead", error);
      if (!l) return null;
      const c = (l as unknown as { contact: { name: string | null; phone_number: string | null; is_blocked: boolean; is_anonymized: boolean | null } | null }).contact;
      const campos = (l.custom_fields as Record<string, unknown> | null) ?? {};
      return {
        id: l.id as string,
        nome: c?.name ?? null,
        telefone: c?.phone_number ?? null,
        campos,
        status: l.status as string,
        bloqueado: !c || c.is_blocked || naoContatarMarcado(campos),
        anonimizado: Boolean(c?.is_anonymized),
      };
    },

    async conversa(org, leadId) {
      const { data: l, error } = await db
        .from("disparo_conversas")
        .select("etapa, quente, precisa_operador, motivo_operador, auto_seguidas, ultima_auto_em, dados")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .maybeSingle();
      lancar("conversa", error);
      if (!l) return null;
      const etapa = ETAPAS_ATENDIMENTO.includes(l.etapa as EtapaAtendimento) ? (l.etapa as EtapaAtendimento) : "respondeu";
      return {
        etapa,
        quente: Boolean(l.quente),
        precisaOperador: Boolean(l.precisa_operador),
        motivoOperador: (l.motivo_operador as string | null) ?? null,
        autoSeguidas: (l.auto_seguidas as number) ?? 0,
        ultimaAutoEm: l.ultima_auto_em ? new Date(l.ultima_auto_em as string) : null,
        dados: lerDados(l.dados),
      };
    },

    async salvarConversa(org, leadId, c: ConversaGuardada) {
      const { error } = await db.from("disparo_conversas").upsert(
        {
          organization_id: org,
          lead_id: leadId,
          etapa: c.etapa,
          quente: c.quente,
          precisa_operador: c.precisaOperador,
          motivo_operador: c.motivoOperador?.slice(0, 300) ?? null,
          auto_seguidas: c.autoSeguidas,
          ultima_auto_em: c.ultimaAutoEm?.toISOString() ?? null,
          dados: c.dados,
        },
        { onConflict: "organization_id,lead_id" },
      );
      lancar("salvar_conversa", error);
    },

    async reservarLeitura(org, r) {
      const { data: l, error } = await db
        .from("disparo_leituras")
        .insert({
          organization_id: org,
          lead_id: r.leadId,
          message_id: r.messageId,
          chave: r.chave,
          chip_id: r.chipId,
          texto: r.texto.slice(0, 4000),
        })
        .select("id")
        .single();
      if (error?.code === "23505") return null;
      lancar("reservar_leitura", error);
      return (l as { id: string }).id;
    },

    async concluirLeitura(org, id, r) {
      const { error } = await db
        .from("disparo_leituras")
        .update({ leitura: r.leitura, decisao: r.decisao.slice(0, 500), irritada: r.irritada })
        .eq("organization_id", org)
        .eq("id", id);
      lancar("concluir_leitura", error);
    },

    async espelharHistoricoDoDisparo(org, leadId, conversationId) {
      try {
        const { data: conversa } = await db
          .from("conversations")
          .select("id, contact_id, channel_session_id")
          .eq("organization_id", org)
          .eq("id", conversationId)
          .maybeSingle();
        if (!conversa?.channel_session_id || !conversa.contact_id) return 0;
        const { data: chips } = await db.from("disparo_chips").select("id").eq("organization_id", org).eq("channel_session_id", conversa.channel_session_id as string);
        const chipIds = (chips ?? []).map((c) => c.id as string);
        if (!chipIds.length) return 0;
        const { data: envios } = await db
          .from("disparo_envios")
          .select("external_id, texto, midia_id, enviado_em")
          .eq("organization_id", org)
          .eq("lead_id", leadId)
          .eq("estado", "enviado")
          .in("chip_id", chipIds)
          .not("external_id", "is", null)
          .order("enviado_em", { ascending: true });
        const lista = (envios ?? []) as { external_id: string; texto: string | null; midia_id: string | null; enviado_em: string | null }[];
        if (!lista.length) return 0;
        const { data: ja } = await db
          .from("messages")
          .select("external_id")
          .eq("organization_id", org)
          .eq("conversation_id", conversationId)
          .in("external_id", lista.map((e) => e.external_id));
        const existentes = new Set((ja ?? []).map((x) => x.external_id as string));
        const faltam = lista.filter((e) => !existentes.has(e.external_id));
        if (!faltam.length) return 0;
        const midiaIds = [...new Set(faltam.map((e) => e.midia_id).filter((x): x is string => Boolean(x)))];
        const { data: midias } = midiaIds.length
          ? await db.from("media_library").select("id, kind, storage_path, mime").eq("organization_id", org).in("id", midiaIds)
          : { data: [] };
        const porId = new Map((midias ?? []).map((x) => [x.id as string, x]));
        const linhas = faltam.map((e) => {
          const midia = e.midia_id ? porId.get(e.midia_id) : undefined;
          const quando = e.enviado_em ?? new Date().toISOString();
          return {
            organization_id: org,
            conversation_id: conversationId,
            channel_session_id: conversa.channel_session_id,
            contact_id: conversa.contact_id,
            external_id: e.external_id,
            type: midia ? String(midia.kind) : "text",
            direction: "outbound",
            status: "sent",
            body: e.texto?.trim() || null,
            media_storage_path: (midia?.storage_path as string | undefined) ?? null,
            media_mime: (midia?.mime as string | undefined) ?? null,
            sent_via: "automation",
            sent_at: quando,
            created_at: quando,
            metadata: { espelho_do_disparo: true, historico_da_abertura: true },
          };
        });
        const { error } = await db.from("messages").insert(linhas);
        return error ? 0 : linhas.length;
      } catch {
        return 0;
      }
    },

    async situacaoHumana(org, leadId, conversationId) {
      return situacaoHumanaDoLead(db, org, leadId, conversationId);
    },

    async marcarNaoContatar(org, leadId) {
      const { data: lead, error } = await db.from("crm_leads").select("custom_fields").eq("organization_id", org).eq("id", leadId).maybeSingle();
      lancar("nao_contatar_leitura", error);
      if (!lead) return;
      const campos = (lead.custom_fields as Record<string, unknown> | null) ?? {};
      if (campos["nao_contatar"] === true) return;
      const { error: e2 } = await db
        .from("crm_leads")
        .update({ custom_fields: { ...campos, nao_contatar: true } })
        .eq("organization_id", org)
        .eq("id", leadId);
      lancar("nao_contatar", e2);
    },

    async tomarTravaDoLead(org, leadId, dono) {
      return tomarTrava(db, org, `lead:${leadId}`, dono, TRAVA_DO_LEAD_MS);
    },

    async soltarTravaDoLead(org, leadId, dono) {
      await soltarTrava(db, org, `lead:${leadId}`, dono);
    },

    async chipDoLead(org, leadId, conversationId) {
      // 1º a conversa da mensagem (a resposta sai pelo número em que a lead escreveu); 2º o último envio; 3º a
      // conversa mais recente do contato num chip do motor (lead que nunca recebeu nada do motor).
      if (conversationId) {
        const daConversa = await chipDaConversaId(db, org, conversationId);
        if (daConversa) return daConversa;
      }
      const { data: l, error } = await db
        .from("disparo_envios")
        .select("chip_id")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .not("chip_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      lancar("chip_do_lead", error);
      return (l?.[0]?.chip_id as string | undefined) ?? (await chipDasConversasDoLead(db, org, leadId));
    },

    async nossaUltima(org, leadId) {
      const { data: l, error } = await db
        .from("disparo_envios")
        .select("texto")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .in("estado", ESTADOS_SAIDOS)
        .neq("origem", "lembrete")
        .neq("texto", "")
        .order("enviado_em", { ascending: false })
        .limit(1);
      lancar("nossa_ultima", error);
      return (l?.[0]?.texto as string | undefined) ?? null;
    },

    async operadorFalouDesde(org, leadId, desde) {
      const { data: lead, error } = await db.from("crm_leads").select("contact_id").eq("organization_id", org).eq("id", leadId).maybeSingle();
      lancar("operador_lead", error);
      if (!lead?.contact_id) return false;
      const { data: msgs, error: e2 } = await db
        .from("messages")
        .select("external_id")
        .eq("organization_id", org)
        .eq("contact_id", lead.contact_id)
        .eq("direction", "outbound")
        // Nota de tela (ligação, aviso) não é o operador falando com o lead.
        .neq("type", "system")
        .gt("created_at", desde.toISOString())
        .limit(20);
      lancar("operador_msgs", e2);
      const ids = (msgs ?? []).map((m) => m.external_id as string | null);
      if (!ids.length) return false;
      const externos = ids.filter((x): x is string => Boolean(x));
      if (externos.length < ids.length) return true; // sem external_id: saiu pela tela, não pelo disparo
      const { data: nossos, error: e3 } = await db
        .from("disparo_envios")
        .select("external_id")
        .eq("organization_id", org)
        .in("external_id", externos);
      lancar("operador_nossos", e3);
      const doDisparo = new Set((nossos ?? []).map((n) => n.external_id as string));
      return externos.some((x) => !doDisparo.has(x));
    },

    async cancelarPendentesDoLead(org, leadId, motivo, poupaParada = false, poupaRetorno = false) {
      let q = db
        .from("disparo_envios")
        .update({ estado: "cancelado", motivo })
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("estado", "pendente");
      if (poupaParada) q = q.eq("da_parada", false);
      if (poupaRetorno) q = q.neq("tipo", TIPO_RETORNO_RESERVA);
      const { data: l, error } = await q.select("id");
      lancar("cancelar_pendentes", error);
      return (l ?? []).length;
    },

    async cancelarRetornoReserva(org, leadId, motivo) {
      const { data, error } = await db.from("disparo_envios").update({ estado: "cancelado", motivo })
        .eq("organization_id", org).eq("lead_id", leadId).eq("tipo", TIPO_RETORNO_RESERVA).eq("estado", "pendente").select("id");
      lancar("cancelar_retorno", error);
      return (data ?? []).length;
    },

    async registrarEventoRetorno(org, leadId, envioId) {
      await emitLeadActivity(db, {
        organizationId: org, leadId, type: "note", sourceModule: ORIGEM_DO_ATENDIMENTO, sourceId: envioId,
        actor: { type: "webhook_source", id: ORIGEM_DO_ATENDIMENTO }, reason: "Retorno da reserva enviado; lead quente para o operador.",
        payload: { evento: EVENTO_RETORNO_RESERVA, envio_id: envioId },
      });
    },

    async fimDaFila(org, leadId, agora) {
      const { data: l, error } = await db
        .from("disparo_envios")
        .select("enviar_apos")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", "auto")
        .in("estado", ["pendente", "enviando", "simulado"])
        .neq("tipo", TIPO_RETORNO_RESERVA)
        .gt("enviar_apos", agora.toISOString())
        .order("enviar_apos", { ascending: false })
        .limit(1);
      lancar("fim_da_fila", error);
      const v = l?.[0]?.enviar_apos as string | undefined;
      return v ? new Date(v) : null;
    },

    async enfileirar(org, e) {
      const { error } = await db.from("disparo_envios").insert({
        organization_id: org,
        lead_id: e.leadId,
        chip_id: e.chipId,
        tipo: e.tipo,
        origem: e.origem ?? "auto",
        texto: e.texto,
        midia: e.midia?.nome ?? null,
        midia_id: e.midia?.id ?? null,
        enviar_apos: e.enviarApos.toISOString(),
        estado: e.estado,
        enviado_em: e.estado === "simulado" ? e.enviarApos.toISOString() : null,
        motivo: e.motivo,
        da_parada: e.daParada === true,
      });
      lancar("enfileirar", error);
    },

    async toquesDoKitEnviados(org, leadId) {
      // Só o toque numerado (kit_t<n>_<data>) e só os que saíram (ou foram simulados), de qualquer rodada.
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .select("tipo")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", "motor")
        .like("tipo", "kit_t%")
        .in("estado", ["enviado", "simulado"]);
      lancar("toques_do_kit", error);
      const rodadas = new Map<string, number>();
      for (const l of linhas ?? []) {
        const m = TIPO_TOQUE_DO_KIT.exec(l.tipo as string);
        if (m) rodadas.set(m[2]!, Math.max(rodadas.get(m[2]!) ?? 0, Number(m[1])));
      }
      // O toque mais alto da rodada mais recente (a rodada é a data-base do planejamento).
      const ultima = [...rodadas.keys()].sort().at(-1);
      return ultima ? rodadas.get(ultima)! : 0;
    },

    async leadDaConversa(org, conversationId) {
      const { data: conv, error } = await db.from("conversations").select("contact_id").eq("organization_id", org).eq("id", conversationId).maybeSingle();
      lancar("lead_da_conversa", error);
      if (!conv?.contact_id) return null;
      // O mesmo critério do gancho de entrada: o lead aberto mais recente do contato.
      const { data: lead, error: e2 } = await db
        .from("crm_leads")
        .select("id")
        .eq("organization_id", org)
        .eq("contact_id", conv.contact_id)
        .eq("status", "open")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      lancar("lead_do_contato", e2);
      return (lead?.id as string | undefined) ?? null;
    },

    async ofertaDoMetodoJaSaiu(org, leadId) {
      const { count, error } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .like("tipo", "metodo\_oferta%")
        .in("estado", ["enviado", "simulado"]);
      lancar("oferta_do_metodo", error);
      return (count ?? 0) > 0;
    },

    async avisar(org, a) {
      const { error } = await db.from("agent_inbox_items").insert({
        organization_id: org,
        kind: "other",
        severity: SEVERIDADE[a.nivel],
        title: a.titulo.startsWith(PREFIXO_DO_AVISO) ? a.titulo : `${PREFIXO_DO_AVISO}: ${a.titulo}`.slice(0, 200),
        body: a.corpo.slice(0, 2000),
        ref_kind: "lead",
        ref_id: a.leadId,
      });
      lancar("avisar", error);
    },

    async fecharAvisosDoLead(org, leadId) {
      const { error } = await db
        .from("agent_inbox_items")
        .update({ status: "resolved" })
        .eq("organization_id", org)
        .eq("kind", "other")
        .eq("ref_kind", "lead")
        .eq("ref_id", leadId)
        .like("title", `${PREFIXO_DO_AVISO}%`)
        .eq("status", "open");
      lancar("fechar_avisos", error);
    },

    async irritacoesDoChip(org, chipId, desde) {
      const { count, error } = await db
        .from("disparo_leituras")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("chip_id", chipId)
        .eq("irritada", true)
        .gte("created_at", desde.toISOString());
      lancar("irritacoes", error);
      // A leitura desta mensagem ainda não foi concluída: ela conta como +1.
      return (count ?? 0) + 1;
    },

    async pesarNoChip(org, chipId, patch) {
      let q = db
        .from("disparo_chips")
        .update({ saude: patch.saude, ...(patch.pausadoAte ? { pausado_ate: patch.pausadoAte.toISOString() } : {}) })
        .eq("organization_id", org)
        .eq("id", chipId);
      // Amarelo não rebaixa um vermelho.
      if (patch.saude === "amarelo") q = q.eq("saude", "verde");
      const { error } = await q;
      lancar("pesar_no_chip", error);
    },

    async moverNoFunil(org, leadId, m) {
      return moverCardDoAtendimento(db, { organizationId: org, leadId, ...m });
    },

    async pararConversa(org, leadId, conversationId, motivo) {
      const ids = await conversasDoContato(db, org, leadId, conversationId);
      if (!ids.length) return 0;
      // O mesmo literal e a mesma coluna do `pause-ai` da tela; o `reactivate-bot` devolve.
      const { data, error } = await db
        .from("conversations")
        .update({ bot_silenced_until: "infinity", last_handoff_reason: motivo.slice(0, 200) })
        .eq("organization_id", org)
        .in("id", ids)
        .select("id");
      lancar("parar_conversa", error);
      return (data ?? []).length;
    },

    async moverParaEtapa(org, leadId, m) {
      return moverCardParaEtapa(db, { organizationId: org, leadId, pipelineSlug: m.pipeline, etapaSlug: m.etapa, pontoId: m.pontoId, modo: m.modo });
    },

    async aplicarTag(org, leadId, conversationId, tag) {
      const { data: lead, error } = await db.from("crm_leads").select("tags").eq("organization_id", org).eq("id", leadId).maybeSingle();
      lancar("tag_lead_leitura", error);
      const doLead = ((lead?.tags as string[] | null) ?? []).filter((t) => t !== tag);
      if (lead && !((lead.tags as string[] | null) ?? []).includes(tag)) {
        const { error: e2 } = await db.from("crm_leads").update({ tags: [...doLead, tag] }).eq("organization_id", org).eq("id", leadId);
        lancar("tag_lead", e2);
      }
      for (const id of await conversasDoContato(db, org, leadId, conversationId)) {
        const { data: conv, error: e3 } = await db.from("conversations").select("tags").eq("organization_id", org).eq("id", id).maybeSingle();
        lancar("tag_conversa_leitura", e3);
        const atuais = (conv?.tags as string[] | null) ?? [];
        if (!conv || atuais.includes(tag) || atuais.length >= 20) continue;
        const { error: e4 } = await db.from("conversations").update({ tags: [...atuais, tag] }).eq("organization_id", org).eq("id", id);
        lancar("tag_conversa", e4);
      }
    },

    async avisarCelular(org, a) {
      const { data: lead, error } = await db.from("crm_leads").select("contact_id").eq("organization_id", org).eq("id", a.leadId).maybeSingle();
      lancar("celular_lead", error);

      // O chip de origem é o da conversa onde a lead escreveu: a sessão de canal da conversa
      // aponta para o chip (`disparo_chips.channel_session_id`). Sem conversa conhecida (ensaio),
      // vale o chip pelo qual o lead foi trabalhado. Conversa numa sessão que não é de nenhum
      // chip = sem chip: o aviso NUNCA sai por outro.
      let canalId: string | null = null;
      let chipId: string | null = null;
      let chipNome: string | null = null;
      if (a.conversationId) {
        const { data: conv, error: e0 } = await db.from("conversations").select("channel_session_id").eq("organization_id", org).eq("id", a.conversationId).maybeSingle();
        lancar("celular_conversa", e0);
        canalId = (conv?.channel_session_id as string | null | undefined) ?? null;
        if (canalId) {
          const { data: chips, error: e1 } = await db.from("disparo_chips").select("id, nome").eq("organization_id", org).eq("channel_session_id", canalId).order("nome").limit(1);
          lancar("celular_chip", e1);
          chipId = (chips?.[0]?.id as string | undefined) ?? null;
          chipNome = (chips?.[0]?.nome as string | undefined) ?? null;
        }
      } else if (a.chipId) {
        const { data: chip, error: e1 } = await db.from("disparo_chips").select("id, nome, channel_session_id").eq("organization_id", org).eq("id", a.chipId).maybeSingle();
        lancar("celular_chip_do_lead", e1);
        chipId = (chip?.id as string | undefined) ?? null;
        chipNome = (chip?.nome as string | undefined) ?? null;
        canalId = (chip?.channel_session_id as string | null | undefined) ?? null;
      }

      // `{chip}` no texto vira o nome do chip em que a lead escreveu (o aviso de áudio traz isso).
      const texto = a.texto.replaceAll("{chip}", chipNome ?? "sem chip");
      const real = a.modo === "real";
      const semChip = !chipId || !canalId;
      // Simulado: a linha nasce simulada, como as respostas (e nada fala com canal). Real: pendente,
      // e o motor leva depois do pacote; sem chip de origem não há por onde sair.
      const estado = !real ? "simulado" : semChip ? "cancelado" : "pendente";
      const { error: eIns } = await db.from("disparo_avisos_operador").insert({
        organization_id: org,
        lead_id: a.leadId,
        conversation_id: a.conversationId,
        channel_session_id: canalId,
        chip_id: chipId,
        ponto: a.ponto,
        destino: a.destino,
        texto: texto.slice(0, 2000),
        estado,
        motivo: !real ? "aviso simulado: nada foi enviado ao celular" : semChip ? "sem chip de origem para o aviso" : null,
        enviar_apos: a.enviarApos.toISOString(),
        enviado_em: estado === "simulado" ? a.enviarApos.toISOString() : null,
      });
      if (eIns?.code === "23505") return { desfecho: "ja_havia" as const };
      lancar("celular_aviso", eIns);

      const r = await emitLeadActivity(db, {
        organizationId: org,
        leadId: a.leadId,
        contactId: (lead?.contact_id as string | null | undefined) ?? null,
        type: "note",
        sourceModule: ORIGEM_DO_ATENDIMENTO,
        sourceId: a.leadId,
        actor: { type: "webhook_source", id: ORIGEM_DO_ATENDIMENTO },
        reason: `Aviso ao celular do operador (final ${a.destino.slice(-4)}): ${
          estado === "simulado" ? "simulado, nada foi enviado" : estado === "pendente" ? "na fila, sai pelo chip da conversa depois do pacote" : "sem chip de origem, só registrado"
        }`,
        payload: { destino_final: a.destino.slice(-4), texto, modo: a.modo, ponto: a.ponto, estado, chip_id: chipId },
      });
      if (!r.ok) throw new Error(`atendimento_celular: ${r.error ?? "atividade não gravada"}`);
      return { desfecho: estado === "cancelado" ? ("sem_chip" as const) : estado };
    },
  };
}
