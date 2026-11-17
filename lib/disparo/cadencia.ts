/**
 * Cadência: quais toques um lead recebe depois da primeira mensagem, e quando.
 *
 * Duas famílias portadas, escolhidas por organização em `disparo_config.cadencia`:
 *
 * - `reativacao_3_toques` (motor de uma organização): abertura no dia 0, toque 2 dois dias de
 *   envio depois, toque 3 cinco dias de envio depois e nunca antes de três dias
 *   de envio do toque 2 (se o 2 atrasou, o 3 anda junto). Horário sorteado
 *   dentro da janela do dia. Todos automáticos.
 *
 * - `prospeccao_14_dias` (motor da organização B, aula 3): D1 é a abertura; D2, D7 e D14
 *   saem sozinhos; D4 (áudio na voz do operador) e D10 (ligação) NUNCA saem pelo
 *   motor: viram lembrete ao operador. Conta dias corridos a partir da D1, no
 *   mesmo horário dela com um sorteio de até 25 min, e passa para o próximo dia
 *   de envio quando cai em dia sem janela.
 *
 * Funções puras. Quem grava o próximo passo na fila é `lib/disparo/motor.ts`.
 */
import type { Ritmo } from "./config";
import {
  blocosDoDia,
  diaDeEnvio,
  MIN,
  minutoNaJanela,
  noMinuto,
  relogio,
  somarDiasDeEnvio,
  type Sortear,
} from "./ritmo";

const DIA = 24 * 60 * MIN;

export type Lembrete = "audio" | "ligacao";

export type Passo = {
  /** Vira `disparo_envios.tipo`. */
  tipo: string;
  /** Dia do passo na régua da cadência (a abertura também tem o seu). */
  dia: number;
  /** false = o motor não envia; gera lembrete ao operador. */
  automatico: boolean;
  lembrete?: Lembrete;
  /** Folga mínima, em dias de envio, depois do passo anterior REALMENTE feito. */
  minimoAposAnterior?: number;
  /** Último toque ao lead: o único que pode levar a "última cartada" da casa. */
  ultimo?: boolean;
};

export type Cadencia = {
  id: string;
  contagem: "dias_de_envio" | "dias_corridos";
  passos: Passo[];
};

export const CADENCIAS: Record<string, Cadencia> = {
  reativacao_3_toques: {
    id: "reativacao_3_toques",
    contagem: "dias_de_envio",
    passos: [
      { tipo: "abertura", dia: 0, automatico: true },
      { tipo: "toque_2", dia: 2, automatico: true },
      { tipo: "toque_3", dia: 5, automatico: true, minimoAposAnterior: 3, ultimo: true },
    ],
  },
  prospeccao_14_dias: {
    id: "prospeccao_14_dias",
    contagem: "dias_corridos",
    passos: [
      { tipo: "abertura", dia: 1, automatico: true },
      { tipo: "d2", dia: 2, automatico: true },
      { tipo: "d4", dia: 4, automatico: false, lembrete: "audio" },
      { tipo: "d7", dia: 7, automatico: true },
      { tipo: "d10", dia: 10, automatico: false, lembrete: "ligacao" },
      { tipo: "d14", dia: 14, automatico: true, ultimo: true },
    ],
  },
};

export const CADENCIA_PADRAO = "reativacao_3_toques";

/** Cadência pelo id; id desconhecido cai na padrão (nunca lança). */
export const cadenciaPorId = (id: string | null | undefined): Cadencia =>
  CADENCIAS[id ?? ""] ?? CADENCIAS[CADENCIA_PADRAO]!;

/**
 * Campanha pontual de abertura (ex.: "Campanha Exemplo"): sai como uma abertura — janela, vez do
 * chip, piso entre novas, máximo por hora e teto de aberturas do dia —, mas fora da cadência: não planeja toque
 * seguinte e não esbarra no índice único (lead, tipo) da abertura que a lead já recebeu antes.
 */
export const TIPO_CAMPANHA_KIT = "campanha_kit";
/** Lembrete da mesma campanha: mesmo tratamento, tipo próprio para não esbarrar no índice (lead, tipo). */
export const TIPO_CAMPANHA_KIT_LEMBRETE = "campanha_kit_l";
export const ehCampanhaKit = (tipo: string) => tipo === TIPO_CAMPANHA_KIT || tipo === TIPO_CAMPANHA_KIT_LEMBRETE;

/**
 * Campanha por prefixo (retomada): `campanha_<nome>`, com minúsculas, dígitos e `_` (até 30), tem o
 * mesmo tratamento da `campanha_kit`. Cada campanha nova ganha o tipo dela, e o índice único (lead, tipo) não esbarra
 * na anterior. Os dois nomes antigos continuam valendo (cabem no padrão).
 */
export const PADRAO_CAMPANHA = /^campanha_[a-z0-9_]{1,30}$/;
export const ehCampanha = (tipo: string) => ehCampanhaKit(tipo) || PADRAO_CAMPANHA.test(tipo);
/**
 * Janela da base: `campanha_j<DDMM>` e os lembretes `_l<n>` (ex.: `campanha_j0101`, `campanha_j0101_l2`). É o último
 * recado da vez. Estrito de propósito: um futuro `campanha_produto_*` não pode liberar o proibido `excetoUltimo`.
 */
export const PADRAO_CAMPANHA_DA_JANELA = /^campanha_j\d{4}(_l\d)?$/;
export const ehCampanhaDaJanela = (tipo: string) => PADRAO_CAMPANHA_DA_JANELA.test(tipo);

/**
 * Tipos FIXOS que são prospecção (mensagem NOVA): passam pelo piso de 10 min e pela vez do chip. As campanhas por
 * prefixo não cabem numa lista: quem conta o chip (`contagem` do repositório) as soma pelo prefixo `campanha_`.
 */
export const tiposDeProspeccao = (cad: Cadencia) => new Set([...cad.passos.map((p) => p.tipo), TIPO_CAMPANHA_KIT, TIPO_CAMPANHA_KIT_LEMBRETE]);
/** O tipo é prospecção (passo da cadência ou campanha, inclusive por prefixo)? */
export const ehTipoDeProspeccao = (cad: Cadencia, tipo: string) => tiposDeProspeccao(cad).has(tipo) || ehCampanha(tipo);

export const passoDoTipo = (cad: Cadencia, tipo: string) => cad.passos.find((p) => p.tipo === tipo) ?? null;

/** O passo que vem depois de `feito`; null = acabou a cadência. */
export function proximoPasso(cad: Cadencia, feito: string): Passo | null {
  const i = cad.passos.findIndex((p) => p.tipo === feito);
  return i === -1 ? null : (cad.passos[i + 1] ?? null);
}

/**
 * Quando sai `passo`, para um lead aberto em `abertaEm`.
 * `feitoAnteriorEm` é quando o passo anterior saiu de fato: aplica a folga mínima.
 */
export function horaDoPasso(
  cad: Cadencia,
  passo: Passo,
  abertaEm: Date,
  ritmo: Ritmo,
  sortear: Sortear,
  feitoAnteriorEm?: Date,
): Date {
  const abertura = cad.passos[0]!;
  const offset = passo.dia - abertura.dia;
  let quando =
    cad.contagem === "dias_de_envio"
      ? emDiaDeEnvio(abertaEm, offset, ritmo, sortear)
      : emDiaCorrido(abertaEm, offset, ritmo, sortear);
  if (passo.minimoAposAnterior && feitoAnteriorEm) {
    const piso = emDiaDeEnvio(feitoAnteriorEm, passo.minimoAposAnterior, ritmo, sortear);
    if (piso.getTime() > quando.getTime()) quando = piso;
  }
  return quando;
}

/** `n` dias de envio depois, num minuto sorteado dentro da janela daquele dia. */
export function emDiaDeEnvio(desde: Date, n: number, ritmo: Ritmo, sortear: Sortear): Date {
  const dia = somarDiasDeEnvio(desde, n, ritmo);
  return noMinuto(dia, minutoNaJanela(blocosDoDia(dia, ritmo), sortear), ritmo);
}

/**
 * organização B: `n` dias corridos depois, no mesmo minuto da abertura mais até 25 min.
 * Cai em dia sem janela, anda para o próximo; cai no intervalo entre blocos
 * (almoço), vai para o começo do bloco seguinte; nunca nos 5 primeiros nem nos
 * 30 últimos minutos do dia.
 */
function emDiaCorrido(desde: Date, n: number, ritmo: Ritmo, sortear: Sortear): Date {
  let alvo = new Date(desde.getTime() + n * DIA);
  for (let i = 0; i < 60 && !diaDeEnvio(alvo, ritmo); i++) alvo = new Date(alvo.getTime() + DIA);
  const blocos = blocosDoDia(alvo, ritmo);
  let m = Math.round(relogio(desde, ritmo.fusoMinutos).minuto + sortear() * 25);
  const dentro = blocos.some((b) => m >= b.inicio && m < b.fim);
  if (!dentro) {
    const seguinte = blocos.find((b) => b.inicio > m);
    if (seguinte) m = seguinte.inicio + Math.round(sortear() * 20);
  }
  const primeiro = blocos[0]!;
  const ultimo = blocos[blocos.length - 1]!;
  m = Math.min(Math.max(m, primeiro.inicio + 5), ultimo.fim - 30);
  return noMinuto(alvo, m, ritmo);
}

/** Texto do lembrete ao operador para os passos manuais. */
export function textoDoLembrete(passo: Passo, quem: string): string {
  if (passo.lembrete === "audio") {
    return `Lembrete ${passo.tipo.toUpperCase()}: gravar um áudio de 30 a 60 s, na sua voz, pelo WhatsApp do chip, para ${quem}.`;
  }
  return `Lembrete ${passo.tipo.toUpperCase()}: ligar do celular do chip para ${quem}; se não atender, mandar a mensagem pelo WhatsApp do chip.`;
}
