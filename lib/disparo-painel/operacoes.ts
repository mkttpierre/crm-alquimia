/**
 * O QUE AS ROTAS DO MOTOR FAZEM, sem a requisição em volta.
 *
 * Antes, estes corpos moravam dentro das rotas `app/api/v1/disparo/{estado,fila,chips,chips/[id],config}`.
 * Os agentes externos (OpenBot, Claude Code, Codex) operam o mesmo motor pelo MCP (`lib/mcp/tools/disparo.ts`), e a
 * regra é UMA: a mesma validação (`edicaoDaConfigSchema`), a mesma mensagem de recusa, a mesma gravação e a mesma
 * auditoria (`disparo.config_atualizada`). Duas cópias divergiriam na primeira correção.
 *
 * Quem chama decide os clientes:
 *   - a rota passa o client da SESSÃO para ler (a RLS vale) e o admin para escrever (a 0234 não dá escrita a
 *     `authenticated`);
 *   - o MCP passa o admin para os dois (o token não tem sessão), com a organização vinda do token.
 * Em todo caso o `organization_id` vem de fonte confiável e TODA consulta o filtra à mão.
 *
 * O envio real continua com DUAS chaves: trocar `modo` para `real` aqui só grava a primeira. A segunda
 * (`DISPARO_REAL_LIBERADO=sim`) é do servidor, e nada neste módulo a lê para escrever nem a toca.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { cadenciaPorId } from "@/lib/disparo/cadencia";
import { ABERTURA_SO_IMAGEM, lerRitmo, MIMES_DA_ABERTURA } from "@/lib/disparo/config";
import { aplicarPerfil } from "@/lib/disparo/perfis";
import { inicioDoDia, relogio, tetoTotal } from "@/lib/disparo/ritmo";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

import {
  ESTADOS_DA_FILA,
  TAMANHO_DA_PAGINA,
  edicaoDaConfigSchema,
  papelNecessario,
  type ChipDaTela,
  type EnvioDaTela,
  type EstadoDaFila,
  type EstadoDoMotor,
  type FiltroDaFila,
  type Pagina,
  type SaudeDoDiaDaTela,
} from "./esquemas";
import { diferencasDaConfig, mesclarRitmo, minutosParaHora, montarEstado, type LinhaDaConfig } from "./estado";

export type Falha = { ok: false; status: number; codigo: string; mensagem: string; detalhes?: Record<string, unknown> };
export type Resultado<T> = { ok: true; dados: T } | Falha;

/** Quem mudou: uma pessoa (sessão) ou um agente externo (token). O agente vai NOMEADO na auditoria. */
export type AutorDaMudanca = {
  actorUserId: string | null;
  actorApiTokenId?: string | null;
  agente?: { id: string; nome: string } | null;
};

export type ClientesDoMotor = { leitura: SupabaseClient; escrita: SupabaseClient };

const falha = (status: number, codigo: string, mensagem: string, detalhes?: Record<string, unknown>): Falha => ({
  ok: false,
  status,
  codigo,
  mensagem,
  ...(detalhes ? { detalhes } : {}),
});

/** O autor na metadata da auditoria: só o nome e o id do agente, nunca o token. */
function marcaDoAutor(autor: AutorDaMudanca): Record<string, unknown> {
  return autor.agente ? { autor: { tipo: "agente_externo", id: autor.agente.id, nome: autor.agente.nome } } : {};
}

// ---------------------------------------------------------------------------
// leitura: estado
// ---------------------------------------------------------------------------

export async function lerEstadoDoMotor(
  db: SupabaseClient,
  orgId: string,
  opcoes: { agora?: Date; ambiente?: Record<string, string | undefined>; idioma?: Idioma } = {},
): Promise<Resultado<EstadoDoMotor | { existe: false; agora: string }>> {
  const agora = opcoes.agora ?? new Date();
  const t = (texto: string) => traduzir(texto, opcoes.idioma ?? "pt-BR");
  const { data: config, error } = await db
    .from("disparo_config")
    .select("ligado, modo, teto_diario, cadencia, ritmo, atendimento")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return falha(500, "internal_error", t("Não foi possível ler o estado do motor."));
  if (!config) return { ok: true, dados: { existe: false, agora: agora.toISOString() } };

  const base = montarEstado(config as LinhaDaConfig, agora, opcoes.ambiente ?? process.env);
  const desdeHoje = inicioDoDia(agora, lerRitmo(config.ritmo).fusoMinutos).toISOString();

  // Número FIXO de consultas (uma por estado + hoje + chips + próximo), qualquer que seja o tamanho da fila.
  const contar = (estado: EstadoDaFila) =>
    db.from("disparo_envios").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("estado", estado);
  const [porEstado, hoje, chips, proximoChip, proximaFila] = await Promise.all([
    Promise.all(ESTADOS_DA_FILA.map(contar)),
    db
      .from("disparo_envios")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .in("estado", ["enviado", "simulado"])
      .gte("enviado_em", desdeHoje),
    db.from("disparo_chips").select("id, estado, channel_session_id").eq("organization_id", orgId),
    db
      .from("disparo_chips")
      .select("proximo_envio_em")
      .eq("organization_id", orgId)
      .in("estado", ["rampa", "ativo"])
      .not("proximo_envio_em", "is", null)
      .order("proximo_envio_em", { ascending: true })
      .limit(1),
    db
      .from("disparo_envios")
      .select("enviar_apos")
      .eq("organization_id", orgId)
      .eq("estado", "pendente")
      .order("enviar_apos", { ascending: true })
      .limit(1),
  ]);
  const falhou = [...porEstado, hoje, chips, proximoChip, proximaFila].some((r) => r.error);
  if (falhou) return falha(500, "internal_error", t("Não foi possível ler o estado do motor."));

  const contagens = Object.fromEntries(ESTADOS_DA_FILA.map((e, i) => [e, porEstado[i]!.count ?? 0])) as Record<
    EstadoDaFila,
    number
  >;
  // O motor só envia depois do maior entre "vez do chip" e "vencimento do passo".
  const doChip = (proximoChip.data?.[0] as { proximo_envio_em?: string } | undefined)?.proximo_envio_em ?? null;
  const daFila = (proximaFila.data?.[0] as { enviar_apos?: string } | undefined)?.enviar_apos ?? null;
  const chipDepois = !!doChip && !!daFila && Date.parse(doChip) > Date.parse(daFila);
  const proximo: EstadoDoMotor["proximo_envio"] = daFila
    ? { quando: chipDepois ? doChip! : daFila, origem: chipDepois ? "chip" : "fila" }
    : null;

  const linhasChip = (chips.data ?? []) as { estado: string; channel_session_id: string | null }[];
  return {
    ok: true,
    dados: {
      ...base,
      proximo_envio: proximo,
      contagens: { ...contagens, hoje: hoje.count ?? 0 },
      chips: {
        total: linhasChip.length,
        ativos: linhasChip.filter((c) => c.estado === "rampa" || c.estado === "ativo").length,
        sem_canal: linhasChip.filter((c) => !c.channel_session_id).length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// leitura: fila
// ---------------------------------------------------------------------------

type Contato = { name: string | null; display_name: string | null };
type LinhaDaFila = {
  id: string;
  estado: string;
  tipo: string;
  origem: string;
  texto: string;
  midia: string | null;
  midia_id: string | null;
  enviar_apos: string;
  enviado_em: string | null;
  motivo: string | null;
  chip_id: string | null;
  lead_id: string;
  lead: { id: string; title: string; contact: Contato | Contato[] | null } | null;
};

const umContato = (v: Contato | Contato[] | null | undefined): Contato | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export async function lerFilaDoMotor(
  db: SupabaseClient,
  orgId: string,
  consulta: { estado: FiltroDaFila; pagina: number },
  idioma: Idioma = "pt-BR",
): Promise<Resultado<Pagina<EnvioDaTela>>> {
  const t = (texto: string) => traduzir(texto, idioma);
  const { estado, pagina } = consulta;
  let q = db
    .from("disparo_envios")
    .select(
      "id, estado, tipo, origem, texto, midia, midia_id, enviar_apos, enviado_em, motivo, chip_id, lead_id, lead:crm_leads(id, title, contact:contacts(name, display_name))",
      { count: "exact" },
    )
    .eq("organization_id", orgId);
  q = estado === "fila" ? q.in("estado", ["pendente", "simulado"]) : q.eq("estado", estado);
  // Pendente: quem vence antes, primeiro. O resto (simulado, enviado...): o mais recente primeiro.
  const proximos = estado === "pendente" || estado === "fila";

  const [{ data: config }, { data, error, count }] = await Promise.all([
    db.from("disparo_config").select("cadencia").eq("organization_id", orgId).maybeSingle(),
    q
      .order("enviar_apos", { ascending: proximos })
      .order("id", { ascending: true })
      .range((pagina - 1) * TAMANHO_DA_PAGINA, pagina * TAMANHO_DA_PAGINA - 1),
  ]);
  if (error) return falha(500, "internal_error", t("Não foi possível ler a fila."));

  const linhas = (data ?? []) as unknown as LinhaDaFila[];
  const chipIds = [...new Set(linhas.map((l) => l.chip_id).filter((x): x is string => !!x))];
  const nomesDosChips = new Map<string, string>();
  if (chipIds.length > 0) {
    const { data: chips } = await db.from("disparo_chips").select("id, nome").eq("organization_id", orgId).in("id", chipIds);
    for (const c of (chips ?? []) as { id: string; nome: string }[]) nomesDosChips.set(c.id, c.nome);
  }

  const cadencia = cadenciaPorId((config as { cadencia?: string } | null)?.cadencia);
  const itens: EnvioDaTela[] = linhas.map((l) => {
    const ordem = cadencia.passos.findIndex((p) => p.tipo === l.tipo);
    const passo = ordem >= 0 ? cadencia.passos[ordem]! : null;
    const contato = umContato(l.lead?.contact);
    return {
      id: l.id,
      estado: l.estado as EstadoDaFila,
      tipo: l.tipo,
      origem: l.origem,
      passo: passo ? { ordem: ordem + 1, total: cadencia.passos.length, dia: passo.dia, automatico: passo.automatico } : null,
      texto: l.texto,
      tem_midia: !!(l.midia || l.midia_id),
      enviar_apos: l.enviar_apos,
      enviado_em: l.enviado_em,
      motivo: l.motivo,
      lead: l.lead ? { id: l.lead.id, nome: contato ? rotuloDoContato(contato) : l.lead.title } : null,
      chip: l.chip_id && nomesDosChips.has(l.chip_id) ? { id: l.chip_id, nome: nomesDosChips.get(l.chip_id)! } : null,
    };
  });
  return { ok: true, dados: { itens, pagina, tamanho: TAMANHO_DA_PAGINA, total: count ?? 0 } };
}

// ---------------------------------------------------------------------------
// leitura: chips e a saúde de hoje
// ---------------------------------------------------------------------------

/** Teto de linhas lidas para "último envio" e "hoje": mais que o teto diário de qualquer chip. */
const LIMITE_DE_SAIDAS = 2000;

export async function lerChipsDoMotor(
  db: SupabaseClient,
  orgId: string,
  opcoes: { agora?: Date; idioma?: Idioma } = {},
): Promise<Resultado<{ itens: ChipDaTela[] }>> {
  const agora = opcoes.agora ?? new Date();
  const t = (texto: string) => traduzir(texto, opcoes.idioma ?? "pt-BR");
  const [{ data: config }, { data: chips, error }, { data: saidas, error: erroSaidas }, { data: saudes, error: erroSaudes }] =
    await Promise.all([
      db.from("disparo_config").select("ritmo, teto_diario").eq("organization_id", orgId).maybeSingle(),
      db
        .from("disparo_chips")
        .select("id, nome, estado, saude, dia_rampa, channel_session_id, pausado_ate, proximo_envio_em, saude_motivo")
        .eq("organization_id", orgId)
        .order("nome", { ascending: true }),
      db
        .from("disparo_envios")
        .select("chip_id, enviado_em")
        .eq("organization_id", orgId)
        .in("estado", ["enviado", "simulado"])
        .not("chip_id", "is", null)
        .order("enviado_em", { ascending: false })
        .limit(LIMITE_DE_SAIDAS),
      // O dia local da organização: o fuso vem do ritmo, lido logo abaixo, então a consulta usa o mais recente de cada chip.
      db
        .from("disparo_saude_dia")
        .select(
          "chip_id, dia, saude, dia_rampa, aberturas, respostas, aberturas_janela, respostas_janela, maduras, com_ack, bloqueio_provavel, nao_quero, irritacao, reconexoes, quedas, motivos, calculado_em",
        )
        .eq("organization_id", orgId)
        .order("dia", { ascending: false })
        .limit(200),
    ]);
  if (error || erroSaidas || erroSaudes) return falha(500, "internal_error", t("Não foi possível ler os chips."));

  const configLida = config as { ritmo?: unknown; teto_diario?: number | null } | null;
  const ritmo = lerRitmo(configLida?.ritmo);
  const desdeHoje = inicioDoDia(agora, ritmo.fusoMinutos).getTime();
  const ultimo = new Map<string, string>();
  const hoje = new Map<string, number>();
  for (const s of (saidas ?? []) as { chip_id: string | null; enviado_em: string | null }[]) {
    if (!s.chip_id || !s.enviado_em) continue;
    if (!ultimo.has(s.chip_id)) ultimo.set(s.chip_id, s.enviado_em);
    if (Date.parse(s.enviado_em) >= desdeHoje) hoje.set(s.chip_id, (hoje.get(s.chip_id) ?? 0) + 1);
  }

  // Só vale a linha de HOJE (dia local da organização); a de ontem é história, não estado.
  const diaDeHoje = relogio(agora, ritmo.fusoMinutos).data;
  const saudeDeHoje = new Map<string, SaudeDoDiaDaTela>();
  for (const s of (saudes ?? []) as (SaudeDoDiaDaTela & { chip_id: string; motivos: unknown })[]) {
    if (s.dia !== diaDeHoje || saudeDeHoje.has(s.chip_id)) continue;
    saudeDeHoje.set(s.chip_id, {
      dia: s.dia,
      saude: s.saude,
      dia_rampa: s.dia_rampa,
      aberturas: s.aberturas,
      respostas: s.respostas,
      aberturas_janela: s.aberturas_janela,
      respostas_janela: s.respostas_janela,
      maduras: s.maduras,
      com_ack: s.com_ack,
      bloqueio_provavel: s.bloqueio_provavel,
      nao_quero: s.nao_quero,
      irritacao: s.irritacao,
      reconexoes: s.reconexoes,
      quedas: s.quedas,
      motivos: Array.isArray(s.motivos) ? (s.motivos as SaudeDoDiaDaTela["motivos"]) : [],
      calculado_em: s.calculado_em,
    });
  }

  type LinhaDoChip = {
    id: string;
    nome: string;
    estado: string;
    saude: string;
    dia_rampa: number;
    channel_session_id: string | null;
    pausado_ate: string | null;
    proximo_envio_em: string | null;
    saude_motivo: string | null;
  };
  const itens: ChipDaTela[] = ((chips ?? []) as LinhaDoChip[]).map((c) => ({
    id: c.id,
    nome: c.nome,
    estado: c.estado as ChipDaTela["estado"],
    saude: c.saude as ChipDaTela["saude"],
    dia_rampa: c.dia_rampa,
    channel_session_id: c.channel_session_id,
    tem_canal: !!c.channel_session_id,
    pausado_ate: c.pausado_ate,
    proximo_envio_em: c.proximo_envio_em,
    ultimo_envio_em: ultimo.get(c.id) ?? null,
    envios_hoje: hoje.get(c.id) ?? 0,
    teto_hoje: tetoTotal(c.dia_rampa, ritmo, configLida?.teto_diario ?? null, c.nome),
    saude_motivo: c.saude_motivo ?? null,
    saude_do_dia: saudeDeHoje.get(c.id) ?? null,
  }));
  return { ok: true, dados: { itens } };
}

// ---------------------------------------------------------------------------
// escrita: editar a configuração
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUNAS_DA_CONFIG = "ligado, modo, teto_diario, cadencia, fonte_stage_id, ritmo, modelos, proibidos";

/** A mensagem da recusa por corpo inválido — a MESMA para a tela e para o MCP. */
export const MENSAGEM_DE_DADOS_INVALIDOS = "Dados inválidos.";

/**
 * Valida e aplica uma edição do motor. `corpo` é o que chegou (JSON da tela ou argumentos do MCP), ainda não validado:
 * a validação é `edicaoDaConfigSchema` aqui dentro, para os dois ingressos recusarem com a mesma mensagem.
 *
 * Grava só o que mudou e audita `disparo.config_atualizada` com o antes e o depois. Quando o motor passa de ligado a
 * desligado, emite `motor.parou` (webhook de saída assinável pelos agentes externos).
 */
export async function editarConfigDoMotor(
  clientes: ClientesDoMotor,
  entrada: {
    orgId: string;
    papel: Role;
    corpo: unknown;
    autor: AutorDaMudanca;
    requestId: string;
    idioma?: Idioma;
  },
): Promise<Resultado<{ atualizado: string[] }>> {
  const { orgId, papel, autor, requestId } = entrada;
  const t = (texto: string) => traduzir(texto, entrada.idioma ?? "pt-BR");

  const parsed = edicaoDaConfigSchema.safeParse(entrada.corpo);
  if (!parsed.success) {
    // `campos`: o caminho de cada problema (`ritmo.intervaloNova`, `proibidos.0.padrao`), para a tela mostrar no campo
    // e o agente saber o que corrigir.
    return falha(422, "validation_failed", t(MENSAGEM_DE_DADOS_INVALIDOS), {
      campos: parsed.error.issues.map((i) => ({ caminho: i.path.map(String).join("."), mensagem: i.message })),
    });
  }
  const edicao = parsed.data;

  // Trocar o modo é do admin. A recusa sai antes de qualquer leitura ou escrita.
  if (ROLE_RANK[papel] < ROLE_RANK[papelNecessario(edicao)]) {
    return falha(403, "forbidden_role", t("Permissão insuficiente."));
  }

  const { data: atual, error: erroLeitura } = await clientes.leitura
    .from("disparo_config")
    .select(COLUNAS_DA_CONFIG)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroLeitura) return falha(500, "internal_error", t("Não foi possível salvar o ajuste."));
  if (!atual) return falha(404, "not_found", t("Esta organização ainda não tem o motor configurado."));

  if (edicao.fonte_stage_id) {
    const { data: etapa, error: erroEtapa } = await clientes.leitura
      .from("crm_stages")
      .select("id, is_archived")
      .eq("id", edicao.fonte_stage_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (erroEtapa) return falha(500, "internal_error", t("Não foi possível salvar o ajuste."));
    if (!etapa || (etapa as { is_archived?: boolean }).is_archived) {
      return falha(422, "validation_failed", t("A etapa de origem não é um passo ativo de um funil desta organização."));
    }
  }

  // A imagem da abertura: da biblioteca DESTA organização e só imagem (é o que o motor envia, com legenda).
  const midiaDaAbertura = edicao.ritmo?.aberturaMidiaId;
  if (typeof midiaDaAbertura === "string") {
    const recusar = () =>
      falha(422, "validation_failed", t(ABERTURA_SO_IMAGEM), {
        campos: [{ caminho: "ritmo.aberturaMidiaId", mensagem: t(ABERTURA_SO_IMAGEM) }],
      });
    if (!UUID.test(midiaDaAbertura)) return recusar();
    const { data: midia, error: erroMidia } = await clientes.leitura
      .from("media_library")
      .select("id, mime")
      .eq("id", midiaDaAbertura)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (erroMidia) return falha(500, "internal_error", t("Não foi possível salvar o ajuste."));
    if (!midia || !(MIMES_DA_ABERTURA as readonly string[]).includes((midia as { mime: string }).mime)) return recusar();
  }

  const { ritmo: edicaoDoRitmo, perfil, ...simples } = edicao;
  const novo: Record<string, unknown> = { ...simples };
  const gravado = atual as Record<string, unknown>;
  if (perfil || edicaoDoRitmo) {
    let ritmo: Record<string, unknown> | null = (gravado.ritmo ?? {}) as Record<string, unknown>;
    if (perfil) ritmo = aplicarPerfil(ritmo, perfil);
    if (ritmo && edicaoDoRitmo) ritmo = mesclarRitmo(ritmo, edicaoDoRitmo);
    if (!ritmo) return falha(422, "validation_failed", t("O ritmo informado não é válido."));
    novo.ritmo = ritmo;
  }

  const { antes, depois } = diferencasDaConfig(gravado, novo);
  const mudou = Object.keys(depois);
  if (mudou.length === 0) return { ok: true, dados: { atualizado: [] } };

  const patch = Object.fromEntries(mudou.map((campo) => [campo, novo[campo]]));
  const { error } = await clientes.escrita.from("disparo_config").update(patch).eq("organization_id", orgId);
  if (error) return falha(500, "internal_error", t("Não foi possível salvar o ajuste."));

  await audit({
    organizationId: orgId,
    actorUserId: autor.actorUserId,
    ...(autor.actorApiTokenId ? { actorApiTokenId: autor.actorApiTokenId } : {}),
    action: "disparo.config_atualizada",
    resourceType: "disparo_config",
    resourceId: orgId,
    requestId,
    metadata: { operacao: "editar", campos: mudou, ...(perfil ? { perfil } : {}), antes, depois, ...marcaDoAutor(autor) },
  });

  if (gravado.ligado === true && novo.ligado === false) {
    await emitirMotorParou(clientes.escrita, orgId, autor);
  }
  return { ok: true, dados: { atualizado: mudou } };
}

/** `motor.parou`: falha ao emitir não desfaz a pausa (já gravada e auditada); vira log. */
async function emitirMotorParou(admin: SupabaseClient, orgId: string, autor: AutorDaMudanca): Promise<void> {
  try {
    const { error } = await admin.rpc("emit_event" as never, {
      p_event_type: "motor.parou",
      p_entity_kind: "disparo_config",
      p_entity_id: orgId,
      p_payload: { motivo: "pausado", por: autor.agente ? { tipo: "agente_externo", nome: autor.agente.nome } : { tipo: "pessoa" } },
      p_metadata: { actor_kind: autor.agente ? "external_agent" : "user" },
      p_organization_id: orgId,
    } as never);
    if (error) throw new Error((error as { message: string }).message);
  } catch (err) {
    logger.warn("[disparo] emit_event motor.parou falhou", { org: orgId, error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// escrita: pausar e retomar um chip
// ---------------------------------------------------------------------------

/** "14:30" no fuso da organização; com a data na frente quando não é hoje ("18/11 09:00"). */
function quandoLocal(instante: Date, agora: Date, fusoMinutos: number): string {
  const r = relogio(instante, fusoMinutos);
  const hora = minutosParaHora(r.minuto);
  return r.data === relogio(agora, fusoMinutos).data ? hora : `${r.data.slice(8, 10)}/${r.data.slice(5, 7)} ${hora}`;
}

/**
 * pausar: `estado = 'pausado'` (a fila dele fica como está). retomar: `ativo` a partir do dia maduro, `rampa` antes;
 * NUNCA mexe em `saude` nem em `pausado_ate` — um chip vermelho continua parado até a saúde soltá-lo, e o aviso diz até
 * quando. Chip retirado (`desligado`) é 409.
 */
export async function mudarChipDoMotor(
  clientes: ClientesDoMotor,
  entrada: {
    orgId: string;
    chipId: string;
    acao: "pausar" | "retomar";
    autor: AutorDaMudanca;
    requestId: string;
    idioma?: Idioma;
    agora?: Date;
  },
): Promise<Resultado<{ chip_id: string; estado: string; aviso: string | null }>> {
  const { orgId, chipId: id, acao, autor, requestId } = entrada;
  const t = (texto: string) => traduzir(texto, entrada.idioma ?? "pt-BR");

  const [{ data: chip, error: erroChip }, { data: config, error: erroConfig }] = await Promise.all([
    clientes.leitura
      .from("disparo_chips")
      .select("id, nome, estado, saude, dia_rampa, pausado_ate")
      .eq("id", id)
      .eq("organization_id", orgId)
      .maybeSingle(),
    clientes.leitura.from("disparo_config").select("ritmo").eq("organization_id", orgId).maybeSingle(),
  ]);
  if (erroChip || erroConfig) return falha(500, "internal_error", t("Não foi possível mudar o chip."));
  if (!chip) return falha(404, "not_found", t("Chip não encontrado."));
  const c = chip as { id: string; nome: string; estado: string; saude: string; dia_rampa: number; pausado_ate: string | null };
  if (c.estado === "desligado") {
    return falha(409, "state_conflict", t("Este chip foi tirado do motor. Para usá-lo de novo, registre a conexão outra vez."));
  }

  const ritmo = lerRitmo((config as { ritmo?: unknown } | null)?.ritmo);
  const agora = entrada.agora ?? new Date();
  const estado = acao === "pausar" ? "pausado" : c.dia_rampa >= ritmo.diaMaduro ? "ativo" : "rampa";

  // Retomar nunca solta o freio de saúde: só o estado muda, e quem pediu fica sabendo do que continua segurando o chip.
  let aviso: string | null = null;
  if (acao === "retomar") {
    const pausaAte = c.pausado_ate ? new Date(c.pausado_ate) : null;
    if (pausaAte && pausaAte.getTime() > agora.getTime()) {
      aviso = `${t("Chip retomado; continua parado pela saúde até")} ${quandoLocal(pausaAte, agora, ritmo.fusoMinutos)}`;
    } else if (c.saude === "vermelho") {
      aviso = t("Chip retomado; continua parado pela saúde vermelha até o motor recalcular a saúde dele.");
    }
  }

  const mudou = acao === "pausar" ? c.estado !== "pausado" : c.estado === "pausado";
  if (mudou) {
    // O UPDATE é condicionado: um "retomar" que corre junto com um "retirar" não pode reativar o chip retirado.
    const { data: mudados, error } = await clientes.escrita
      .from("disparo_chips")
      .update({ estado })
      .eq("id", id)
      .eq("organization_id", orgId)
      .neq("estado", "desligado")
      .select("id");
    if (error) return falha(500, "internal_error", t("Não foi possível mudar o chip."));
    if (!(mudados as unknown[] | null)?.length) {
      return falha(409, "state_conflict", t("Este chip foi tirado do motor. Para usá-lo de novo, registre a conexão outra vez."));
    }
    await audit({
      organizationId: orgId,
      actorUserId: autor.actorUserId,
      ...(autor.actorApiTokenId ? { actorApiTokenId: autor.actorApiTokenId } : {}),
      action: "disparo.config_atualizada",
      resourceType: "disparo_chips",
      resourceId: id,
      requestId,
      metadata: {
        operacao: acao === "pausar" ? "pausar_chip" : "retomar_chip",
        nome: c.nome,
        antes: { estado: c.estado },
        depois: { estado },
        ...marcaDoAutor(autor),
      },
    });
  }
  return { ok: true, dados: { chip_id: id, estado: mudou ? estado : c.estado, aviso } };
}

// ---------------------------------------------------------------------------
// escrita: tirar o chip do motor
// ---------------------------------------------------------------------------

/** O motivo gravado nos envios pendentes cancelados quando o chip sai do motor. */
export const MOTIVO_CHIP_RETIRADO = "chip retirado do motor";

/**
 * Tira o chip do motor sem apagar nada: `estado = 'desligado'` (o motor não o usa mais, `lib/disparo/fila.ts`) e os
 * envios PENDENTES dele cancelados com o motivo escrito; o que já saiu, ou está saindo (`enviando`), fica como está.
 * A linha fica, porque `disparo_envios` aponta para ela. NUNCA mexe em `saude`, `saude_motivo` nem `pausado_ate`:
 * registrar a conexão de novo reativa a MESMA linha com o freio de saúde que ela tinha.
 *
 * Primeiro o chip, depois a fila: com o chip desligado, nenhuma volta do motor pega um pendente dele no meio. Audita
 * só quando houve efeito (chip que mudou ou pendente cancelado). `origem` diz de onde veio o pedido (a exclusão da
 * conexão, por exemplo) e vai na auditoria.
 */
export async function retirarChipDoMotor(
  clientes: ClientesDoMotor,
  entrada: {
    orgId: string;
    chipId: string;
    autor: AutorDaMudanca;
    requestId: string;
    idioma?: Idioma;
    origem?: string;
  },
): Promise<Resultado<{ chip_id: string; cancelados: number }>> {
  const { orgId, chipId: id, autor, requestId } = entrada;
  const t = (texto: string) => traduzir(texto, entrada.idioma ?? "pt-BR");

  const { data: chip, error: erroLeitura } = await clientes.leitura
    .from("disparo_chips")
    .select("id, nome, estado")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroLeitura) return falha(500, "internal_error", t("Não foi possível tirar o chip do motor."));
  if (!chip) return falha(404, "not_found", t("Chip não encontrado."));
  // Copiado antes de escrever: a auditoria descreve o estado LIDO, e não o objeto que um cliente devolveu por referência.
  const { nome, estado: estadoAntes } = chip as { id: string; nome: string; estado: string };

  if (estadoAntes !== "desligado") {
    const { error } = await clientes.escrita
      .from("disparo_chips")
      .update({ estado: "desligado" })
      .eq("id", id)
      .eq("organization_id", orgId);
    if (error) return falha(500, "internal_error", t("Não foi possível tirar o chip do motor."));
  }
  const { data: cancelados, error: erroFila } = await clientes.escrita
    .from("disparo_envios")
    .update({ estado: "cancelado", motivo: MOTIVO_CHIP_RETIRADO })
    .eq("organization_id", orgId)
    .eq("chip_id", id)
    .eq("estado", "pendente")
    .select("id");
  if (erroFila) {
    return falha(500, "internal_error", t("O chip saiu do motor, mas a fila dele não foi cancelada. Tente de novo."));
  }

  const quantos = (cancelados as unknown[] | null)?.length ?? 0;
  if (estadoAntes !== "desligado" || quantos > 0) {
    await audit({
      organizationId: orgId,
      actorUserId: autor.actorUserId,
      ...(autor.actorApiTokenId ? { actorApiTokenId: autor.actorApiTokenId } : {}),
      action: "disparo.config_atualizada",
      resourceType: "disparo_chips",
      resourceId: id,
      requestId,
      metadata: {
        operacao: "retirar_chip",
        nome,
        antes: { estado: estadoAntes },
        depois: { estado: "desligado" },
        envios_cancelados: quantos,
        ...(entrada.origem ? { origem: entrada.origem } : {}),
        ...marcaDoAutor(autor),
      },
    });
  }
  return { ok: true, dados: { chip_id: id, cancelados: quantos } };
}

/**
 * Os chips do motor presos a uma conexão (para o preflight e para a exclusão dela). Sem filtro de estado no banco:
 * quem chama decide o que conta (o preflight conta só os que ainda estão no motor).
 */
export async function chipsDaConexao(
  db: SupabaseClient,
  orgId: string,
  channelSessionId: string,
): Promise<{ ok: true; chips: { id: string; nome: string; estado: string }[] } | { ok: false }> {
  const { data, error } = await db
    .from("disparo_chips")
    .select("id, nome, estado")
    .eq("organization_id", orgId)
    .eq("channel_session_id", channelSessionId);
  if (error) return { ok: false };
  return { ok: true, chips: (data ?? []) as { id: string; nome: string; estado: string }[] };
}
