/**
 * Apoio dos testes do motor: o que um repositório em memória que NÃO está
 * testando humano nem aviso ao operador precisa ter. Não é importado por código
 * de produção.
 */
import type { SituacaoHumana } from "./atendimento/humano";
import { RITMO_PADRAO, type ConfigDisparo } from "./config";
import type { Chip, Contagem, EstadoEnvio } from "./fila";
import { MARCA_NO_CANAL } from "./motor";
import type { VoltaRegistrada, AvisoDaCentral, AvisoDaFila, EnvioDaFila, EnvioDeAviso, LeadDoDisparo, NovoEnvio, RepositorioDisparo, SituacaoDoChip } from "./motor";
import { ehParteSeguinte } from "./sequencia-partes";

/** Ninguém no comando, nenhum aviso ao operador na fila. */
export const SEM_HUMANO_NEM_AVISOS: Pick<
  RepositorioDisparo,
  "situacaoHumana" | "autoEmAberto" | "avisosVencidos" | "reservarAviso" | "finalizarAviso"
> = {
  situacaoHumana: async () => ({ forceHuman: false, conversas: [] }),
  autoEmAberto: async () => false,
  avisosVencidos: async () => [],
  reservarAviso: async () => false,
  finalizarAviso: async () => undefined,
};

/** Falha alto se algum aviso chegar ao canal num teste que não esperava nenhum. */
export const SEM_AVISO: EnvioDeAviso = async () => {
  throw new Error("aviso ao operador não esperado neste teste");
};

// ------------------------------------------------------------------ motor em memória ----


export type LinhaEnvio = EnvioDaFila & {
  motivo?: string | null;
  enviadoEm?: Date | null;
  externalId?: string | null;
  atualizadoEm?: Date;
  /** Último ack da Evolution e quando entregou/leu (chip mudo). Ausente = nenhum ack chegou. */
  ack?: number | null;
  entregueEm?: Date | null;
  lidoEm?: Date | null;
  /** Volta que reservou a linha (E5). */
  reservadoPor?: string | null;
};

/** Aviso vivo da Central em memória (um aberto por prefixo). */
export type AvisoVivoEmMemoria = { id: string; prefixo: string; chipId: string | null; titulo: string; corpo: string; nivel: string; aberto: boolean; criadoEm: Date };
export type LinhaAviso = AvisoDaFila & { estado: EstadoEnvio; motivo?: string | null; enviadoEm?: Date | null; externalId?: string | null };

export const CONTAGEM_ZERADA: Contagem = {
  ultimoEnvioEm: null, ultimaNovaEm: null, enviosHoje: 0, aberturasHoje: 0, enviosUltimaHora: 0, aberturasUltimaHora: 0,
};

export function configDoMotor(org: string, modo: "simulado" | "real"): ConfigDisparo {
  return {
    organizationId: org,
    ligado: true,
    modo,
    tetoDiario: null,
    cadencia: "reativacao_3_toques",
    fonteStageId: "stage-1",
    ritmo: { ...RITMO_PADRAO, feriados: [] },
    modelos: { abertura: ["{oi} Tudo bem? Posso te contar uma novidade?"], toque_2: ["{oi} Passando de novo."] },
    proibidos: [],
    slots: { fixos: {}, semNomeQuando: [] },
    escolha: [],
  };
}

/**
 * Repositório do motor inteiro em memória: fila de envios, fila de avisos ao operador
 * e a situação humana por lead. Tudo público para o teste conferir.
 */
export function motorEmMemoria(
  agora: Date,
  config: ConfigDisparo,
  leads: LeadDoDisparo[],
  opcoes: { humano?: Map<string, SituacaoHumana>; contagem?: () => Contagem; respostas?: (leadId: string, desde: Date) => string[] } = {},
) {
  const envios: LinhaEnvio[] = [];
  const avisos: LinhaAviso[] = [];
  /** Chip pela conversa da lead (C2); ausente = a lead não conversa por chip nenhum. */
  const chipDaConversa = new Map<string, string>();
  /** Avisos do motor na Central. */
  const central: AvisoDaCentral[] = [];
  /** Trava por chip (A5): chip → dono. */
  const travasDeChip = new Map<string, string>();
  /** Voltas registradas (A5). */
  const voltas: VoltaRegistrada[] = [];
  const humano = opcoes.humano ?? new Map<string, SituacaoHumana>();
  const chip: Chip = {
    id: "chip-1", estado: "ativo", saude: "verde", diaRampa: 5, proximoEnvioEm: new Date(agora.getTime() - 60_000),
    pausadoAte: null, enviosDesdePausa: 0, pausaACada: 15,
  };
  let n = 0;
  const repo: RepositorioDisparo = {
    configsLigadas: async () => [config],
    chipsDaVolta: async () => [chip],
    contagem: async () => (opcoes.contagem ? opcoes.contagem() : CONTAGEM_ZERADA),
    mandouDesde: async () => true,
    situacaoHumana: async (_o, leadId) => humano.get(leadId) ?? { forceHuman: false, conversas: [] },
    atualizarChip: async (_o, _c, patch, ate) => {
      if (ate && chip.proximoEnvioEm && chip.proximoEnvioEm.getTime() > ate.getTime()) return false;
      Object.assign(chip, patch);
      return true;
    },
    proximoLeadParaAbertura: async () => (config.fonteStageId ? (leads.find((l) => !envios.some((e) => e.leadId === l.id && e.tipo === "abertura")) ?? null) : null),
    enfileirar: async (_o, e: NovoEnvio) => {
      if (e.origem !== "auto" && envios.some((x) => x.leadId === e.leadId && x.tipo === e.tipo)) return null;
      const novo: LinhaEnvio = {
        id: `envio-${++n}`, leadId: e.leadId, chipId: e.chipId, tipo: e.tipo, origem: e.origem, texto: e.texto, midia: null, midiaId: e.midiaId ?? null,
        enviarApos: e.enviarApos, estado: e.estado ?? "pendente", tentativas: 0, criadoEm: agora, daParada: false, motivo: e.motivo ?? null,
      };
      envios.push(novo);
      return { ...novo };
    },
    midiaDaAberturaValida: async () => true,
    estadoParteAbertura: async (_org, leadId, tipo) => envios.find((e) => e.leadId === leadId && e.tipo === tipo)?.estado ?? null,
    enfileirarAberturaComPartes: async (org, partes) => {
      if (envios.some((e) => e.leadId === partes[0]!.leadId && e.tipo === "abertura")) return null;
      const linhas = [];
      for (const parte of partes) linhas.push(await repo.enfileirar(org, parte));
      return linhas[0] ?? null;
    },
    retornosPendentes: async () => envios.filter((e) => e.tipo === "retorno_reserva" && e.estado === "pendente").map((e) => ({ ...e })),
    vencidos: async (_o, chipId, ate, limite) =>
      envios
        .filter((e) => e.chipId === chipId && e.estado === "pendente" && e.origem !== "lembrete" && e.enviarApos <= ate)
        .sort((a, b) => a.enviarApos.getTime() - b.enviarApos.getTime())
        .slice(0, limite),
    lembretesVencidos: async () => [],
    reservar: async (_o, id, dono) => {
      const e = envios.find((x) => x.id === id);
      if (!e || e.estado !== "pendente") return false;
      e.estado = "enviando";
      e.atualizadoEm = agora;
      e.reservadoPor = dono ?? null;
      return true;
    },
    finalizar: async (_o, id, fim, somenteSeEstado, dono) => {
      const e = envios.find((x) => x.id === id)!;
      if (somenteSeEstado && e.estado !== somenteSeEstado) return;
      if (dono && e.reservadoPor !== dono) return;
      e.estado = fim.estado;
      if (fim.motivo !== undefined) e.motivo = fim.motivo;
      if (fim.enviadoEm !== undefined) e.enviadoEm = fim.enviadoEm;
      if (fim.externalId !== undefined) e.externalId = fim.externalId;
      if (fim.tentativas !== undefined) e.tentativas = fim.tentativas;
      if (fim.enviarApos !== undefined) e.enviarApos = fim.enviarApos;
    },
    lead: async (_o, id) => leads.find((l) => l.id === id) ?? null,
    respostasDesde: async (_o, leadId, desde) => (opcoes.respostas ? opcoes.respostas(leadId, desde) : []),
    origensRecentes: async () => [],
    cancelarPendentesDoLead: async (_o, leadId, motivo, poupaParada = false, origem, poupaRetorno = false) => {
      const alvo = envios.filter((e) => e.leadId === leadId && e.estado === "pendente" && !(poupaParada && e.daParada) && (!origem || e.origem === origem) && !(poupaRetorno && e.tipo === "retorno_reserva"));
      for (const e of alvo) Object.assign(e, { estado: "cancelado", motivo });
      return alvo.length;
    },
    autoEmAberto: async (_o, leadId) => envios.some((e) => e.leadId === leadId && e.tipo !== "retorno_reserva" && e.origem === "auto" && (e.estado === "pendente" || e.estado === "enviando")),
    autoEmAbertoAntes: async (_o, leadId, id, antesDe, origem = "auto") =>
      envios.some((e) => e.leadId === leadId && e.tipo !== "retorno_reserva" && e.origem === origem && e.id !== id && (e.estado === "enviando" || (e.estado === "pendente" && e.enviarApos < antesDe))),
    adiarAutoDoLead: async (_o, leadId, depoisDe, ms, origem = "auto") => {
      const alvo = envios.filter((e) => e.leadId === leadId && e.tipo !== "retorno_reserva" && e.origem === origem && e.estado === "pendente" && e.enviarApos > depoisDe);
      for (const e of alvo) e.enviarApos = new Date(e.enviarApos.getTime() + ms);
      return alvo.length;
    },
    proximaParteDaSequencia: async (_o, chipId, ref) =>
      envios
        .filter((e) => e.chipId === chipId && e.estado === "pendente" && ehParteSeguinte(ref, e))
        .sort((a, b) => a.enviarApos.getTime() - b.enviarApos.getTime())[0] ?? null,
    anotarMotivoDaFila: async (_o, id, motivo) => {
      const e = envios.find((x) => x.id === id);
      if (e && e.estado === "pendente") e.motivo = motivo;
    },
    criadosDesde: async () => 0,
    saiuEm: async () => agora,
    lembretesNoDia: async () => 0,
    criarTarefa: async () => "tarefa-1",
    avisosVencidos: async (_o, chipId, ate, limite) =>
      avisos.filter((a) => a.chipId === chipId && a.estado === "pendente" && a.enviarApos <= ate).sort((a, b) => a.enviarApos.getTime() - b.enviarApos.getTime()).slice(0, limite),
    reservarAviso: async (_o, id) => {
      const a = avisos.find((x) => x.id === id);
      if (!a || a.estado !== "pendente") return false;
      a.estado = "enviando";
      return true;
    },
    finalizarAviso: async (_o, id, fim) => {
      const a = avisos.find((x) => x.id === id)!;
      a.estado = fim.estado;
      if (fim.motivo !== undefined) a.motivo = fim.motivo;
      if (fim.enviadoEm !== undefined) a.enviadoEm = fim.enviadoEm;
      if (fim.externalId !== undefined) a.externalId = fim.externalId;
      if (fim.tentativas !== undefined) a.tentativas = fim.tentativas;
      if (fim.enviarApos !== undefined) a.enviarApos = fim.enviarApos;
    },
  };
  // Como o do Supabase: só marca a linha ainda `enviando`; senão lança, e o motor não chama o canal.
  repo.marcarNoCanal = async (_o, id, dono) => {
    const e = envios.find((x) => x.id === id);
    if (!e || e.estado !== "enviando") throw new Error("disparo_marcar_no_canal: a linha não está mais em enviando");
    if (dono && e.reservadoPor !== dono) throw new Error("disparo_marcar_no_canal: a reserva passou para outra volta");
    e.motivo = MARCA_NO_CANAL;
  };
  repo.enviandoPresos = async (_o, antesDe, limite) =>
    envios
      .filter((e) => e.estado === "enviando" && (e.atualizadoEm ?? agora) < antesDe)
      .slice(0, limite)
      .map((e) => ({ ...e, externalId: e.externalId ?? null, motivo: e.motivo ?? null, reservadoEm: e.atualizadoEm ?? agora }));
  repo.tomarTravaDoChip = async (_o, chipId, dono) => {
    if (travasDeChip.has(chipId)) return false;
    travasDeChip.set(chipId, dono);
    return true;
  };
  repo.soltarTravaDoChip = async (_o, chipId, dono) => {
    if (travasDeChip.get(chipId) === dono) travasDeChip.delete(chipId);
  };
  repo.saiuDesde = async (_o, desde) => envios.some((e) => (e.estado === "enviado" || e.estado === "simulado") && e.origem !== "lembrete" && (e.enviadoEm ?? new Date(0)) >= desde);
  repo.registrarVolta = async (_o, v) => void voltas.push(v);
  repo.semChip = async (_o, ate, limite) =>
    envios.filter((e) => e.chipId === null && e.estado === "pendente" && e.origem !== "lembrete" && e.enviarApos <= ate).slice(0, limite).map((e) => ({ ...e }));
  repo.chipPelaConversa = async (_o, leadId) => chipDaConversa.get(leadId) ?? null;
  repo.atribuirChip = async (_o, id, chipId) => {
    const e = envios.find((x) => x.id === id);
    if (!e || e.estado !== "pendente" || e.chipId !== null) return false;
    e.chipId = chipId;
    return true;
  };
  repo.avisarCentral = async (_o, a) => {
    // Em memória todo aviso é "desde o começo do teste": com `umaVezDesde`, o mesmo título não se repete.
    if (a.umaVezDesde && central.some((c) => c.titulo === a.titulo)) return false;
    central.push(a);
    return true;
  };
  /** Avisos vivos (chip mudo, fila presa): um aberto por prefixo, atualizado no lugar e fechado quando o problema some. */
  const avisosVivos: AvisoVivoEmMemoria[] = [];
  repo.enviosRecentesDoChip = async (_o, chipId, desde, limite) =>
    envios
      .filter((e) => e.chipId === chipId && e.estado === "enviado" && e.externalId && e.enviadoEm && e.enviadoEm >= desde)
      .sort((a, b) => b.enviadoEm!.getTime() - a.enviadoEm!.getTime())
      .slice(0, limite)
      .map((e) => ({ enviadoEm: e.enviadoEm!, ack: e.ack ?? null, entregueEm: e.entregueEm ?? null, lidoEm: e.lidoEm ?? null }));
  repo.avisoVivo = async (_o, chave) => {
    const da = avisosVivos.filter((a) => a.prefixo === chave.prefixo);
    const aberto = [...da].reverse().find((a) => a.aberto) ?? null;
    return { aberto: aberto && { id: aberto.id, titulo: aberto.titulo, corpo: aberto.corpo, criadoEm: aberto.criadoEm }, ultimoEm: da.at(-1)?.criadoEm ?? null };
  };
  repo.gravarAvisoVivo = async (_o, chave, a, quando) => {
    const aberto = avisosVivos.find((x) => x.prefixo === chave.prefixo && x.aberto);
    if (!a) {
      if (aberto) aberto.aberto = false;
      return;
    }
    if (aberto) Object.assign(aberto, { titulo: a.titulo, corpo: a.corpo, nivel: a.nivel });
    else avisosVivos.push({ id: `vivo-${avisosVivos.length + 1}`, prefixo: chave.prefixo, chipId: chave.chipId ?? null, titulo: a.titulo, corpo: a.corpo, nivel: a.nivel, aberto: true, criadoEm: quando });
  };
  /** Fila presa (E4): a conexão do chip da volta e outros chips da organização que não entram na volta. */
  const conexao = { valor: "WORKING" as string | null };
  const outrosChips: SituacaoDoChip[] = [];
  repo.situacaoDosChips = async () => [
    { id: chip.id, nome: chip.nome ?? chip.id, estado: chip.estado, saude: chip.saude, pausadoAte: chip.pausadoAte, conexao: conexao.valor },
    ...outrosChips,
  ];
  repo.vencidosDoChip = async (_o, chipId, ate) => {
    const da = envios.filter((e) => e.chipId === chipId && e.estado === "pendente" && e.origem !== "lembrete" && e.enviarApos <= ate);
    return { total: da.length, desde: da.length ? new Date(Math.min(...da.map((e) => e.enviarApos.getTime()))) : null };
  };
  /** Saídas que a conversa registrou (o eco `fromMe` ou o espelho), para a conferência antes de reenviar (E2). */
  const saidas: { leadId: string; texto: string; soMidia: boolean; externalId: string | null; em: Date }[] = [];
  repo.saidaNaConversa = async (_o, leadId, p) => {
    const achada = [...saidas]
      .reverse()
      .find((s) => s.leadId === leadId && s.em >= p.desde && (p.soMidia ? s.soMidia : s.texto.trim() === p.texto.trim()));
    return achada ? { externalId: achada.externalId, em: achada.em } : null;
  };
  return { repo, envios, avisos, chip, humano, chipDaConversa, central, travasDeChip, voltas, avisosVivos, conexao, outrosChips, saidas };
}
