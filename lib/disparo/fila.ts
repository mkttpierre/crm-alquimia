/**
 * Decisões da fila, puras: pode este chip mandar agora? o que muda no chip
 * depois de mandar? o dia virou? Portado de `voltaFila`/`voltaAbertura` de uma organização,
 * sem banco — quem conta e grava é `lib/disparo/motor.ts`.
 */
import type { Ritmo } from "./config";
import {
  dentroDaJanela,
  inicioDoDia,
  intervaloNova,
  MIN,
  pausaACada,
  pausaLonga,
  primeiroEnvioDoDia,
  type Sortear,
  tetoAberturas,
  tetoTotal,
} from "./ritmo";

export const ESTADOS_ENVIO = ["pendente", "enviando", "enviado", "simulado", "cancelado", "falhou"] as const;
export type EstadoEnvio = (typeof ESTADOS_ENVIO)[number];

/** Estados que contam como "saiu" para ritmo e tetos (o simulado conta: o ensaio imita o real). */
export const ESTADOS_SAIDOS: EstadoEnvio[] = ["enviado", "simulado"];

export const ORIGENS_ENVIO = ["motor", "auto", "operador", "lembrete"] as const;
export type OrigemEnvio = (typeof ORIGENS_ENVIO)[number];

export const ESTADOS_CHIP = ["rampa", "ativo", "pausado", "desligado"] as const;
export type EstadoChip = (typeof ESTADOS_CHIP)[number];
export const SAUDES_CHIP = ["verde", "amarelo", "vermelho"] as const;
export type SaudeChip = (typeof SAUDES_CHIP)[number];

export type Chip = {
  id: string;
  /** Nome do chip (`disparo_chips.nome`); as regras por chip da organização (rampa atrasada, filtro de abertura) usam. */
  nome?: string;
  estado: EstadoChip;
  saude: SaudeChip;
  diaRampa: number;
  proximoEnvioEm: Date | null;
  pausadoAte: Date | null;
  enviosDesdePausa: number;
  pausaACada: number;
  /** Quando o motor calculou a saúde pela última vez (`lib/disparo/saude.ts`); ausente = nunca. */
  saudeCalculadaEm?: Date | null;
  /** Por que a cor é amarela ou vermelha (texto para o painel). */
  saudeMotivo?: string | null;
};

/** O que já saiu do chip, contado pelo motor no banco. */
export type Contagem = {
  ultimoEnvioEm: Date | null;
  ultimaNovaEm: Date | null;
  enviosHoje: number;
  aberturasHoje: number;
  enviosUltimaHora: number;
  aberturasUltimaHora: number;
};

export type Decisao = { ok: true } | { ok: false; motivo: string };

/** Chip pode participar da volta? (saúde, pausa, estado.) */
export function chipNaVolta(chip: Chip, agora: Date): Decisao {
  if (chip.estado === "desligado" || chip.estado === "pausado") return { ok: false, motivo: `chip ${chip.estado}` };
  if (chip.saude === "vermelho") return { ok: false, motivo: "saúde vermelha: parado" };
  if (chip.pausadoAte && chip.pausadoAte.getTime() > agora.getTime()) return { ok: false, motivo: "chip em pausa" };
  return { ok: true };
}

/**
 * Pode sair uma mensagem deste tipo agora?
 *  - `nova` (abertura ou toque): janela, vez do chip, piso de 10 min desde a
 *    última nova, máximo por hora e teto do dia;
 *  - `resposta` (a quem escreveu): só o piso entre quaisquer envios, máximo por
 *    hora e teto total. Fora da janela pode — conversa não espera o dia seguinte.
 */
export function podeEnviar(
  tipo: "abertura" | "toque" | "resposta",
  chip: Chip,
  c: Contagem,
  ritmo: Ritmo,
  tetoDiario: number | null,
  agora: Date,
): Decisao {
  const t = agora.getTime();
  if (c.ultimoEnvioEm && t - c.ultimoEnvioEm.getTime() < ritmo.intervaloMinimoSeg * 1000)
    return { ok: false, motivo: "esperando o intervalo mínimo do último envio" };
  if (c.enviosUltimaHora >= ritmo.maxEnviosHora) return { ok: false, motivo: `${ritmo.maxEnviosHora} envios na última hora` };
  const total = tetoTotal(chip.diaRampa, ritmo, tetoDiario, chip.nome);
  if (c.enviosHoje >= total) return { ok: false, motivo: `teto do dia batido (${c.enviosHoje}/${total})` };
  if (tipo === "resposta") return { ok: true };

  if (!dentroDaJanela(agora, ritmo)) return { ok: false, motivo: "fora da janela de prospecção" };
  if (chip.proximoEnvioEm && chip.proximoEnvioEm.getTime() > t) return { ok: false, motivo: "esperando a vez do chip" };
  if (c.ultimaNovaEm && t - c.ultimaNovaEm.getTime() < ritmo.intervaloNovaPisoMin * MIN)
    return { ok: false, motivo: `esperando ${ritmo.intervaloNovaPisoMin} min da última mensagem nova` };
  if (tipo === "abertura") {
    const teto = tetoAberturas(chip.diaRampa, ritmo, tetoDiario, chip.nome);
    if (c.aberturasHoje >= teto) return { ok: false, motivo: `teto de aberturas do dia (${c.aberturasHoje}/${teto})` };
    if (c.aberturasUltimaHora >= ritmo.maxAberturasHora)
      return { ok: false, motivo: `${ritmo.maxAberturasHora} aberturas na última hora` };
  }
  return { ok: true };
}

/** Depois de uma mensagem nova: próxima vez do chip e, a cada N, pausa longa. */
export function aposMensagemNova(chip: Chip, ritmo: Ritmo, agora: Date, sortear: Sortear) {
  const enviosDesdePausa = chip.enviosDesdePausa + 1;
  const pausou = enviosDesdePausa >= chip.pausaACada;
  const espera = pausou ? pausaLonga(ritmo, sortear, chip.diaRampa, agora) : intervaloNova(chip.diaRampa, agora, ritmo, sortear);
  return {
    proximoEnvioEm: new Date(agora.getTime() + espera),
    enviosDesdePausa: pausou ? 0 : enviosDesdePausa,
    pausaACada: pausou ? pausaACada(ritmo, sortear, chip.diaRampa, agora) : chip.pausaACada,
    pausou,
    esperaMin: Math.round(espera / MIN),
  };
}

/**
 * Primeira volta do dia do chip (a vez ainda é de ontem): sorteia o primeiro
 * envio e sobe um degrau da rampa quando o chip está verde, em rampa e mandou
 * algo nos últimos dias de envio. Amarelo segura onde está. null = o dia já
 * estava aberto.
 */
export function abrirDia(chip: Chip, mandouRecente: boolean, ritmo: Ritmo, agora: Date, sortear: Sortear) {
  const hoje = inicioDoDia(agora, ritmo.fusoMinutos);
  if (chip.proximoEnvioEm && chip.proximoEnvioEm.getTime() >= hoje.getTime()) return null;
  const sobe = chip.estado === "rampa" && chip.saude === "verde" && mandouRecente ? 1 : 0;
  return {
    proximoEnvioEm: new Date(agora.getTime() + primeiroEnvioDoDia(ritmo, sortear)),
    diaRampa: chip.diaRampa + sobe,
    enviosDesdePausa: 0,
    pausaACada: pausaACada(ritmo, sortear, chip.diaRampa + sobe, agora),
  };
}

/** Erro de envio com cara de restrição, bloqueio ou chip derrubado: para o chip 48 h. */
export const sinalDeRestricao = (erro: string) =>
  /restri|banned|\bban\b|blocked|forbidden|not-authorized|\b401\b|\b403\b|connection closed|precondition required|\b428\b|logged ?out/i.test(
    erro,
  );

/**
 * Freio depois de uma falha: restrição = vermelho por 48 h e volta ao dia 1 da rampa (só a mão do operador o
 * devolve); falha comum = segura 10 min.
 */
export function freioDoChip(erro: string, agora: Date) {
  return sinalDeRestricao(erro)
    ? {
        saude: "vermelho" as const,
        pausadoAte: new Date(agora.getTime() + 48 * 60 * MIN),
        diaRampa: 1,
        saudeMotivo: `Erro de envio com sinal de restrição: ${erro.slice(0, 120)}`,
        saudeCalculadaEm: agora,
      }
    : { proximoEnvioEm: new Date(agora.getTime() + 10 * MIN) };
}
