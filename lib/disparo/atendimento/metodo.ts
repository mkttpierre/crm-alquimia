/**
 * Pagamento confirmado da oferta de entrada ("método").
 *
 * `confirmarPagamentoMetodo` é chamada pelo operador (ou por uma integração de pagamento da organização)
 * quando o pagamento cair. Não há integração de pagamento embutida: quem a chama é a mão do operador.
 *
 * Agenda D0 (na hora, resposta automática que sobrevive à lead escrever em seguida), D7 e D14 (mensagens do
 * motor: se a lead responde, o atendimento cancela o que sobrou e a conversa volta ao normal), cancela o
 * follow-up do kit que ainda estiver na fila e grava a marca VIP (desconto no kit).
 */
import { envioRealLiberado, motivoDoSimulado } from "../trava";
import { aplicar, daJanelaDeResposta, type DepsDoAtendimento } from "./atendimento";
import { enfileirarPartesDoMotor } from "./followup-kit";
import { montarResposta } from "./pecas";

const DIA = 24 * 60 * 60 * 1000;

export type ResultadoDoPagamento = {
  resultado: "agendado" | "ja_pago" | "sem_metodo" | "sem_lead" | "sem_conversa" | "sem_link" | "barrado";
  resumo: string;
};

export async function confirmarPagamentoMetodo(deps: DepsDoAtendimento, org: string, leadId: string): Promise<ResultadoDoPagamento> {
  const { repo, agora } = deps;
  const cfg = await repo.config(org);
  const at = cfg?.atendimento;
  if (!cfg || !at || at.perfil !== "venda" || !at.metodo?.ligado) return { resultado: "sem_metodo", resumo: "Método desligado nesta organização" };
  const m = at.metodo;
  const lead = await repo.lead(org, leadId);
  if (!lead) return { resultado: "sem_lead", resumo: "lead não existe" };
  const conversa = await repo.conversa(org, leadId);
  if (!conversa) return { resultado: "sem_conversa", resumo: "a lead não tem conversa de atendimento" };
  if (conversa.dados.metodo.etapa === "pago") return { resultado: "ja_pago", resumo: "pagamento do Método já confirmado: nada a agendar" };
  if (!m.linkEntrega) return { resultado: "sem_link", resumo: "config sem metodo.linkEntrega: nada agendado" };

  const ritmo = cfg.disparo.ritmo;
  const sortear = deps.sortear ?? Math.random;
  const ctx = { lead, fusoMinutos: ritmo.fusoMinutos, proibidos: cfg.disparo.proibidos, sortear };
  // Quem pagou com o cardápio recebe o link que inclui o cardápio; sem ele configurado, o link do Método.
  const linkEntrega = (conversa.dados.metodo.comCardapio && m.linkEntregaComCardapio) || m.linkEntrega;
  const extras = { link_entrega: linkEntrega };
  // Monta e confere tudo ANTES de gravar qualquer coisa: ou agenda os três, ou nenhum.
  const d0 = montarResposta(at.respostas, m.d0, { ...ctx, agora, extras });
  const q7 = daJanelaDeResposta(new Date(agora.getTime() + m.diasD7 * DIA), at.janelaResposta, ritmo, sortear);
  const q14 = daJanelaDeResposta(new Date(agora.getTime() + m.diasD14 * DIA), at.janelaResposta, ritmo, sortear);
  const d7 = montarResposta(at.respostas, m.d7, { ...ctx, agora: q7, extras });
  const d14 = montarResposta(at.respostas, m.d14, { ...ctx, agora: q14, extras });
  for (const [nome, r] of [["D0", d0], ["D7", d7], ["D14", d14]] as const) {
    if (!r.ok) return { resultado: "barrado", resumo: `${nome} barrado (${r.motivo}): nada agendado` };
  }
  if (!d0.ok || !d7.ok || !d14.ok) throw new Error("inalcançável");

  const chipId = await repo.chipDoLead(org, leadId);
  const real = envioRealLiberado(cfg.disparo, deps.ambiente);
  // O follow-up do kit e a oferta do Método que sobraram na fila não fazem mais sentido.
  await repo.cancelarPendentesDoLead(org, leadId, "pagamento do Método confirmado");
  await aplicar(deps, org, leadId, chipId, [{ tipo: "responder", resposta: m.d0, partes: d0.partes }], {
    real,
    motivoSimulado: motivoDoSimulado(cfg.disparo, deps.ambiente),
    daParada: true, // a lead escrever logo depois ("paguei!") não derruba a entrega
    janela: at.janelaResposta,
    ritmo,
  });
  await enfileirarPartesDoMotor(repo, org, { leadId, chipId, tipo: "metodo_d7", quando: q7, partes: d7.partes });
  await enfileirarPartesDoMotor(repo, org, { leadId, chipId, tipo: "metodo_d14", quando: q14, partes: d14.partes });

  const dados = { ...conversa.dados, metodo: { ...conversa.dados.metodo, etapa: "pago" as const, pagoEm: agora.toISOString() }, vipDescontoPct: m.vipDescontoPct };
  await repo.salvarConversa(org, leadId, { ...conversa, dados, ultimaAutoEm: agora });
  return { resultado: "agendado", resumo: `Método pago: D0 na fila, D7 e D14 agendados, marca VIP ${m.vipDescontoPct}% gravada` };
}
