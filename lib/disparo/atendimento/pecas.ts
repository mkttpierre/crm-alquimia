/**
 * Montagem das peças que o atendimento manda: escolhe a versão da resposta,
 * preenche os `{slots}` com os mesmos atalhos do motor (`../textos.ts`) e
 * confere cada parte com o MESMO verificador e as mesmas regras proibidas da
 * casa (`disparo_config.proibidos`) — o brinde extra fora do último toque de uma organização
 * é barrado aqui também, sem regra nova.
 *
 * Espaçamento entre partes (ritmo humano pedido pelo operador, vale para TODO funil): 3 s depois de texto
 * ou imagem; 29 a 34 s depois de áudio (sorteado). Antes: portado de um motor anterior (`pausaApos`): áudio = duração + 8 s; imagem
 * 12 s e um pouco pela legenda; texto = o tempo de ler (8 a 40 s). Quem entrega nessa cadência é o motor
 * (`seguirSequencia` em `../motor.ts`).
 */
import type { Proibido } from "../config";
import type { Sortear } from "../ritmo";
import { montar, slotsPadrao, verificarTexto } from "../textos";
import type { Parte, Respostas } from "./config";
import type { LeadDoAtendimento } from "./estado";

const AUDIO = /\.(opus|ogg|mp3|m4a|aac|wav)$/i;

export const ehAudio = (p: Parte): boolean => Boolean(p.midia && AUDIO.test(p.midia.nome));

/** Depois de TEXTO, IMAGEM (ou vídeo/documento) a próxima parte sai exatamente 3 s depois. */
export const PAUSA_APOS_TEXTO_OU_IMAGEM_MS = 3_000;
/** Depois de ÁUDIO a próxima sai de 29 a 34 s depois (sorteado), qualquer que seja a duração do áudio. */
export const PAUSA_APOS_AUDIO_MIN_MS = 29_000;
export const PAUSA_APOS_AUDIO_MAX_MS = 34_000;

/** Pausa, em ms, depois de uma parte: 3 s, ou de 29 a 34 s (ao milissegundo) se foi um áudio. */
export function pausaDepoisDe(foiAudio: boolean, sortear: Sortear): number {
  return foiAudio
    ? PAUSA_APOS_AUDIO_MIN_MS + Math.round(sortear() * (PAUSA_APOS_AUDIO_MAX_MS - PAUSA_APOS_AUDIO_MIN_MS))
    : PAUSA_APOS_TEXTO_OU_IMAGEM_MS;
}

/** Segundos de espera depois de `p` até a parte seguinte. */
export const pausaApos = (p: Parte, sortear: Sortear = Math.random): number => pausaDepoisDe(ehAudio(p), sortear) / 1000;

/** Versão estável por lead e resposta: o mesmo lead nunca alterna de texto no meio da conversa. */
export function versaoPara(leadId: string, resposta: string, total: number): number {
  let h = 0;
  for (const c of `${leadId}:${resposta}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return total ? h % total : 0;
}

export type Montagem =
  | { ok: true; partes: (Parte & { aposSeg: number })[] }
  | { ok: false; motivo: string };

export function montarPartes(
  partes: Parte[],
  ctx: { lead: LeadDoAtendimento; agora: Date; fusoMinutos: number; proibidos: Proibido[]; extras?: Record<string, string>; sortear?: Sortear },
): Montagem {
  const slots = { ...slotsPadrao(ctx.lead.nome, ctx.agora, ctx.fusoMinutos), ...(ctx.extras ?? {}) };
  const saida: (Parte & { aposSeg: number })[] = [];
  // Áudio não leva legenda no WhatsApp: áudio com texto vira duas partes, o
  // áudio primeiro e o texto depois dele tocar (o envio real recusa a mistura).
  partes = partes.flatMap((p) => (ehAudio(p) && p.texto.trim() ? [{ texto: "", midia: p.midia }, { texto: p.texto, midia: null }] : [p]));
  for (const [i, p] of partes.entries()) {
    if (p.midia && !p.midia.id) return { ok: false, motivo: `mídia "${p.midia.nome}" não está na biblioteca da organização` };
    let texto = "";
    if (p.texto.trim()) {
      const m = montar(p.texto, slots);
      if (m.faltando.length) return { ok: false, motivo: `campo sem preencher: ${m.faltando.join(", ")}` };
      const problemas = verificarTexto(m.texto, { proibidos: ctx.proibidos });
      if (problemas.length) return { ok: false, motivo: `verificador: ${problemas.join(", ")}` };
      texto = m.texto;
    }
    saida.push({ texto, midia: p.midia, aposSeg: i === 0 ? 0 : pausaApos(partes[i - 1]!, ctx.sortear) });
  }
  return saida.length ? { ok: true, partes: saida } : { ok: false, motivo: "resposta sem partes" };
}

export function montarResposta(
  respostas: Respostas,
  id: string,
  ctx: Parameters<typeof montarPartes>[1],
): Montagem {
  const versoes = respostas[id];
  if (!versoes?.length) return { ok: false, motivo: `resposta "${id}" não configurada` };
  return montarPartes(versoes[versaoPara(ctx.lead.id, id, versoes.length)]!, ctx);
}
