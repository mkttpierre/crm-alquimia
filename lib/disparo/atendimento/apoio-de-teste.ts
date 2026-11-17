/**
 * Apoio dos testes do atendimento: repositório em memória e configurações de
 * EXEMPLO (textos fictícios, de nenhum negócio real — os textos de cada casa
 * vivem no banco dela, gravados pelo seed). Não é importado por código de
 * produção.
 */
import { RITMO_PADRAO, type ConfigDisparo } from "../config";
import type { ConversaGuardada, EnvioDoAtendimento, LeadComSituacao, RepositorioAtendimento } from "./atendimento";
import { atendimentoSchema, vendaSchema, prospeccaoSchema, type ConfigAtendimento } from "./config";
import type { EtapaAtendimento, NivelDoAviso } from "./estado";
import type { MovimentoDoFunil } from "./funil";
import type { ConversaHumana, SituacaoHumana } from "./humano";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const audio = (n: number, nome: string, segundos = 30) => ({ id: UUID(900 + n), nome, segundos });

export const CONFIG_VENDA_EXEMPLO = vendaSchema.parse({
  perfil: "venda",
  ligado: true,
  contextoJev: "vendedor de um produto de exemplo",
  respostas: {
    explicacao: [[{ midia: audio(1, "explica.ogg", 100) }]],
    tabela: [
      [
        { texto: "Vou te explicar os preços{virg_nome}:" },
        { midia: audio(2, "valores-1.opus", 60) },
        { texto: "12 meses: R$ 900\n9 meses: R$ 700" },
        { texto: "", midia: { id: UUID(950), nome: "tabela.jpg" } },
        { texto: "Qual plano você prefere?" },
      ],
    ],
    degrau_9: [[{ texto: "Entendo{virg_nome}. Posso montar o plano de 9 meses. Prefere o brinde 1 ou o brinde 2?" }]],
    degrau_7: [[{ texto: "Outra opção: o plano de 7 meses. Prefere o brinde 1 ou o brinde 2?" }]],
    degrau_5: [[{ texto: "Entendi{virg_nome}. Tem também o plano de 5 meses. Prefere o brinde 1 ou o brinde 2?" }]],
    entrada: [[{ texto: "Opções menores: planos de 3 e 2 meses. Qual prefere?", midia: { id: UUID(951), nome: "entrada.png" } }]],
    entrega: [[{ texto: "O prazo de entrega aparece no pedido{virg_nome}." }]],
    pergunta_kit: [[{ texto: "Certo{virg_nome}! Qual plano você quer?" }]],
    obj_tempo_texto: [[{ texto: "Tudo bem. Ficou alguma dúvida?" }]],
    reposicao: [[{ texto: "Oi{virg_nome}! Quer renovar o plano?" }]],
  },
  objecoes: [
    { id: "saude", gatilho: "hipertens|pressao alta", jev: "pergunta se quem tem pressão alta pode usar", midia: audio(10, "obj-saude.ogg"), pergunta: "Boa pergunta. Qual plano você prefere?", soPeloGatilho: true },
    { id: "golpe", gatilho: "\\bgolpe\\b|\\bcnpj\\b|e confiavel", jev: "tem medo de golpe", midia: audio(11, "obj-golpe.ogg"), pergunta: "Faz sentido ter cuidado. Quer ver os dados da empresa?" },
    { id: "pensar", gatilho: "vou pensar|preciso pensar", jev: "diz que vai pensar", midia: audio(12, "obj-pensar.ogg"), pergunta: "Claro. Ficou alguma dúvida?" },
    { id: "trabalho", gatilho: "(estou|to) no trabalho", jev: "diz que está no trabalho", midia: audio(13, "obj-trabalho.ogg"), pergunta: "Sem problema. Qual plano você prefere?" },
    { id: "funciona", gatilho: "funciona (mesmo|de verdade)|ja tentei de tudo", jev: "duvida que funcione", midia: audio(14, "obj-funciona.ogg"), pergunta: "O que você gostaria de saber?" },
  ],
  kits: [
    { meses: 12, potes: 12, gratis: 0, pixCents: 90000, link: "https://pagamento.exemplo/k12" },
    { meses: 9, potes: 9, gratis: 0, pixCents: 70000, link: "https://pagamento.exemplo/k9" },
    { meses: 7, potes: 7, gratis: 0, pixCents: 55000, link: "https://pagamento.exemplo/k7" },
    { meses: 5, potes: 5, gratis: 0, pixCents: 45000, link: "https://pagamento.exemplo/k5" },
    { meses: 3, potes: 3, gratis: 0, pixCents: 35000, link: "https://pagamento.exemplo/k3", ultimoRecurso: true },
  ],
  escada: ["tabela", "degrau_9", "degrau_7", "degrau_5"],
  semCondicao: "entrada",
  explicacao: "explicacao",
  entrega: "entrega",
  perguntaKit: "pergunta_kit",
  respostaPorObjecao: { objecao_tempo: "obj_tempo_texto" },
  fechamento: {
    partes: [
      { midia: audio(20, "fechamento-1.opus", 47) },
      { midia: audio(21, "fechamento-2.opus", 49) },
      { texto: "Para fechar, me passa os dados do pedido." },
    ],
  },
  site: { texto: "Também tem o plano de {acima} meses. Os links:\n\n{links}", textoSemAcima: "Segue o link:\n{links}" },
  clientes: { trilhas: ["posvenda"], resposta: "reposicao" },
  desvios: [{ padrao: "reembolso|estorno", motivo: "falou de reembolso: só sob pedido" }],
});

export const CONFIG_PROSPECCAO_EXEMPLO = prospeccaoSchema.parse({
  perfil: "prospeccao",
  ligado: true,
  respostas: {
    motivo: [["Tudo bem. Posso perguntar o motivo?"].map((texto) => ({ texto }))],
    objecao_ja_tenho: [[{ texto: "Certo. Como vocês fazem isso hoje?" }]],
    objecao_socio: [[{ texto: "Claro. Quer marcar uma conversa com a outra pessoa junto?" }]],
    diagnostico_convite: [[{ texto: "Combinado. Tenho um questionário curto, segue o link." }]],
    diagnostico_link: [[{ texto: "{link}" }]],
  },
  objecoes: [
    { id: "ja_tenho", gatilho: "(ja )?(tenho|temos) (uma |um )?(agencia|alguem|empresa)", descricao: "já tem quem faz" },
    { id: "socio", gatilho: "(falar|conversar|ver) com (o |a )?(meu |minha )?(socio|socia|marido|esposa)", descricao: "outra pessoa decide junto" },
  ],
  objecaoDecisor: "socio",
  diagnostico: { url: "https://diagnostico.exemplo", campoCodigo: "codigo" },
});

export function configDisparoExemplo(org: string, modo: "simulado" | "real" = "simulado"): ConfigDisparo {
  return {
    organizationId: org,
    ligado: false,
    modo,
    tetoDiario: null,
    cadencia: "reativacao_3_toques",
    fonteStageId: null,
    ritmo: RITMO_PADRAO,
    modelos: {},
    proibidos: [{ padrao: "brinde (extra|a mais)", motivo: "cita brinde extra fora do último toque", excetoUltimo: true }],
    slots: { fixos: {}, semNomeQuando: [] },
    escolha: [],
  };
}

export type Aviso = { leadId: string; nivel: NivelDoAviso; titulo: string; corpo: string; status: "open" | "resolved" };
export type EnvioGuardado = EnvioDoAtendimento & { cancelado?: string };

/** Repositório em memória, uma organização. Tudo público para o teste conferir. */
export class RepositorioEmMemoria implements RepositorioAtendimento {
  leads = new Map<string, LeadComSituacao>();
  conversas = new Map<string, ConversaGuardada>();
  leituras = new Map<string, { id: string; leadId: string; chipId: string | null; texto: string; leitura?: Record<string, unknown>; decisao?: string; irritada?: boolean }>();
  envios: EnvioGuardado[] = [];
  /** Quantos toques do follow-up do kit já saíram / se a oferta do Método já saiu (o motor é quem manda; o teste simula). */
  toquesSaidos = 0;
  ofertaMetodoSaiu = false;
  pendentesDoMotor: { leadId: string; estado: "pendente" | "cancelado"; motivo?: string }[] = [];
  avisos: Aviso[] = [];
  chips = new Map<string, { saude: string; pausadoAte?: Date }>();
  chipPorLead = new Map<string, string>();
  operadorFalou = new Set<string>();
  /** Leads cujo contato está com `force_human`. */
  forceHuman = new Set<string>();
  /** Conversas (por lead) sob olho humano: silêncio e dono. Vazio = nenhuma. */
  conversasDoLead = new Map<string, ConversaHumana[]>();
  /** Trava por lead (A3): lead → dono. */
  travas = new Map<string, string>();
  /** Leads marcados com `nao_contatar` (M2). */
  naoContatar = new Set<string>();

  constructor(
    public org: string,
    public disparo: ConfigDisparo,
    public atendimento: ConfigAtendimento | null,
  ) {}

  novoLead(id: string, dados: Partial<LeadComSituacao> = {}): LeadComSituacao {
    const l: LeadComSituacao = { id, nome: "Maria Silva", telefone: "5511900000000", campos: {}, bloqueado: false, anonimizado: false, status: "open", ...dados };
    this.leads.set(id, l);
    return l;
  }

  private daOrg(org: string) {
    if (org !== this.org) throw new Error(`consulta fora da organização: ${org}`);
  }

  async config(org: string) {
    this.daOrg(org);
    return { disparo: this.disparo, atendimento: this.atendimento };
  }
  async lead(org: string, leadId: string) {
    this.daOrg(org);
    return this.leads.get(leadId) ?? null;
  }
  async conversa(org: string, leadId: string) {
    this.daOrg(org);
    const c = this.conversas.get(leadId);
    return c ? structuredClone(c) : null;
  }
  async salvarConversa(org: string, leadId: string, c: ConversaGuardada) {
    this.daOrg(org);
    this.conversas.set(leadId, structuredClone(c));
  }
  async reservarLeitura(org: string, r: { chave: string; messageId: string | null; leadId: string; chipId: string | null; texto: string }) {
    this.daOrg(org);
    if (this.leituras.has(r.chave)) return null;
    const id = `leitura-${this.leituras.size + 1}`;
    this.leituras.set(r.chave, { id, leadId: r.leadId, chipId: r.chipId, texto: r.texto });
    return id;
  }
  async concluirLeitura(org: string, id: string, r: { leitura: Record<string, unknown>; decisao: string; irritada: boolean }) {
    this.daOrg(org);
    for (const l of this.leituras.values()) if (l.id === id) Object.assign(l, r);
  }
  async situacaoHumana(org: string, leadId: string, _conversationId: string | null): Promise<SituacaoHumana> {
    this.daOrg(org);
    return { forceHuman: this.forceHuman.has(leadId), conversas: this.conversasDoLead.get(leadId) ?? [] };
  }
  async marcarNaoContatar(org: string, leadId: string) {
    this.daOrg(org);
    this.naoContatar.add(leadId);
  }
  async tomarTravaDoLead(org: string, leadId: string, dono: string) {
    this.daOrg(org);
    if (this.travas.has(leadId)) return false;
    this.travas.set(leadId, dono);
    return true;
  }
  async soltarTravaDoLead(org: string, leadId: string, dono: string) {
    this.daOrg(org);
    if (this.travas.get(leadId) === dono) this.travas.delete(leadId);
  }
  async chipDoLead(org: string, leadId: string) {
    this.daOrg(org);
    return this.chipPorLead.get(leadId) ?? null;
  }
  async nossaUltima(org: string, leadId: string) {
    this.daOrg(org);
    return [...this.envios].reverse().find((e) => e.leadId === leadId && e.texto && !e.cancelado)?.texto ?? null;
  }
  async operadorFalouDesde(org: string, leadId: string) {
    this.daOrg(org);
    return this.operadorFalou.has(leadId);
  }
  async cancelarPendentesDoLead(org: string, leadId: string, motivo: string, poupaParada = false, poupaRetorno = false) {
    this.daOrg(org);
    let n = 0;
    for (const e of this.envios) {
      if (e.leadId !== leadId || e.estado !== "pendente" || e.cancelado) continue;
      if (poupaParada && e.daParada) continue;
      if (poupaRetorno && e.tipo === "retorno_reserva") continue;
      e.cancelado = motivo;
      n++;
    }
    for (const p of this.pendentesDoMotor) {
      if (p.leadId !== leadId || p.estado !== "pendente") continue;
      Object.assign(p, { estado: "cancelado", motivo });
      n++;
    }
    return n;
  }
  eventosRetorno: { leadId: string; envioId: string; evento: string }[] = [];
  async registrarEventoRetorno(org: string, leadId: string, envioId: string) {
    this.daOrg(org);
    this.eventosRetorno.push({ leadId, envioId, evento: "retorno_reserva_enviado" });
  }
  async cancelarRetornoReserva(org: string, leadId: string, motivo: string) {
    this.daOrg(org);
    let n = 0;
    for (const e of this.envios) {
      if (e.leadId === leadId && e.tipo === "retorno_reserva" && e.estado === "pendente" && !e.cancelado) { e.cancelado = motivo; n++; }
    }
    return n;
  }
  async fimDaFila(org: string, leadId: string, agora: Date) {
    this.daOrg(org);
    const t = this.envios.filter((e) => e.leadId === leadId && e.tipo !== "retorno_reserva" && !e.cancelado && e.enviarApos > agora).map((e) => e.enviarApos.getTime());
    return t.length ? new Date(Math.max(...t)) : null;
  }
  /** Chamadas que importam para a ORDEM do ponto de parada, na sequência em que aconteceram. */
  chamadas: string[] = [];
  async enfileirar(org: string, e: EnvioDoAtendimento) {
    this.daOrg(org);
    this.chamadas.push(`enfileirar:${e.tipo}`);
    this.envios.push({ ...e });
  }
  async avisar(org: string, a: { leadId: string; nivel: NivelDoAviso; titulo: string; corpo: string }) {
    this.daOrg(org);
    this.avisos.push({ ...a, status: "open" });
  }
  async fecharAvisosDoLead(org: string, leadId: string) {
    this.daOrg(org);
    for (const a of this.avisos) if (a.leadId === leadId) a.status = "resolved";
  }
  async irritacoesDoChip(org: string, chipId: string) {
    this.daOrg(org);
    return [...this.leituras.values()].filter((l) => l.chipId === chipId && l.irritada).length + 1;
  }
  async pesarNoChip(org: string, chipId: string, patch: { saude: "amarelo" | "vermelho"; pausadoAte?: Date }) {
    this.daOrg(org);
    const atual = this.chips.get(chipId) ?? { saude: "verde" };
    if (patch.saude === "amarelo" && atual.saude !== "verde") return;
    this.chips.set(chipId, { ...atual, ...patch });
  }

  /** Movimentos de card pedidos ao funil, na ordem. `funilResponde` simula o desfecho. */
  movimentos: { leadId: string; etapa: EtapaAtendimento; slug: string | null; modo: "simulado" | "real" }[] = [];
  funilResponde: MovimentoDoFunil = "movido";
  async moverNoFunil(org: string, leadId: string, m: { etapa: EtapaAtendimento; slug: string | null; modo: "simulado" | "real" }) {
    this.daOrg(org);
    this.movimentos.push({ leadId, ...m });
    return m.slug ? this.funilResponde : ("sem_mapa" as const);
  }

  /** Pontos de parada: o que o repositório recebeu, na ordem. `paradas` espelha o `pause-ai` da tela. */
  paradas: { leadId: string; conversationId: string | null; motivo: string }[] = [];
  movimentosDeParada: { leadId: string; pipeline: string | null; etapa: string; pontoId: string }[] = [];
  tags: { leadId: string; tag: string }[] = [];
  avisosAoCelular: { leadId: string; conversationId: string | null; chipId: string | null; ponto: string; destino: string; texto: string; enviarApos: Date; modo: "simulado" | "real" }[] = [];
  async pararConversa(org: string, leadId: string, conversationId: string | null, motivo: string) {
    this.daOrg(org);
    this.chamadas.push("pararConversa");
    this.paradas.push({ leadId, conversationId, motivo });
    // Como o banco: a conversa fica silenciada e o veto humano passa a valer.
    this.conversasDoLead.set(leadId, [{ botSilencedUntil: "infinity", assigneeKind: null, assignedToUserId: null }]);
    return 1;
  }
  async moverParaEtapa(org: string, leadId: string, m: { pipeline: string | null; etapa: string; pontoId: string; modo: "simulado" | "real" }) {
    this.daOrg(org);
    this.chamadas.push("moverParaEtapa");
    this.movimentosDeParada.push({ leadId, pipeline: m.pipeline, etapa: m.etapa, pontoId: m.pontoId });
    return this.funilResponde;
  }
  async aplicarTag(org: string, leadId: string, _conversationId: string | null, tag: string) {
    this.daOrg(org);
    this.chamadas.push("aplicarTag");
    this.tags.push({ leadId, tag });
  }
  async avisarCelular(org: string, a: Parameters<RepositorioAtendimento["avisarCelular"]>[1]) {
    this.daOrg(org);
    this.chamadas.push("avisarCelular");
    this.avisosAoCelular.push({ ...a, texto: a.texto.replaceAll("{chip}", a.chipId ?? "sem chip") });
    return { desfecho: a.modo === "real" ? ("pendente" as const) : ("simulado" as const) };
  }

  async toquesDoKitEnviados(org: string, leadId: string) {
    this.daOrg(org);
    void leadId;
    return this.toquesSaidos;
  }
  /** Conversa do inbox → lead (comandos do operador). */
  leadPorConversa = new Map<string, string>();
  async leadDaConversa(org: string, conversationId: string) {
    this.daOrg(org);
    return this.leadPorConversa.get(conversationId) ?? null;
  }
  async ofertaDoMetodoJaSaiu(org: string, leadId: string) {
    this.daOrg(org);
    void leadId;
    return this.ofertaMetodoSaiu;
  }

  /** Envios do lead (sem os cancelados), na ordem em que foram gravados. */
  enviosDo(leadId: string) {
    return this.envios.filter((e) => e.leadId === leadId && !e.cancelado);
  }
}

const p = (texto: string) => ({ texto });

/** Textos de exemplo do Método e do follow-up do kit; o seed grava os mesmos no jsonb. */
export const RESPOSTAS_DO_METODO = {
  metodo_oferta: [[
    p("Entendo que agora não é o momento do plano completo."),
    p("Tenho uma opção menor para começar: a *Oferta de Entrada*."),
    p("Você recebe o material de exemplo por mensagem."),
    p("São R$ 30, uma vez só, no Pix."),
    p("Quer que eu te mande o Pix?"),
  ]],
  metodo_pix: [[
    p("Certo! A Oferta de Entrada fica R$ 30."),
    p("Quer incluir o *Adicional* por mais R$ 15? Aí o Pix fica R$ 45."),
    p("Me responde *só a oferta* ou *com o adicional* que eu já te mando o Pix."),
  ]],
  metodo_d0: [[
    p("Pronto! Aqui está tudo: {link_entrega}"),
    p("Qualquer dúvida, é só me chamar."),
  ]],
  metodo_d7: [[
    p("Uma semana! Como está indo?"),
    p("Se quiser conhecer o plano completo, posso te explicar."),
    p('Se tiver interesse, me fala "quero saber".'),
  ]],
  metodo_d14: [[
    p("Duas semanas! Tenho uma condição para quem fez a oferta de entrada."),
    p("São 10% de desconto no Pix em qualquer plano do Produto A."),
    p("Quer que eu te mostre os planos?"),
  ]],
  kit_t1: [[p("{nome_virgula}ficou alguma dúvida sobre os planos?")]],
  kit_t2: [[p("Uma dúvida comum: o Produto A é simples de usar.")]],
  kit_t3: [[p("O que mais pesa para você agora: o valor, o prazo ou alguma dúvida?")]],
  kit_t4: [[p("Lembrando que todos os planos têm a garantia descrita no site.")]],
  kit_t5: [[p("Quer que eu te mande de novo a tabela com os valores?")]],
  kit_t6: [[p("{nome_virgula}ainda faz sentido para você seguir com isso agora? Se não for o momento, tudo bem, é só me dizer.")]],
  kit_t7: [[p("Vou deixar você à vontade. Quando quiser retomar, é só me chamar aqui.")]],
};

export const METODO_EXEMPLO = {
  ligado: true,
  oferta: "metodo_oferta",
  pedirPix: "metodo_pix",
  soMetodoCents: 3000,
  comCardapioCents: 4500,
  cardapioCents: 1500,
  linkEntrega: "https://entrega.exemplo/metodo",
  d0: "metodo_d0",
  d7: "metodo_d7",
  d14: "metodo_d14",
  diasD7: 7,
  diasD14: 14,
  vipDescontoPct: 10,
};

export const FOLLOWUP_KIT_EXEMPLO = {
  ligado: true,
  toques: [1, 2, 4, 6, 9, 12, 15].map((dia, i) => ({ dia, resposta: `kit_t${i + 1}` })),
  horasAteOferta: 48,
};

export const CELULAR_DO_OPERADOR = "5511900000002";

/** A venda de exemplo com o Método e o follow-up LIGADOS e o ponto de aviso do Pix. */
export const CONFIG_METODO_EXEMPLO: ConfigAtendimento = atendimentoSchema.parse({
  ...CONFIG_VENDA_EXEMPLO,
  respostas: { ...(CONFIG_VENDA_EXEMPLO as { respostas: object }).respostas, ...RESPOSTAS_DO_METODO },
  metodo: METODO_EXEMPLO,
  followupKit: FOLLOWUP_KIT_EXEMPLO,
  parada: {
    celular: CELULAR_DO_OPERADOR,
    pontos: [
      {
        id: "pix_metodo",
        evento: "pediu_pix_metodo",
        titulo: "PIX DO MÉTODO",
        parar: false,
        aviso: "Aviso: pediu {titulo}\nNome: {nome}\nWhatsApp: {telefone}\nChip: {chip}\nValor: {valor}",
      },
    ],
  },
});
