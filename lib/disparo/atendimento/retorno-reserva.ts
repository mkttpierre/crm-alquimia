/** Retorno de reserva: usa a fila automática existente; nenhum envio direto ao canal. */
import type { ConfigDisparo } from "../config";
import { blocosDoDia, dentroDaJanela, horaDeResponder, MIN, type Sortear } from "../ritmo";
import { primeiroNome } from "../textos";
import type { EnvioDaFila } from "../motor";
import { aplicarPontosDeParada, type ConversaGuardada, type RepositorioAtendimento } from "./atendimento";
import { avaliarHumano } from "./humano";
import { naoContatarMarcado } from "../regras";
import type { ConfigVenda } from "./config";
import type { LeadDoAtendimento } from "./estado";
import { motivoForaDaTabela } from "./parada";
import { montarPartes, versaoPara } from "./pecas";
// Lead do teste A/B na trilha de cliente não é cliente (a mesma regra de `ehCliente` e `situacaoDoKit`).
import { noTesteAB } from "./venda";

export const TIPO_RETORNO_RESERVA = "retorno_reserva";
export const EVENTO_RETORNO_RESERVA = "retorno_reserva_enviado";
/** Lista de `disparo_config.modelos` do retorno de quem marcou o dia da compra ("compro dia 20"). Ausente = o da reserva. */
export const MODELO_RETORNO_COMPRA = "retorno_compra";
export const MODELO_RETORNO_RESERVA = "Olá {nome}, tudo bem? Consegui manter reservado o seu pedido até hoje, como combinamos 🌸 {linha_do_pedido} Para eu já separar e enviar, me confirma: prefere pagar no Pix ou no cartão?";

/** A mesma janela do chip; sem qualquer dia aberto, não cria um envio órfão. */
function naJanela(quando: Date, cfg: ConfigDisparo, sortear: Sortear): Date | null {
  const r = cfg.ritmo;
  if (!r.janela.semana.length && !r.janela.sabado.length && !r.janela.domingo.length) return null;
  // O helper existente procura até 60 dias. Confere antes para não cair em dia sem bloco.
  if (!Array.from({ length: 60 }, (_, i) => new Date(quando.getTime() + i * 24 * 60 * MIN)).some((d) => blocosDoDia(d, r).length)) return null;
  return dentroDaJanela(quando, r) ? quando : horaDeResponder(quando, r, sortear, true);
}

export async function planejarRetornoReserva(
  repo: RepositorioAtendimento, org: string,
  p: { cfg: ConfigDisparo; at: ConfigVenda; lead: LeadDoAtendimento; chipId: string | null; novo: ConversaGuardada; agora: Date; sortear: Sortear },
): Promise<string> {
  const falhar = async (motivo: string) => {
    p.novo.dados.retornoEm = null;
    await repo.salvarConversa(org, p.lead.id, p.novo);
    await repo.avisar(org, { leadId: p.lead.id, nivel: "operador", titulo: "Retorno da reserva não agendado", corpo: motivo });
    return " · retorno não agendado: " + motivo;
  };
  // Quem chama já tomou a trava do lead: cancelamento + inclusão são serializados por lead e organização.
  await repo.cancelarRetornoReserva(org, p.lead.id, "retorno remarcado: a lead combinou nova data");
  if (!p.chipId) return falhar("lead sem chip de origem: agende o retorno na mão");
  const quando = naJanela(new Date(Math.max(Date.parse(p.novo.dados.retornoEm!), p.agora.getTime() + 40_000)), p.cfg, p.sortear);
  if (!quando) return falhar("chip sem janela de envio disponível");
  // "Compro dia X": o texto do dia é o da casa (`modelos.retorno_compra`). Sem ele, NADA é agendado: o
  // texto da reserva fala de pedido reservado, e o bot nunca prometeu reserva.
  const daCompra = p.novo.dados.retornoPedido?.motivo === "compra";
  if (daCompra && !p.cfg.modelos[MODELO_RETORNO_COMPRA]?.length) {
    return falhar(`a lead marcou o dia da compra, mas a casa não tem o texto do retorno (modelos.${MODELO_RETORNO_COMPRA}): chame a lead no dia na mão`);
  }
  const chave = daCompra ? MODELO_RETORNO_COMPRA : TIPO_RETORNO_RESERVA;
  const modelos = p.cfg.modelos[chave];
  let modelo = modelos?.length ? modelos[versaoPara(p.lead.id, chave, modelos.length)]! : MODELO_RETORNO_RESERVA;
  // {nome} segue o padrão dos modelos, mas aqui a ausência remove o vocativo inteiro.
  if (!primeiroNome(p.lead.nome)) modelo = modelo.replace(/Olá\s+\{nome\},/gi, "Olá,").replaceAll("{nome}", "");
  const kit = p.novo.dados.retornoPedido?.kit;
  const montagem = montarPartes([{ texto: modelo, midia: null }], {
    lead: p.lead, agora: quando, fusoMinutos: p.cfg.ritmo.fusoMinutos, proibidos: p.cfg.proibidos,
    extras: { linha_do_pedido: kit ? "Seu kit de " + kit + " está separado aqui." : "Está tudo separado aqui com as condições que te passei." },
  });
  if (!montagem.ok) return falhar(montagem.motivo);
  const texto = montagem.partes[0]!.texto;
  const fora = motivoForaDaTabela(texto, p.at.kits);
  if (fora) return falhar(fora);
  try {
    await repo.enfileirar(org, { leadId: p.lead.id, chipId: p.chipId, tipo: TIPO_RETORNO_RESERVA, origem: "auto", texto, midia: null, enviarApos: quando, estado: "pendente", motivo: null, daParada: false });
  } catch {
    return falhar("falha ao gravar a reserva na fila: confira e agende na mão");
  }
  p.novo.dados.retornoEm = quando.toISOString();
  await repo.salvarConversa(org, p.lead.id, p.novo);
  return " · retorno reservado para " + quando.toISOString();
}

/** Revalida também as reservas futuras: compra, recusa, humano e configuração desligada. */
export async function conferirRetornoReserva(repo: RepositorioAtendimento, org: string, envio: EnvioDaFila, agora: Date): Promise<string | null> {
  const cfg = await repo.config(org);
  const at = cfg?.atendimento;
  if (!at?.ligado || at.perfil !== "venda" || !at.retornoReserva.ligado) return "retorno cancelado: recurso desligado";
  const lead = await repo.lead(org, envio.leadId);
  if (!lead || lead.bloqueado || lead.anonimizado || naoContatarMarcado(lead.campos)) return "retorno cancelado: lead não contatável";
  const c = await repo.conversa(org, envio.leadId);
  if (!c || !c.dados.retornoEm) return "retorno cancelado: reserva não está mais ativa";
  if (c.etapa === "nao_contatar" || c.etapa === "perdido") return "retorno cancelado: lead encerrado";
  if (lead.status !== "open" || c.quente || c.etapa === "pronto_fechar" || c.etapa === "fechado" || c.dados.metodo.etapa === "pago" || (!noTesteAB(lead.campos) && (at.clientes?.trilhas ?? []).includes(String(lead.campos.trilha ?? "")))) return "retorno cancelado: compra ou fechamento antecipado";
  const { veto } = avaliarHumano(await repo.situacaoHumana(org, lead.id, null), agora);
  if (veto) return "retorno cancelado: humano no comando (" + veto.motivo + ")";
  if (await repo.operadorFalouDesde(org, lead.id, envio.criadoEm)) return "retorno cancelado: operador assumiu a conversa";
  if (c.autoSeguidas >= cfg!.disparo.ritmo.limiteAutomaticasSeguidas) return "retorno cancelado: limite de respostas automáticas seguidas";
  return null;
}

/** Só é chamado pelo motor depois que o canal aceitou (ou depois da simulação). */
export async function registrarRetornoReservaEnviado(repo: RepositorioAtendimento, org: string, envio: EnvioDaFila, agora: Date, modo: "simulado" | "real"): Promise<void> {
  const cfg = await repo.config(org);
  const at = cfg?.atendimento;
  const c = await repo.conversa(org, envio.leadId);
  const lead = await repo.lead(org, envio.leadId);
  if (!at || at.perfil !== "venda" || !c || !lead || c.dados.retornoEnviadoId === envio.id) return;
  Object.assign(c, { quente: true, precisaOperador: true, motivoOperador: "Retorno da reserva enviado: confirmar pagamento e fechar", etapa: "pronto_fechar", ultimaAutoEm: agora, autoSeguidas: c.autoSeguidas + 1 });
  c.dados.retornoEm = null;
  await repo.salvarConversa(org, lead.id, c);
  await repo.registrarEventoRetorno(org, lead.id, envio.id);
  await repo.avisar(org, { leadId: lead.id, nivel: "compra", titulo: "Retorno da reserva enviado: lead quente para fechar", corpo: "O pedido reservado foi retomado. Confirme Pix ou cartão e conclua o fechamento." });
  // O novo evento aceita ponto próprio; sem ele, herda o destino/etiqueta do ponto de compra.
  const compra = at.parada.pontos.find((p) => p.evento === "escolheu_kit");
  const pontos: ConfigVenda["parada"]["pontos"] = at.parada.pontos.some((p) => p.evento === EVENTO_RETORNO_RESERVA)
    ? at.parada.pontos
    : [...at.parada.pontos, { ...compra, id: TIPO_RETORNO_RESERVA, evento: EVENTO_RETORNO_RESERVA, titulo: "RETORNO RESERVADO", parar: true, notificar: true }];
  await aplicarPontosDeParada({ repo, agora }, org, {
    lead, texto: envio.texto, eventos: [EVENTO_RETORNO_RESERVA], conversationId: null, chipId: envio.chipId,
    parada: { ...at.parada, pontos }, kit: c.dados.retornoPedido?.kit ?? c.dados.kitEscolhido,
    jaAvisados: [], jaAvisou: true, modo,
  });
  await repo.moverNoFunil(org, lead.id, { etapa: "pronto_fechar", slug: at.funil.pronto_fechar ?? null, modo });
  c.dados.retornoEnviadoId = envio.id;
  await repo.salvarConversa(org, lead.id, c);
}
