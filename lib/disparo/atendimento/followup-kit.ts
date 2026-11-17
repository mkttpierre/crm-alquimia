/**
 * Planejamento do follow-up do kit e da oferta do Método.
 *
 * Quando a lead escreve depois de ver a tabela, os 7 toques e a oferta do Método são gravados de uma vez
 * na fila (`disparo_envios`, origem `motor`, estado `pendente`). Quem decide se saem, e quando, é o motor:
 * janela, vez do chip, piso entre mensagens novas, freios de saúde e humano no comando valem como em
 * qualquer toque. Se a lead responde, o atendimento cancela o que sobrou ("o lead escreveu") e este
 * módulo replaneja a partir da nova mensagem. Funções sem banco além do `repo` recebido.
 */
import type { Proibido, Ritmo } from "../config";
import { emDiaDeEnvio } from "../cadencia";
import { tipoDaOferta, tipoDoToque } from "../kit-followup";
import { dentroDaJanela, horaDeResponder, type Sortear } from "../ritmo";
import type { RepositorioAtendimento } from "./atendimento";
import type { ConfigVenda, Parte } from "./config";
import type { DadosConversa, LeadDoAtendimento } from "./estado";
import { motivoForaDaTabela } from "./parada";
import { montarResposta } from "./pecas";

const H = 60 * 60 * 1000;

export type PedidoDeFollowup = {
  at: ConfigVenda;
  lead: LeadDoAtendimento;
  chipId: string | null;
  dados: DadosConversa;
  /** A última mensagem da lead: de onde contam os dias. */
  base: Date;
  ritmo: Ritmo;
  proibidos: Proibido[];
  sortear: Sortear;
};

/** Grava as partes de uma resposta como envios do motor; a primeira leva `tipo`, as outras `tipo_p2`, `tipo_p3`... */
export async function enfileirarPartesDoMotor(
  repo: RepositorioAtendimento,
  org: string,
  p: { leadId: string; chipId: string | null; tipo: string; quando: Date; partes: (Parte & { aposSeg: number })[] },
): Promise<number> {
  let quando = p.quando;
  let n = 0;
  for (const [i, parte] of p.partes.entries()) {
    quando = new Date(quando.getTime() + parte.aposSeg * 1000);
    await repo.enfileirar(org, {
      leadId: p.leadId,
      chipId: p.chipId,
      tipo: i === 0 ? p.tipo : `${p.tipo}_p${i + 1}`,
      texto: parte.texto,
      midia: parte.midia,
      enviarApos: quando,
      // Sempre pendente: o motor é quem decide entre simular e enviar, na hora de sair (trava de envio real).
      estado: "pendente",
      motivo: null,
      origem: "motor",
    });
    n++;
  }
  return n;
}

/** Trava de preço (D5) também no que o motor vai mandar sozinho: valor fora da tabela (e fora do Método, se for o caso) barra. */
function conferida(m: ReturnType<typeof montarResposta>, at: ConfigVenda, extras: readonly number[]): ReturnType<typeof montarResposta> {
  if (!m.ok) return m;
  for (const parte of m.partes) {
    const fora = parte.texto ? motivoForaDaTabela(parte.texto, at.kits, extras) : null;
    if (fora) return { ok: false, motivo: fora };
  }
  return m;
}

export async function planejarFollowupKit(repo: RepositorioAtendimento, org: string, p: PedidoDeFollowup): Promise<{ toques: number; oferta: boolean; resumo: string }> {
  const { at, lead } = p;
  const fu = at.followupKit;
  if (!fu?.ligado) return { toques: 0, oferta: false, resumo: "follow-up desligado" };
  if (!p.chipId) return { toques: 0, oferta: false, resumo: "follow-up não planejado: lead sem chip" };
  const ctx = { lead, fusoMinutos: p.ritmo.fusoMinutos, proibidos: p.proibidos, sortear: p.sortear };
  const pulos: string[] = [];
  let toques = 0;
  let ultimo: Date | null = null;
  for (const [i, t] of fu.toques.entries()) {
    const quando = emDiaDeEnvio(p.base, t.dia, p.ritmo, p.sortear);
    const m = conferida(montarResposta(at.respostas, t.resposta, { ...ctx, agora: quando }), at, []);
    if (!m.ok) {
      pulos.push(`toque ${i + 1} pulado (${m.motivo})`);
      continue;
    }
    try {
      toques += await enfileirarPartesDoMotor(repo, org, { leadId: lead.id, chipId: p.chipId, tipo: tipoDoToque(i + 1, p.base), quando, partes: m.partes });
      ultimo = quando;
    } catch (e) {
      pulos.push(`toque ${i + 1} não gravado (${e instanceof Error ? e.message.slice(0, 60) : "erro"})`);
    }
  }

  let oferta = false;
  const metodo = at.metodo;
  if (metodo?.ligado && ultimo && !p.dados.metodo.oferecido && p.dados.metodo.etapa === "nenhuma" && !(await repo.ofertaDoMetodoJaSaiu?.(org, lead.id))) {
    // Depois do último toque sem retorno em `horasAteOferta`, dentro da janela de envio.
    const t = new Date(ultimo.getTime() + fu.horasAteOferta * H);
    const quando = dentroDaJanela(t, p.ritmo) ? t : horaDeResponder(t, p.ritmo, p.sortear, true);
    const m = conferida(montarResposta(at.respostas, metodo.oferta, { ...ctx, agora: quando }), at, [metodo.soMetodoCents, metodo.comCardapioCents, metodo.cardapioCents]);
    if (!m.ok) pulos.push(`oferta do Método pulada (${m.motivo})`);
    else {
      try {
        await enfileirarPartesDoMotor(repo, org, { leadId: lead.id, chipId: p.chipId, tipo: tipoDaOferta(p.base), quando, partes: m.partes });
        oferta = true;
      } catch (e) {
        pulos.push(`oferta do Método não gravada (${e instanceof Error ? e.message.slice(0, 60) : "erro"})`);
      }
    }
  }
  return { toques, oferta, resumo: `follow-up do kit: ${toques} toque(s)${oferta ? " + oferta do Método" : ""}${pulos.length ? ` [${pulos.join("; ")}]` : ""}` };
}

