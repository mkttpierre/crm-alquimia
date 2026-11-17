/**
 * `RepositorioDisparo` sobre o Supabase (admin client, service role).
 *
 * Service role bypassa RLS: TODA consulta abaixo filtra `organization_id`, que
 * vem de `disparo_config` (fonte confiável: a linha da própria organização),
 * nunca de corpo de requisição (anti-pattern nº 10 do CLAUDE.md).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { situacaoHumanaDoLead } from "./atendimento/humano-supabase";
import { lerConfigAtendimento } from "./atendimento/config";
import { lerDados } from "./atendimento/estado";
import { noTesteAB } from "./atendimento/venda";
import { TRAVA_DO_LEAD_MS } from "./atendimento/atendimento";
import { conferirRetornoReserva, registrarRetornoReservaEnviado, TIPO_RETORNO_RESERVA } from "./atendimento/retorno-reserva";
import { repositorioAtendimentoSupabase } from "./atendimento/repositorio-supabase";
import { cadenciaPorId, TIPO_CAMPANHA_KIT, TIPO_CAMPANHA_KIT_LEMBRETE } from "./cadencia";
import { chipDasConversasDoLead } from "./chip-da-conversa";
import { semTabela, soltarTrava, tomarTrava } from "./travas-supabase";
import { type ConfigDisparo, escolhaSchema, lerRitmo, modelosSchema, proibidosSchema, slotsSchema } from "./config";
import { podeAbordar } from "./quarentena";
import { naoContatarMarcado } from "./regras";
import { ESTADOS_SAIDOS, type Chip, type Contagem, type EstadoChip, type EstadoEnvio, type SaudeChip } from "./fila";
import { MARCA_NO_CANAL, type AvisoDaFila, type EnvioDaFila, type FimDoAviso, type FimDoEnvio, type LeadDoDisparo, type NovoEnvio, type PatchDoChip, type RepositorioDisparo } from "./motor";
import { inicioDoDia, MIN } from "./ritmo";
import { ehParteSeguinte, JANELA_DA_DECISAO_MS } from "./sequencia-partes";
import type { AberturaSaida, DadosDaSaude, EventoDeConexao, LinhaDaSaudeDoDia, MotivoDaSaude, RespostaDoLead } from "./saude";

export type LinhaChip = {
  id: string;
  nome: string;
  estado: string;
  saude: string;
  dia_rampa: number;
  proximo_envio_em: string | null;
  pausado_ate: string | null;
  envios_desde_pausa: number;
  pausa_a_cada: number;
  saude_calculada_em?: string | null;
  saude_motivo?: string | null;
};

type LinhaEnvio = {
  id: string;
  lead_id: string;
  chip_id: string | null;
  tipo: string;
  origem: string;
  texto: string;
  midia: string | null;
  midia_id: string | null;
  enviar_apos: string;
  estado: string;
  tentativas: number;
  created_at: string;
  da_parada: boolean;
  presenca?: string | null;
  presenca_ms?: number | null;
  motivo?: string | null;
};

const data = (v: string | null) => (v ? new Date(v) : null);

/** Colunas de `disparo_chips` que `chipDaLinha` lê. */
export const COLUNAS_DO_CHIP = "id, nome, estado, saude, dia_rampa, proximo_envio_em, pausado_ate, envios_desde_pausa, pausa_a_cada, saude_calculada_em, saude_motivo";

export function chipDaLinha(l: LinhaChip): Chip {
  return {
    id: l.id,
    nome: l.nome,
    estado: l.estado as EstadoChip,
    saude: l.saude as SaudeChip,
    diaRampa: l.dia_rampa,
    proximoEnvioEm: data(l.proximo_envio_em),
    pausadoAte: data(l.pausado_ate),
    enviosDesdePausa: l.envios_desde_pausa,
    pausaACada: l.pausa_a_cada,
    saudeCalculadaEm: data(l.saude_calculada_em ?? null),
    saudeMotivo: l.saude_motivo ?? null,
  };
}

function envioDaLinha(l: LinhaEnvio): EnvioDaFila {
  return {
    id: l.id,
    leadId: l.lead_id,
    chipId: l.chip_id,
    tipo: l.tipo,
    origem: l.origem as EnvioDaFila["origem"],
    texto: l.texto,
    midia: l.midia,
    midiaId: l.midia_id,
    enviarApos: new Date(l.enviar_apos),
    estado: l.estado as EnvioDaFila["estado"],
    tentativas: l.tentativas,
    criadoEm: new Date(l.created_at),
    daParada: l.da_parada === true,
    presenca: (l.presenca as EnvioDaFila["presenca"]) ?? null,
    presencaMs: l.presenca_ms ?? null,
    motivo: l.motivo ?? null,
  };
}

/** `motivo` vem junto: é ele que diz se o erro da tentativa anterior prova que nada saiu (E2). */
const COLUNAS_ENVIO = "id, lead_id, chip_id, tipo, origem, texto, midia, midia_id, enviar_apos, estado, tentativas, created_at, da_parada, presenca, presenca_ms, motivo";
const COLUNAS_LEAD =
  "id, status, custom_fields, contact:contacts(name, display_name, phone_number, is_blocked, is_anonymized)";

type LinhaLead = {
  id: string;
  status: string;
  custom_fields: Record<string, unknown> | null;
  contact: {
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    is_blocked: boolean;
    is_anonymized: boolean | null;
  } | null;
};

export function leadDaLinha(l: LinhaLead): LeadDoDisparo {
  const campos = l.custom_fields ?? {};
  const grupo = campos["disparo_grupo"];
  return {
    id: l.id,
    // O nome que o texto usa é o `name` do contato, nunca o `display_name`: nas
    // importações o `display_name` cai para o nome da clínica (organização B) ou o do
    // perfil do WhatsApp (exemplo), e os dois CRMs antigos só chamavam pelo nome real.
    nome: l.contact?.name ?? null,
    telefone: l.contact?.phone_number ?? null,
    status: l.status,
    // Lead sem contato não tem para quem mandar: tratado como bloqueado.
    bloqueado: !l.contact || l.contact.is_blocked || naoContatarMarcado(campos),
    anonimizado: Boolean(l.contact?.is_anonymized),
    grupo: typeof grupo === "string" && grupo.trim() ? grupo.trim() : null,
    campos,
  };
}

/** A janela mora em `sequencia-partes.ts` (o laço do motor e este arquivo usam a MESMA definição de "mesma decisão"). */
export { JANELA_DA_DECISAO_MS };
/** Teto de partes lidas por decisão (o maior funil portado tem 7). */
const PARTES_POR_DECISAO = 10;

/**
 * Colapsa os envios saídos (do mais novo ao mais antigo) em uma origem por
 * decisão: auto seguidos criados dentro de `JANELA_DA_DECISAO_MS` são a mesma
 * resposta. Os da decisão de `envio` (mesmo id ou criados junto com ele) saem.
 */
export function origensPorDecisao(
  saidos: { id: string; origem: string; criadoEm: Date }[],
  envio: { id: string; criadoEm: Date },
): string[] {
  const mesma = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) < JANELA_DA_DECISAO_MS;
  const origens: string[] = [];
  let anterior: { origem: string; criadoEm: Date } | null = null;
  for (const s of saidos) {
    if (s.id === envio.id || (s.origem === "auto" && mesma(s.criadoEm, envio.criadoEm))) continue;
    if (!(anterior && anterior.origem === "auto" && s.origem === "auto" && mesma(s.criadoEm, anterior.criadoEm))) origens.push(s.origem);
    anterior = s;
  }
  return origens;
}

/** Página da busca de lead para abertura (a etapa de origem passa de mil leads numa organização). */
const PAGINA_LEADS = 200;

function lancar(contexto: string, erro: { message: string } | null): void {
  if (erro) throw new Error(`disparo_${contexto}: ${erro.message}`);
}

/** Texto literal num padrão LIKE (o nome do chip pode ter `_` ou `%`). */
const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function repositorioSupabase(db: SupabaseClient): RepositorioDisparo {
  /** `comCampanhas`: soma também as campanhas por prefixo (`campanha_<nome>`, que não cabem numa lista fixa). */
  const contar = async (org: string, chipId: string, desde: Date, tipos?: string[], comCampanhas = false) => {
    let q = db
      .from("disparo_envios")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("chip_id", chipId)
      .in("estado", ESTADOS_SAIDOS)
      .neq("origem", "lembrete")
      .gte("enviado_em", desde.toISOString());
    if (tipos) q = comCampanhas ? q.or(`tipo.in.(${tipos.join(",")}),tipo.like.campanha_*`) : q.in("tipo", tipos);
    const { count, error } = await q;
    lancar("contagem", error);
    return count ?? 0;
  };
  const ultimo = async (org: string, chipId: string, tipos?: string[]) => {
    let q = db
      .from("disparo_envios")
      .select("enviado_em")
      .eq("organization_id", org)
      .eq("chip_id", chipId)
      .in("estado", ESTADOS_SAIDOS)
      .neq("origem", "lembrete")
      .order("enviado_em", { ascending: false })
      .limit(1);
    // Além dos passos da cadência, o toque do follow-up do kit e a oferta do Método também são mensagem nova.
    // E as campanhas por prefixo (`campanha_<nome>`), que saem no ritmo de abertura.
    if (tipos) q = q.or(`tipo.in.(${tipos.join(",")}),tipo.like.kit_t*,tipo.like.metodo_oferta_*,tipo.like.campanha_*`).eq("origem", "motor");
    const { data: linhas, error } = await q;
    lancar("ultimo_envio", error);
    return data((linhas?.[0]?.enviado_em as string | undefined) ?? null);
  };

  /** Horários dos avisos ao operador que saíram (ou foram simulados) por este chip desde `desde`. */
  const avisosQueSairam = async (org: string, chipId: string, desde: Date): Promise<Date[]> => {
    const { data: linhas, error } = await db
      .from("disparo_avisos_operador")
      .select("enviado_em")
      .eq("organization_id", org)
      .eq("chip_id", chipId)
      .in("estado", ESTADOS_SAIDOS)
      .gte("enviado_em", desde.toISOString());
    lancar("avisos_do_chip", error);
    return (linhas ?? []).map((l) => new Date(l.enviado_em as string));
  };

  /**
   * Dos candidatos já sem abertura, o primeiro que a quarentena deixa passar: fora de quarentena, sem abordagem
   * fria recente e sem mensagens demais sem resposta no mês. Duas consultas por página, não por lead.
   */
  const primeiroSemQuarentena = async (
    org: string,
    candidatos: LinhaLead[],
    q: NonNullable<NonNullable<Parameters<RepositorioDisparo["proximoLeadParaAbertura"]>[2]>["quarentena"]>,
  ): Promise<LinhaLead | undefined> => {
    if (!candidatos.length) return undefined;
    const ids = candidatos.map((c) => c.id);
    const janela = new Date(q.agora.getTime() - q.cfg.diasEntreAbordagens * 24 * 60 * MIN);
    const [quar, envios] = await Promise.all([
      db.from("disparo_quarentena").select("lead_id, ate").eq("organization_id", org).in("lead_id", ids).gt("ate", q.agora.toISOString()),
      db
        .from("disparo_envios")
        .select("lead_id, tipo, enviado_em")
        .eq("organization_id", org)
        .in("lead_id", ids)
        .eq("origem", "motor")
        .in("estado", ESTADOS_SAIDOS)
        .gte("enviado_em", janela.toISOString()),
    ]);
    lancar("quarentena", quar.error);
    lancar("abordagens_recentes", envios.error);
    const ate = new Map((quar.data ?? []).map((r) => [r.lead_id as string, new Date(r.ate as string)]));
    const ultima = new Map<string, Date>();
    const seguidas = new Map<string, number>();
    for (const e of envios.data ?? []) {
      const lead = e.lead_id as string;
      const quando = new Date(e.enviado_em as string);
      seguidas.set(lead, (seguidas.get(lead) ?? 0) + 1);
      if (e.tipo === "abertura" && (!ultima.get(lead) || quando > ultima.get(lead)!)) ultima.set(lead, quando);
    }
    for (const c of candidatos) {
      const pode = podeAbordar(
        { quarentenaAte: ate.get(c.id) ?? null, ultimaAbordagemEm: ultima.get(c.id) ?? null, semRespostaNoMes: seguidas.get(c.id) ?? 0 },
        q.cfg,
        q.agora,
      );
      if (pode.ok) return c;
    }
    return undefined;
  };

  return {
    async configsLigadas() {
      const { data: linhas, error } = await db
        .from("disparo_config")
        .select("organization_id, modo, teto_diario, cadencia, fonte_stage_id, ritmo, modelos, proibidos, slots, escolha, atendimento")
        .eq("ligado", true);
      lancar("config", error);
      return (linhas ?? []).map(
        (l): ConfigDisparo => ({
          organizationId: l.organization_id as string,
          ligado: true,
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
        }),
      );
    },

    async chipsDaVolta(org) {
      const { data: linhas, error } = await db
        .from("disparo_chips")
        .select("id, nome, estado, saude, dia_rampa, proximo_envio_em, pausado_ate, envios_desde_pausa, pausa_a_cada, saude_calculada_em, saude_motivo")
        .eq("organization_id", org)
        .in("estado", ["rampa", "ativo"])
        .order("nome");
      lancar("chips", error);
      return ((linhas ?? []) as LinhaChip[]).map(chipDaLinha);
    },

    async sessaoConectada(org, chipId) {
      const { data: chip, error } = await db.from("disparo_chips").select("channel_session_id").eq("organization_id", org).eq("id", chipId).maybeSingle();
      lancar("chip_sessao", error);
      if (!chip?.channel_session_id) return false;
      const { data: sessao, error: e2 } = await db.from("channel_sessions").select("status, archived_at").eq("organization_id", org).eq("id", chip.channel_session_id).maybeSingle();
      lancar("sessao_estado", e2);
      return Boolean(sessao && !sessao.archived_at && ["WORKING", "OPEN"].includes(sessao.status.toUpperCase()));
    },

    async tomarTravaDaClasse(org, classe, dono) {
      return tomarTrava(db, org, `classe:${classe}`, dono, 4 * 60_000, new Date(), true);
    },
    async soltarTravaDaClasse(org, classe, dono) {
      await soltarTrava(db, org, `classe:${classe}`, dono);
    },
    async aberturasDaClasseNoDia(org, classe, desde) {
      const ids: string[] = [];
      for (const estado of ["enviado", "simulado", "enviando"]) {
        for (let de = 0; ; de += 200) {
          const { data, error } = await db.from("disparo_envios").select("lead_id")
            .eq("organization_id", org).eq("tipo", "abertura").eq("origem", "motor").eq("estado", estado)
            .gte(estado === "enviando" ? "updated_at" : "enviado_em", desde.toISOString()).order("id").range(de, de + 199);
          lancar("aberturas_classe", error);
          ids.push(...(data ?? []).map((l) => l.lead_id as string));
          if ((data ?? []).length < 200) break;
        }
      }
      let total = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const { count, error } = await db.from("crm_leads").select("id", { count: "exact", head: true })
          .eq("organization_id", org).eq("custom_fields->>classe", classe).in("id", ids.slice(i, i + 100));
        lancar("leads_classe", error);
        total += count ?? 0;
      }
      return total;
    },

    async contagem(org, chipId, agora, fusoMinutos, tiposNovos): Promise<Contagem> {
      const hoje = inicioDoDia(agora, fusoMinutos);
      const umaHora = new Date(agora.getTime() - 3600 * 1000);
      const [enviosHoje, aberturasHoje, enviosUltimaHora, aberturasUltimaHora, ultimoEnvioEm, ultimaNovaEm, avisos] = await Promise.all([
        contar(org, chipId, hoje),
        contar(org, chipId, hoje, ["abertura", TIPO_CAMPANHA_KIT, TIPO_CAMPANHA_KIT_LEMBRETE], true),
        contar(org, chipId, umaHora),
        contar(org, chipId, umaHora, ["abertura", TIPO_CAMPANHA_KIT, TIPO_CAMPANHA_KIT_LEMBRETE], true),
        ultimo(org, chipId),
        ultimo(org, chipId, tiposNovos),
        avisosQueSairam(org, chipId, hoje),
      ]);
      // Aviso ao operador é mensagem do chip como qualquer outra: entra no intervalo
      // mínimo, no máximo por hora e no teto do dia. Não é "nova" (ritmo de abertura).
      const ultimoAviso = avisos.length ? new Date(Math.max(...avisos.map((a) => a.getTime()))) : null;
      return {
        enviosHoje: enviosHoje + avisos.length,
        aberturasHoje,
        enviosUltimaHora: enviosUltimaHora + avisos.filter((a) => a.getTime() >= umaHora.getTime()).length,
        aberturasUltimaHora,
        ultimoEnvioEm: ultimoAviso && (!ultimoEnvioEm || ultimoAviso > ultimoEnvioEm) ? ultimoAviso : ultimoEnvioEm,
        ultimaNovaEm,
      };
    },

    async mandouDesde(org, chipId, desde, ate) {
      const { count, error } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("chip_id", chipId)
        .in("estado", ESTADOS_SAIDOS)
        .gte("enviado_em", desde.toISOString())
        .lt("enviado_em", ate.toISOString());
      lancar("mandou_desde", error);
      return (count ?? 0) > 0;
    },

    async atualizarChip(org, chipId, patch: PatchDoChip, somenteSeVezAte) {
      const linha: Record<string, unknown> = {};
      if (patch.estado !== undefined) linha.estado = patch.estado;
      if (patch.proximoEnvioEm !== undefined) linha.proximo_envio_em = patch.proximoEnvioEm?.toISOString() ?? null;
      if (patch.diaRampa !== undefined) linha.dia_rampa = patch.diaRampa;
      if (patch.enviosDesdePausa !== undefined) linha.envios_desde_pausa = patch.enviosDesdePausa;
      if (patch.pausaACada !== undefined) linha.pausa_a_cada = patch.pausaACada;
      if (patch.pausadoAte !== undefined) linha.pausado_ate = patch.pausadoAte?.toISOString() ?? null;
      if (patch.saude !== undefined) linha.saude = patch.saude;
      if (patch.saudeMotivo !== undefined) linha.saude_motivo = patch.saudeMotivo;
      if (patch.saudeCalculadaEm !== undefined) linha.saude_calculada_em = patch.saudeCalculadaEm?.toISOString() ?? null;
      let q = db.from("disparo_chips").update(linha).eq("organization_id", org).eq("id", chipId);
      if (somenteSeVezAte) {
        q = q.or(`proximo_envio_em.is.null,proximo_envio_em.lte.${somenteSeVezAte.toISOString()}`);
      }
      const { data: linhas, error } = await q.select("id");
      lancar("chip", error);
      return (linhas ?? []).length > 0;
    },

    async proximoLeadParaAbertura(org, fonteStageId, filtro) {
      // Página a página até achar um lead sem abertura: com só a primeira
      // página, a etapa de origem "secava" quando os primeiros N já tinham sido
      // abertos, e o motor parava com milhares de leads ainda esperando.
      for (const classe of filtro?.classes?.length ? filtro.classes : [null]) {
      for (let de = 0; ; de += PAGINA_LEADS) {
        let consulta = db
          .from("crm_leads")
          .select(COLUNAS_LEAD)
          .eq("organization_id", org)
          .eq("stage_id", fonteStageId)
          .eq("status", "open");
        // Restrições da organização (exemplo: chip dono do lead, classes de ataque, sem pendência do operador).
        if (filtro?.chipOrigem) consulta = consulta.eq("custom_fields->>chip_origem", filtro.chipOrigem);
        if (classe !== null) consulta = consulta.eq("custom_fields->>classe", classe);
        for (const [campo, valor] of Object.entries(filtro?.camposIguais ?? {})) {
          if (/^[a-z_0-9]+$/.test(campo)) consulta = consulta.eq(`custom_fields->>${campo}`, valor);
        }
        if (filtro?.semPendenciaOperador) {
          consulta = consulta.or("custom_fields->>precisa_operador.is.null,custom_fields->>precisa_operador.neq.true");
        }
        const { data: linhas, error } = await consulta
          .order("position_in_stage")
          .order("created_at")
          .order("id")
          .range(de, de + PAGINA_LEADS - 1);
        lancar("leads", error);
        const candidatos = (linhas ?? []) as unknown as LinhaLead[];
        if (!candidatos.length) break;
        const { data: ja, error: e2 } = await db
          .from("disparo_envios")
          .select("lead_id")
          .eq("organization_id", org)
          .eq("tipo", "abertura")
          .in("lead_id", candidatos.map((c) => c.id));
        lancar("leads_ja_abertos", e2);
        const usados = new Set((ja ?? []).map((r) => r.lead_id as string));
        const livres = candidatos.filter((c) => !usados.has(c.id));
        const livre = filtro?.quarentena ? await primeiroSemQuarentena(org, livres, filtro.quarentena) : livres[0];
        if (livre) return leadDaLinha(livre);
        if (candidatos.length < PAGINA_LEADS) break;
      }
      }
      return null;
    },

    async enfileirar(org, e: NovoEnvio) {
      const { data: linha, error } = await db
        .from("disparo_envios")
        .insert({
          organization_id: org,
          lead_id: e.leadId,
          chip_id: e.chipId,
          tipo: e.tipo,
          origem: e.origem,
          texto: e.texto,
          midia_id: e.midiaId ?? null,
          enviar_apos: e.enviarApos.toISOString(),
          estado: e.estado ?? "pendente",
          motivo: e.motivo ?? null,
        })
        .select(COLUNAS_ENVIO)
        .single();
      if (error?.code === "23505") return null;
      lancar("enfileirar", error);
      return envioDaLinha(linha as LinhaEnvio);
    },

    async midiaDaAberturaValida(org, id) {
      const { data, error } = await db.from("media_library").select("kind, storage_path").eq("organization_id", org).eq("id", id).maybeSingle();
      lancar("midia_da_abertura", error);
      if (!data || data.kind !== "image" || !String(data.storage_path).startsWith(`${org}/biblioteca/`)) return false;
      const arquivo = await db.storage.from("whatsapp-media").download(data.storage_path);
      if (arquivo.error) {
        if (arquivo.error.statusCode === "404") return false;
        throw new Error(`prévia: não foi possível conferir o arquivo (${arquivo.error.message})`);
      }
      return !!arquivo.data;
    },
    async enfileirarAberturaComPartes(org, partes) {
      const { data, error } = await db.from("disparo_envios").insert(partes.map((e) => ({
        organization_id: org, lead_id: e.leadId, chip_id: e.chipId, tipo: e.tipo, origem: e.origem,
        texto: e.texto, midia_id: e.midiaId ?? null, enviar_apos: e.enviarApos.toISOString(),
        estado: e.estado ?? "pendente", motivo: e.motivo ?? null,
      }))).select(COLUNAS_ENVIO);
      if (error?.code === "23505") return null;
      lancar("enfileirar_abertura_com_partes", error);
      const primeira = (data as LinhaEnvio[] | null)?.find((e) => e.tipo === "abertura");
      return primeira ? envioDaLinha(primeira) : null;
    },
    async estadoParteAbertura(org, leadId, tipo) {
      const { data, error } = await db.from("disparo_envios").select("estado").eq("organization_id", org).eq("lead_id", leadId).eq("origem", "motor").eq("tipo", tipo).order("created_at", { ascending: false }).limit(1).maybeSingle();
      lancar("estado_parte_abertura", error);
      return (data?.estado as EstadoEnvio | undefined) ?? null;
    },

    async tomarTravaDoLead(org, leadId, dono) {
      return tomarTrava(db, org, "lead:" + leadId, dono, TRAVA_DO_LEAD_MS);
    },
    async soltarTravaDoLead(org, leadId, dono) {
      await soltarTrava(db, org, "lead:" + leadId, dono);
    },
    async retornosPendentes(org) {
      const { data, error } = await db.from("disparo_envios").select(COLUNAS_ENVIO)
        .eq("organization_id", org).eq("tipo", TIPO_RETORNO_RESERVA).eq("estado", "pendente").order("created_at").limit(1000);
      lancar("retornos_pendentes", error);
      return ((data ?? []) as LinhaEnvio[]).map(envioDaLinha);
    },
    async conferirRetornoReserva(org, envio, agora) {
      return conferirRetornoReserva(repositorioAtendimentoSupabase(db), org, envio, agora);
    },
    async retornoReservaEnviado(org, envio, agora, modo) {
      await registrarRetornoReservaEnviado(repositorioAtendimentoSupabase(db), org, envio, agora, modo);
    },

    async vencidos(org, chipId, agora, limite) {
      // Resposta ao lead (auto) e sequência do operador (funil de valores) passam na frente de abertura/campanha/toque:
      // senão ficam atrás de uma fila antiga de campanha (enviar_apos velho de propósito) e vencem sem sair.
      const consulta = (origens: "prioridade" | "resto", n: number) => {
        const q = db
          .from("disparo_envios")
          .select(COLUNAS_ENVIO)
          .eq("organization_id", org)
          .eq("chip_id", chipId)
          .eq("estado", "pendente")
          .neq("origem", "lembrete")
          .lte("enviar_apos", agora.toISOString());
        return (origens === "prioridade" ? q.in("origem", ["auto", "operador"]) : q.not("origem", "in", "(auto,operador)"))
          .order("enviar_apos")
          .limit(n);
      };
      const { data: prio, error: erroPrio } = await consulta("prioridade", limite);
      lancar("vencidos", erroPrio);
      const primeiras = (prio ?? []) as LinhaEnvio[];
      if (primeiras.length >= limite) return primeiras.map(envioDaLinha);
      const { data: resto, error } = await consulta("resto", limite - primeiras.length);
      lancar("vencidos", error);
      return [...primeiras, ...((resto ?? []) as LinhaEnvio[])].map(envioDaLinha);
    },

    async lembretesVencidos(org, agora, limite) {
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .select(COLUNAS_ENVIO)
        .eq("organization_id", org)
        .eq("estado", "pendente")
        .eq("origem", "lembrete")
        .lte("enviar_apos", agora.toISOString())
        .order("enviar_apos")
        .limit(limite);
      lancar("lembretes", error);
      return ((linhas ?? []) as LinhaEnvio[]).map(envioDaLinha);
    },

    async reservar(org, envioId, dono) {
      // E5 (migration 0252): a reserva grava o dono; a marca de canal e o desfecho dados com ele conferem.
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .update({ estado: "enviando", reservado_por: dono ?? null })
        .eq("organization_id", org)
        .eq("id", envioId)
        .eq("estado", "pendente")
        .select("id");
      lancar("reservar", error);
      return (linhas ?? []).length > 0;
    },

    async finalizar(org, envioId, fim: FimDoEnvio, somenteSeEstado, dono) {
      const linha: Record<string, unknown> = { estado: fim.estado };
      if (fim.motivo !== undefined) linha.motivo = fim.motivo;
      if (fim.enviadoEm !== undefined) linha.enviado_em = fim.enviadoEm?.toISOString() ?? null;
      if (fim.externalId !== undefined) linha.external_id = fim.externalId;
      if (fim.tentativas !== undefined) linha.tentativas = fim.tentativas;
      if (fim.enviarApos !== undefined) linha.enviar_apos = fim.enviarApos.toISOString();
      let q = db.from("disparo_envios").update(linha).eq("organization_id", org).eq("id", envioId);
      if (somenteSeEstado) q = q.eq("estado", somenteSeEstado);
      if (dono) q = q.eq("reservado_por", dono);
      const { error } = await q;
      lancar("finalizar", error);
    },

    async lead(org, leadId) {
      const { data: linha, error } = await db
        .from("crm_leads")
        .select(COLUNAS_LEAD)
        .eq("organization_id", org)
        .eq("id", leadId)
        .maybeSingle();
      lancar("lead", error);
      return linha ? leadDaLinha(linha as unknown as LinhaLead) : null;
    },

    async respostasDesde(org, leadId, desde) {
      const { data: lead, error } = await db
        .from("crm_leads")
        .select("contact_id")
        .eq("organization_id", org)
        .eq("id", leadId)
        .maybeSingle();
      lancar("lead_contato", error);
      if (!lead?.contact_id) return [];
      const { data: linhas, error: e2 } = await db
        .from("messages")
        .select("body, metadata")
        .eq("organization_id", org)
        .eq("contact_id", lead.contact_id)
        .eq("direction", "inbound")
        .gt("created_at", desde.toISOString())
        .order("created_at")
        .limit(20);
      lancar("respostas", e2);
      return (linhas ?? [])
        .filter((m) => (m.metadata as Record<string, unknown> | null)?.["automatica"] !== true)
        .map((m) => (m.body as string | null) ?? "");
    },

    async origensRecentes(org, leadId, limite, envio) {
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .select("id, origem, created_at")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .in("estado", ESTADOS_SAIDOS)
        .order("enviado_em", { ascending: false })
        .limit(limite * PARTES_POR_DECISAO);
      lancar("origens", error);
      return origensPorDecisao(
        ((linhas ?? []) as { id: string; origem: string; created_at: string }[]).map((l) => ({
          id: l.id,
          origem: l.origem,
          criadoEm: new Date(l.created_at),
        })),
        envio,
      ).slice(0, limite);
    },

    async marcarSemWhatsapp(org, leadId) {
      const { data: lead, error } = await db.from("crm_leads").select("custom_fields").eq("organization_id", org).eq("id", leadId).maybeSingle();
      lancar("nao_contatar_leitura", error);
      if (!lead) throw new Error("lead nao encontrado ao marcar sem WhatsApp");
      const campos = (lead.custom_fields as Record<string, unknown> | null) ?? {};
      const { error: e2 } = await db.from("crm_leads")
        .update({ custom_fields: { ...campos, nao_contatar: true, nao_contatar_motivo: "sem_whatsapp" } })
        .eq("organization_id", org).eq("id", leadId);
      lancar("nao_contatar", e2);
    },

    async cancelarPendentesDoLead(org, leadId, motivo, poupaParada = false, origem, poupaRetorno = false) {
      let q = db
        .from("disparo_envios")
        .update({ estado: "cancelado", motivo })
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("estado", "pendente");
      if (poupaParada) q = q.eq("da_parada", false);
      if (origem) q = q.eq("origem", origem);
      if (poupaRetorno) q = q.neq("tipo", TIPO_RETORNO_RESERVA);
      const { data: linhas, error } = await q.select("id");
      lancar("cancelar_pendentes", error);
      return (linhas ?? []).length;
    },

    async situacaoHumana(org, leadId) {
      return situacaoHumanaDoLead(db, org, leadId, null);
    },

    async autoEmAberto(org, leadId) {
      const { count, error } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", "auto")
        .neq("tipo", TIPO_RETORNO_RESERVA)
        .in("estado", ["pendente", "enviando"]);
      lancar("auto_em_aberto_do_lead", error);
      return (count ?? 0) > 0;
    },

    async avisosVencidos(org, chipId, agora, limite) {
      const { data: linhas, error } = await db
        .from("disparo_avisos_operador")
        .select("id, lead_id, chip_id, channel_session_id, destino, texto, enviar_apos, tentativas")
        .eq("organization_id", org)
        .eq("chip_id", chipId)
        .eq("estado", "pendente")
        .lte("enviar_apos", agora.toISOString())
        .order("enviar_apos")
        .limit(limite);
      lancar("avisos_vencidos", error);
      return (linhas ?? []).map(
        (l): AvisoDaFila => ({
          id: l.id as string,
          leadId: l.lead_id as string,
          chipId: (l.chip_id as string | null) ?? null,
          canalId: (l.channel_session_id as string | null) ?? null,
          destino: l.destino as string,
          texto: l.texto as string,
          enviarApos: new Date(l.enviar_apos as string),
          tentativas: l.tentativas as number,
        }),
      );
    },

    async reservarAviso(org, avisoId) {
      const { data: linhas, error } = await db
        .from("disparo_avisos_operador")
        .update({ estado: "enviando" })
        .eq("organization_id", org)
        .eq("id", avisoId)
        .eq("estado", "pendente")
        .select("id");
      lancar("reservar_aviso", error);
      return (linhas ?? []).length > 0;
    },

    async finalizarAviso(org, avisoId, fim: FimDoAviso) {
      const linha: Record<string, unknown> = { estado: fim.estado };
      if (fim.motivo !== undefined) linha.motivo = fim.motivo;
      if (fim.enviadoEm !== undefined) linha.enviado_em = fim.enviadoEm?.toISOString() ?? null;
      if (fim.externalId !== undefined) linha.external_id = fim.externalId;
      if (fim.tentativas !== undefined) linha.tentativas = fim.tentativas;
      if (fim.enviarApos !== undefined) linha.enviar_apos = fim.enviarApos.toISOString();
      const { error } = await db.from("disparo_avisos_operador").update(linha).eq("organization_id", org).eq("id", avisoId);
      lancar("finalizar_aviso", error);
    },

    async autoEmAbertoAntes(org, leadId, envioId, antesDe, origem = "auto") {
      const { count, error } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", origem)
        .neq("tipo", TIPO_RETORNO_RESERVA)
        .neq("id", envioId)
        .or(`estado.eq.enviando,and(estado.eq.pendente,enviar_apos.lt.${antesDe.toISOString()})`);
      lancar("auto_em_aberto", error);
      return (count ?? 0) > 0;
    },

    async adiarAutoDoLead(org, leadId, depoisDe, ms, origem = "auto") {
      if (ms <= 0) return 0;
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .select("id, enviar_apos")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", origem)
        .eq("estado", "pendente")
        .neq("tipo", TIPO_RETORNO_RESERVA)
        .gt("enviar_apos", depoisDe.toISOString());
      lancar("adiar_auto", error);
      for (const l of linhas ?? []) {
        const nova = new Date(new Date(l.enviar_apos as string).getTime() + ms).toISOString();
        const { error: e2 } = await db
          .from("disparo_envios")
          .update({ enviar_apos: nova })
          .eq("organization_id", org)
          .eq("id", l.id as string)
          .eq("estado", "pendente");
        lancar("adiar_auto", e2);
      }
      return (linhas ?? []).length;
    },

    async proximaParteDaSequencia(org, chipId, ref) {
      // Pendentes do mesmo lead, chip e origem, da mais próxima à mais distante; o predicado compartilhado
      // (`ehParteSeguinte`) decide qual delas é desta sequência. 50 cobre o maior follow-up (7 toques + oferta, em partes).
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .select(COLUNAS_ENVIO)
        .eq("organization_id", org)
        .eq("chip_id", chipId)
        .eq("lead_id", ref.leadId)
        .eq("origem", ref.origem)
        .eq("estado", "pendente")
        .order("enviar_apos")
        .limit(50);
      lancar("proxima_da_sequencia", error);
      return ((linhas ?? []) as LinhaEnvio[]).map(envioDaLinha).find((c) => ehParteSeguinte(ref, c)) ?? null;
    },

    async anotarMotivoDaFila(org, envioId, motivo) {
      // Só enquanto a linha ainda é `pendente`: nunca devolve a `pendente` uma linha que outra volta já reservou.
      const { error } = await db
        .from("disparo_envios")
        .update({ motivo })
        .eq("organization_id", org)
        .eq("id", envioId)
        .eq("estado", "pendente");
      lancar("anotar_motivo", error);
    },

    async criadosDesde(org, tipo, desde) {
      const { count, error } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("tipo", tipo)
        .gte("created_at", desde.toISOString());
      lancar("criados", error);
      return count ?? 0;
    },

    async lembretesNoDia(org, tipo, inicio, fim) {
      const { count, error } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("tipo", tipo)
        .eq("origem", "lembrete")
        .neq("estado", "cancelado")
        .gte("enviar_apos", inicio.toISOString())
        .lt("enviar_apos", fim.toISOString());
      lancar("lembretes_no_dia", error);
      return count ?? 0;
    },

    async criarTarefa(org, t) {
      const { data: lead, error } = await db
        .from("crm_leads")
        .select("contact_id")
        .eq("organization_id", org)
        .eq("id", t.leadId)
        .maybeSingle();
      lancar("tarefa_lead", error);
      const { data: linha, error: e2 } = await db
        .from("crm_tasks")
        .insert({
          organization_id: org,
          title: t.titulo,
          description: t.descricao,
          due_date: t.prazo.toISOString(),
          priority: "high",
          status: "pending",
          lead_id: t.leadId,
          contact_id: (lead?.contact_id as string | null | undefined) ?? null,
        })
        .select("id")
        .single();
      lancar("tarefa", e2);
      return (linha as { id: string }).id;
    },

    async saiuEm(org, leadId, tipo) {
      const { data: linha, error } = await db
        .from("disparo_envios")
        .select("enviado_em")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("tipo", tipo)
        .in("estado", ESTADOS_SAIDOS)
        .maybeSingle();
      lancar("saiu_em", error);
      return data((linha?.enviado_em as string | undefined) ?? null);
    },

    async dadosDaSaude(org, chipId, p): Promise<DadosDaSaude> {
      const janela = new Date(p.agora.getTime() - p.janelaDias * 24 * 60 * MIN);
      const inicio = p.desde.getTime() < janela.getTime() ? p.desde : janela;
      const [{ data: envios, error: e1 }, { data: chip, error: e2 }] = await Promise.all([
        db
          .from("disparo_envios")
          .select("lead_id, estado, enviado_em, ack, entregue_em")
          .eq("organization_id", org)
          .eq("chip_id", chipId)
          .eq("tipo", "abertura")
          .in("estado", ESTADOS_SAIDOS)
          .gte("enviado_em", inicio.toISOString())
          .limit(5000),
        db.from("disparo_chips").select("channel_session_id").eq("organization_id", org).eq("id", chipId).maybeSingle(),
      ]);
      lancar("saude_aberturas", e1);
      lancar("saude_chip", e2);
      const aberturas: AberturaSaida[] = (envios ?? []).map((e) => ({
        leadId: e.lead_id as string,
        estado: e.estado === "enviado" ? "enviado" : "simulado",
        enviadoEm: new Date(e.enviado_em as string),
        ack: (e.ack as number | null) ?? null,
        entregueEm: data((e.entregue_em as string | null) ?? null),
      }));

      // Respostas: mensagens de gente dos contatos desses leads, desde o começo da janela.
      const respostas: RespostaDoLead[] = [];
      const leadIds = [...new Set(aberturas.map((a) => a.leadId))];
      for (let i = 0; i < leadIds.length; i += 100) {
        const lote = leadIds.slice(i, i + 100);
        const { data: leads, error: e3 } = await db.from("crm_leads").select("id, contact_id").eq("organization_id", org).in("id", lote);
        lancar("saude_leads", e3);
        const porContato = new Map<string, string>();
        for (const l of leads ?? []) if (l.contact_id) porContato.set(l.contact_id as string, l.id as string);
        if (!porContato.size) continue;
        const { data: msgs, error: e4 } = await db
          .from("messages")
          .select("contact_id, body, metadata, created_at")
          .eq("organization_id", org)
          .eq("direction", "inbound")
          .in("contact_id", [...porContato.keys()])
          .gte("created_at", inicio.toISOString())
          .limit(5000);
        lancar("saude_respostas", e4);
        for (const m of msgs ?? []) {
          if ((m.metadata as Record<string, unknown> | null)?.["automatica"] === true) continue;
          const leadId = porContato.get(m.contact_id as string);
          if (leadId) respostas.push({ leadId, texto: (m.body as string | null) ?? "", em: new Date(m.created_at as string) });
        }
      }

      const conexao: EventoDeConexao[] = [];
      if (chip?.channel_session_id) {
        const { data: eventos, error: e5 } = await db
          .from("disparo_eventos_conexao")
          .select("estado, codigo, ocorrido_em")
          .eq("organization_id", org)
          .eq("channel_session_id", chip.channel_session_id as string)
          .gte("ocorrido_em", p.desde.toISOString())
          .order("ocorrido_em")
          .limit(500);
        lancar("saude_conexao", e5);
        for (const e of eventos ?? []) {
          conexao.push({ estado: e.estado as string, codigo: (e.codigo as number | null) ?? null, em: new Date(e.ocorrido_em as string) });
        }
      }
      return { aberturas, respostas, conexao };
    },

    async saudeDoDia(org, chipId, dia) {
      const { data: linha, error } = await db
        .from("disparo_saude_dia")
        .select("saude, motivos, calculado_em")
        .eq("organization_id", org)
        .eq("chip_id", chipId)
        .eq("dia", dia)
        .maybeSingle();
      lancar("saude_do_dia", error);
      if (!linha) return null;
      return {
        saude: linha.saude as SaudeChip,
        motivos: (Array.isArray(linha.motivos) ? linha.motivos : []) as MotivoDaSaude[],
        calculadoEm: new Date(linha.calculado_em as string),
      };
    },

    async gravarSaudeDoDia(org, l: LinhaDaSaudeDoDia) {
      const { error } = await db.from("disparo_saude_dia").upsert(
        {
          organization_id: org,
          chip_id: l.chipId,
          dia: l.dia,
          saude: l.saude,
          dia_rampa: l.diaRampa,
          estado_chip: l.estadoChip,
          aberturas: l.sinais.aberturas,
          respostas: l.sinais.respostas,
          aberturas_janela: l.sinais.aberturasJanela,
          respostas_janela: l.sinais.respostasJanela,
          maduras: l.sinais.maduras,
          com_ack: l.sinais.comAck,
          bloqueio_provavel: l.sinais.bloqueioProvavel,
          nao_quero: l.sinais.naoQuero,
          irritacao: l.sinais.irritacao,
          reconexoes: l.sinais.reconexoes,
          quedas: l.sinais.quedas,
          motivos: l.motivos,
          calculado_em: l.calculadoEm.toISOString(),
        },
        { onConflict: "organization_id,chip_id,dia" },
      );
      lancar("gravar_saude_do_dia", error);
    },

    async semRespostaDesde(org, leadId, desde) {
      const { data: lead, error } = await db.from("crm_leads").select("contact_id").eq("organization_id", org).eq("id", leadId).maybeSingle();
      lancar("sem_resposta_lead", error);
      let corte = desde;
      if (lead?.contact_id) {
        const { data: ultima, error: e2 } = await db
          .from("messages")
          .select("created_at")
          .eq("organization_id", org)
          .eq("contact_id", lead.contact_id as string)
          .eq("direction", "inbound")
          .gte("created_at", desde.toISOString())
          .order("created_at", { ascending: false })
          .limit(1);
        lancar("sem_resposta_ultima", e2);
        const quando = ultima?.[0]?.created_at as string | undefined;
        if (quando) corte = new Date(quando);
      }
      const { count, error: e3 } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .eq("origem", "motor")
        // A imagem e o fecho da abertura com prévia são a mesma mensagem da abertura: contam uma vez só.
        .not("tipo", "like", "abertura_p%")
        .in("estado", ESTADOS_SAIDOS)
        .gt("enviado_em", corte.toISOString());
      lancar("sem_resposta_contagem", e3);
      return count ?? 0;
    },

    async situacaoDoKit(org, leadId) {
      const [lead, conversa, config, quarentena] = await Promise.all([
        db.from("crm_leads").select("custom_fields").eq("organization_id", org).eq("id", leadId).maybeSingle(),
        db.from("disparo_conversas").select("precisa_operador, dados").eq("organization_id", org).eq("lead_id", leadId).maybeSingle(),
        db.from("disparo_config").select("atendimento").eq("organization_id", org).maybeSingle(),
        db.from("disparo_quarentena").select("ate").eq("organization_id", org).eq("lead_id", leadId).maybeSingle(),
      ]);
      lancar("kit_lead", lead.error);
      lancar("kit_conversa", conversa.error);
      lancar("kit_config", config.error);
      lancar("kit_quarentena", quarentena.error);
      const campos = lead.data?.custom_fields as Record<string, unknown> | null;
      const trilha = campos?.["trilha"];
      const at = lerConfigAtendimento(config.data?.atendimento);
      const trilhas = at?.perfil === "venda" ? (at.clientes?.trilhas ?? []) : [];
      const dados = conversa.data ? lerDados(conversa.data.dados) : null;
      return {
        // Lead do teste A/B não é cliente, mesmo na trilha de cliente (a mesma regra de `ehCliente`).
        cliente: !noTesteAB(campos) && typeof trilha === "string" && trilhas.includes(trilha),
        metodoPago: Boolean(dados && (dados.metodo.etapa === "pago" || dados.vipDescontoPct > 0)),
        precisaOperador: Boolean(conversa.data?.precisa_operador),
        quarentenaAte: quarentena.data?.ate ? new Date(quarentena.data.ate as string) : null,
      };
    },

    async tomarTravaDoChip(org, chipId, dono, prazoMs) {
      return tomarTrava(db, org, `chip:${chipId}`, dono, prazoMs);
    },

    async soltarTravaDoChip(org, chipId, dono) {
      await soltarTrava(db, org, `chip:${chipId}`, dono);
    },

    async registrarVolta(org, v) {
      const { error } = await db.from("disparo_voltas").upsert(
        {
          organization_id: org,
          inicio: v.inicio.toISOString(),
          fim: v.fim.toISOString(),
          duracao_ms: Math.round(v.duracaoMs),
          efeito: v.efeito,
          resultado: v.resultado,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id" },
      );
      if (semTabela(error)) return;
      lancar("registrar_volta", error);
    },

    async saiuDesde(org, desde) {
      const { count, error } = await db
        .from("disparo_envios")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .in("estado", ESTADOS_SAIDOS)
        .neq("origem", "lembrete")
        .gte("enviado_em", desde.toISOString());
      lancar("saiu_desde", error);
      return (count ?? 0) > 0;
    },

    async marcarNoCanal(org, envioId, dono) {
      let q = db
        .from("disparo_envios")
        .update({ motivo: MARCA_NO_CANAL })
        .eq("organization_id", org)
        .eq("id", envioId)
        .eq("estado", "enviando");
      // E5: `enviando` sozinho não prova que a reserva é desta volta (a varredura pode tê-la devolvido e outra volta,
      // reservado de novo). Com o dono, a marca só passa na reserva desta volta.
      if (dono) q = q.eq("reservado_por", dono);
      const { data: linhas, error } = await q.select("id");
      lancar("marcar_no_canal", error);
      // Se não marcou, o canal não é chamado.
      if (!(linhas ?? []).length) throw new Error("disparo_marcar_no_canal: a linha não está mais em enviando por esta volta");
    },

    async enviandoPresos(org, antesDe, limite) {
      // `updated_at` (trigger) = quando a linha entrou em `enviando` (ou recebeu a marca de chamada ao canal).
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .select(`${COLUNAS_ENVIO}, external_id, updated_at`)
        .eq("organization_id", org)
        .eq("estado", "enviando")
        .lt("updated_at", antesDe.toISOString())
        .order("updated_at")
        .limit(limite);
      lancar("enviando_presos", error);
      return ((linhas ?? []) as (LinhaEnvio & { external_id: string | null; updated_at: string })[]).map((l) => ({
        ...envioDaLinha(l),
        externalId: l.external_id,
        motivo: l.motivo ?? null,
        reservadoEm: new Date(l.updated_at),
      }));
    },

    async semChip(org, agora, limite) {
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .select(COLUNAS_ENVIO)
        .eq("organization_id", org)
        .eq("estado", "pendente")
        .is("chip_id", null)
        .neq("origem", "lembrete")
        .lte("enviar_apos", agora.toISOString())
        .order("enviar_apos")
        .limit(limite);
      lancar("sem_chip", error);
      return ((linhas ?? []) as LinhaEnvio[]).map(envioDaLinha);
    },

    async chipPelaConversa(org, leadId) {
      return chipDasConversasDoLead(db, org, leadId);
    },

    async atribuirChip(org, envioId, chipId) {
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .update({ chip_id: chipId })
        .eq("organization_id", org)
        .eq("id", envioId)
        .eq("estado", "pendente")
        .is("chip_id", null)
        .select("id");
      lancar("atribuir_chip", error);
      return (linhas ?? []).length > 0;
    },

    async avisarCentral(org, a) {
      if (a.umaVezDesde) {
        const { count, error } = await db
          .from("agent_inbox_items")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org)
          .eq("kind", "other")
          .eq("title", a.titulo.slice(0, 200))
          .gte("created_at", a.umaVezDesde.toISOString());
        lancar("central_ja_avisou", error);
        if ((count ?? 0) > 0) return false;
      }
      const { error } = await db.from("agent_inbox_items").insert({
        organization_id: org,
        kind: "other",
        severity: a.nivel,
        title: a.titulo.slice(0, 200),
        body: a.corpo.slice(0, 2000),
        ref_kind: a.leadId ? "lead" : null,
        ref_id: a.leadId ?? null,
      });
      lancar("central", error);
      return true;
    },

    async enviosRecentesDoChip(org, chipId, desde, limite) {
      // Só envio REAL que o canal aceitou (com `key.id`): o simulado e o lembrete nunca têm ack.
      const { data: linhas, error } = await db
        .from("disparo_envios")
        .select("enviado_em, ack, entregue_em, lido_em")
        .eq("organization_id", org)
        .eq("chip_id", chipId)
        .eq("estado", "enviado")
        .not("external_id", "is", null)
        .gte("enviado_em", desde.toISOString())
        .order("enviado_em", { ascending: false })
        .limit(limite);
      lancar("envios_do_chip", error);
      return (linhas ?? []).map((l) => ({
        enviadoEm: new Date(l.enviado_em as string),
        ack: (l.ack as number | null) ?? null,
        entregueEm: data((l.entregue_em as string | null) ?? null),
        lidoEm: data((l.lido_em as string | null) ?? null),
      }));
    },

    async avisoVivo(org, chave) {
      const base = () =>
        db
          .from("agent_inbox_items")
          .select("id, title, body, created_at")
          .eq("organization_id", org)
          .eq("kind", "other")
          .like("title", `${escaparLike(chave.prefixo)}%`);
      const [aberto, ultimo] = await Promise.all([
        base().eq("status", "open").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        base().order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      lancar("aviso_vivo_aberto", aberto.error);
      lancar("aviso_vivo_ultimo", ultimo.error);
      const a = aberto.data;
      return {
        aberto: a ? { id: a.id as string, titulo: a.title as string, corpo: (a.body as string | null) ?? "", criadoEm: new Date(a.created_at as string) } : null,
        ultimoEm: ultimo.data ? new Date(ultimo.data.created_at as string) : null,
      };
    },

    async gravarAvisoVivo(org, chave, aviso, quando) {
      if (!aviso) {
        const { error } = await db
          .from("agent_inbox_items")
          .update({ status: "resolved", resolved_at: quando.toISOString() })
          .eq("organization_id", org)
          .eq("kind", "other")
          .like("title", `${escaparLike(chave.prefixo)}%`)
          .eq("status", "open");
        lancar("aviso_vivo_fechar", error);
        return;
      }
      const { data: atual, error } = await db
        .from("agent_inbox_items")
        .select("id")
        .eq("organization_id", org)
        .eq("kind", "other")
        .like("title", `${escaparLike(chave.prefixo)}%`)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      lancar("aviso_vivo_ler", error);
      const linha = { title: aviso.titulo.slice(0, 200), body: aviso.corpo.slice(0, 2000), severity: aviso.nivel };
      if (atual) {
        const { error: e2 } = await db.from("agent_inbox_items").update(linha).eq("organization_id", org).eq("id", atual.id as string);
        lancar("aviso_vivo_atualizar", e2);
        return;
      }
      // `created_at` = o instante da volta: é dele que o chip mudo conta os envios de novo.
      const { error: e3 } = await db
        .from("agent_inbox_items")
        .insert({ organization_id: org, kind: "other", ...linha, ref_kind: null, ref_id: null, created_at: quando.toISOString() });
      lancar("aviso_vivo_criar", e3);
    },

    async situacaoDosChips(org) {
      const { data: chips, error } = await db
        .from("disparo_chips")
        .select("id, nome, estado, saude, pausado_ate, channel_session_id")
        .eq("organization_id", org)
        .order("nome");
      lancar("situacao_dos_chips", error);
      const sessoes = [...new Set((chips ?? []).map((c) => c.channel_session_id as string | null).filter((s): s is string => Boolean(s)))];
      const conexoes = new Map<string, string>();
      if (sessoes.length) {
        const { data: linhas, error: e2 } = await db.from("channel_sessions").select("id, status, archived_at").eq("organization_id", org).in("id", sessoes);
        lancar("situacao_das_conexoes", e2);
        for (const s of linhas ?? []) conexoes.set(s.id as string, s.archived_at ? "ARQUIVADA" : String(s.status));
      }
      return (chips ?? []).map((c) => ({
        id: c.id as string,
        nome: c.nome as string,
        estado: c.estado as EstadoChip,
        saude: c.saude as SaudeChip,
        pausadoAte: data((c.pausado_ate as string | null) ?? null),
        conexao: c.channel_session_id ? (conexoes.get(c.channel_session_id as string) ?? null) : null,
      }));
    },

    async vencidosDoChip(org, chipId, agora) {
      const base = (colunas: string, opcoes?: { count: "exact"; head: true }) =>
        db
          .from("disparo_envios")
          .select(colunas, opcoes)
          .eq("organization_id", org)
          .eq("chip_id", chipId)
          .eq("estado", "pendente")
          .neq("origem", "lembrete")
          .lte("enviar_apos", agora.toISOString());
      const [contagem, maisAntigo] = await Promise.all([
        base("id", { count: "exact", head: true }),
        base("enviar_apos").order("enviar_apos").limit(1).maybeSingle(),
      ]);
      lancar("vencidos_do_chip", contagem.error);
      lancar("vencido_mais_antigo", maisAntigo.error);
      const desde = (maisAntigo.data as { enviar_apos?: string } | null)?.enviar_apos;
      return { total: contagem.count ?? 0, desde: desde ? new Date(desde) : null };
    },

    async saidaNaConversa(org, leadId, p) {
      // Só leitura. Erro de consulta LANÇA: o motor trata como "não deu para conferir" e não reenvia nesta volta.
      const { data: lead, error } = await db.from("crm_leads").select("contact_id").eq("organization_id", org).eq("id", leadId).maybeSingle();
      lancar("saida_lead", error);
      if (!lead?.contact_id) return null;
      let q = db
        .from("messages")
        .select("external_id, created_at, sent_at")
        .eq("organization_id", org)
        .eq("contact_id", lead.contact_id as string)
        .eq("direction", "outbound")
        .gte("created_at", p.desde.toISOString());
      // Mídia sem legenda não tem corpo para comparar: qualquer mídia que saiu para o contato depois conta (mais fraco,
      // e no sentido de NÃO reenviar).
      q = p.soMidia ? q.in("type", ["image", "video", "audio", "document", "sticker"]) : q.eq("body", p.texto.trim());
      const { data: msg, error: e2 } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
      lancar("saida_na_conversa", e2);
      if (!msg) return null;
      // O eco pode vir com o id composto (`true_<chat>_<id>`); o envio guarda o id simples (é por ele que o ack casa).
      const id = (msg.external_id as string | null) ?? null;
      return { externalId: id ? id.slice(id.lastIndexOf("_") + 1) : null, em: new Date((msg.sent_at as string | null) ?? (msg.created_at as string)) };
    },

    async entrarEmQuarentena(org, leadId, chipId, ate) {
      const { data: atual, error } = await db
        .from("disparo_quarentena")
        .select("ate")
        .eq("organization_id", org)
        .eq("lead_id", leadId)
        .maybeSingle();
      lancar("quarentena_atual", error);
      // O fim mais distante vence: re-entrar não encurta a quarentena.
      if (atual && new Date(atual.ate as string).getTime() >= ate.getTime()) return;
      const { error: e2 } = await db
        .from("disparo_quarentena")
        .upsert(
          { organization_id: org, lead_id: leadId, chip_id: chipId, motivo: "toques_sem_resposta", inicio: new Date().toISOString(), ate: ate.toISOString() },
          { onConflict: "organization_id,lead_id" },
        );
      lancar("quarentena_gravar", e2);
    },
  };
}
