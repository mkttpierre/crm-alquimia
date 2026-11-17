/**
 * Proteção do chip como funções puras: relógio local, janela do dia, rampa,
 * intervalos e pausas. Portado de um motor anterior (`src/lib/ritmo.ts`) e da organização B
 * (`src/lib/ritmo.ts`), com tudo que era constante virando `Ritmo` da
 * organização (`lib/disparo/config.ts`).
 *
 * Nada aqui lê relógio nem sorteia por conta própria: `agora` e `sortear` são
 * parâmetros, para o teste fixar o dia e a sorte e provar o limite, não a média.
 */
import type { Bloco, Faixa, Ritmo } from "./config";

export const MIN = 60 * 1000;
export const H = 60 * MIN;
const DIA = 24 * H;

/** Fonte de sorte em [0, 1). Em produção, `Math.random`. */
export type Sortear = () => number;

const entre = (f: Faixa, sortear: Sortear) => f.min + sortear() * (f.max - f.min);

/** Relógio local: data (AAAA-MM-DD), dia da semana (0 = domingo) e minutos desde a meia-noite. */
export function relogio(agora: Date, fusoMinutos: number) {
  const local = new Date(agora.getTime() + fusoMinutos * MIN);
  return {
    data: local.toISOString().slice(0, 10),
    diaSemana: local.getUTCDay(),
    minuto: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** Meia-noite local do dia de `agora`, como instante UTC. */
export function inicioDoDia(agora: Date, fusoMinutos: number): Date {
  const { data } = relogio(agora, fusoMinutos);
  return new Date(Date.parse(`${data}T00:00:00Z`) - fusoMinutos * MIN);
}

/** Blocos de prospecção do dia de `agora` (vazio em feriado e em dia sem janela). */
export function blocosDoDia(agora: Date, ritmo: Ritmo): Bloco[] {
  const r = relogio(agora, ritmo.fusoMinutos);
  if (ritmo.feriados.includes(r.data)) return [];
  if (r.diaSemana === 0) return ritmo.janela.domingo;
  if (r.diaSemana === 6) return ritmo.janela.sabado;
  return ritmo.janela.semana;
}

/** Dia que conta para a cadência: tem janela de prospecção e não é feriado. */
export const diaDeEnvio = (agora: Date, ritmo: Ritmo) => blocosDoDia(agora, ritmo).length > 0;

export function dentroDaJanela(agora: Date, ritmo: Ritmo): boolean {
  const { minuto } = relogio(agora, ritmo.fusoMinutos);
  return blocosDoDia(agora, ritmo).some((b) => minuto >= b.inicio && minuto < b.fim);
}

/** Minutos que ainda restam no bloco corrente (0 = fora da janela). */
export function minutosRestantes(agora: Date, ritmo: Ritmo): number {
  const { minuto } = relogio(agora, ritmo.fusoMinutos);
  const b = blocosDoDia(agora, ritmo).find((x) => minuto >= x.inicio && minuto < x.fim);
  return b ? b.fim - minuto : 0;
}

const domingo = (agora: Date, ritmo: Ritmo) => relogio(agora, ritmo.fusoMinutos).diaSemana === 0;

/**
 * Espera até a próxima mensagem NOVA do chip, em ms. Nunca abaixo do piso
 * (10 min por padrão): é o intervalo, não a janela, que protege o chip.
 * Primeiros dias da rampa mais espaçados; domingo (janela curta) mais justo e
 * sem extra; nos demais dias, de vez em quando um extra (ritmo humano, nunca
 * uniforme).
 */
export function intervaloNova(diaRampa: number, agora: Date, ritmo: Ritmo, sortear: Sortear): number {
  const inicio = ritmo.intervaloInicioRampa[Math.max(1, diaRampa) - 1];
  let minutos: number;
  if (inicio) minutos = entre(inicio, sortear);
  else if (domingo(agora, ritmo)) minutos = entre(ritmo.intervaloDomingo, sortear);
  else {
    const faixa = diaRampa >= ritmo.diaMaduro ? ritmo.intervaloNovaMaduro : ritmo.intervaloNova;
    minutos = entre(faixa, sortear) + (sortear() < ritmo.extraChance ? entre(ritmo.extra, sortear) : 0);
  }
  return Math.max(ritmo.intervaloNovaPisoMin, minutos) * MIN;
}

/** Faixas da pausa longa que valem para o chip agora: domingo, chip maduro ou a comum. */
function faixasDaPausa(ritmo: Ritmo, diaRampa: number, agora: Date): { dura: Faixa; aCada: Faixa } {
  if (domingo(agora, ritmo) && ritmo.pausaDomingo && ritmo.pausaACadaDomingo)
    return { dura: ritmo.pausaDomingo, aCada: ritmo.pausaACadaDomingo };
  if (diaRampa >= ritmo.diaMaduro && ritmo.pausaMaduro && ritmo.pausaACadaMaduro)
    return { dura: ritmo.pausaMaduro, aCada: ritmo.pausaACadaMaduro };
  return { dura: ritmo.pausa, aCada: ritmo.pausaACada };
}

/** Duração da pausa longa, em ms. */
export const pausaLonga = (ritmo: Ritmo, sortear: Sortear, diaRampa = 1, agora = new Date(0)) =>
  entre(faixasDaPausa(ritmo, diaRampa, agora).dura, sortear) * MIN;

/** Quantos envios novos até a próxima pausa longa (inteiro dentro da faixa, pontas inclusive). */
export function pausaACada(ritmo: Ritmo, sortear: Sortear, diaRampa = 1, agora = new Date(0)): number {
  const f = faixasDaPausa(ritmo, diaRampa, agora).aCada;
  return Math.min(f.max, Math.floor(f.min + sortear() * (f.max - f.min + 1)));
}

/** Primeiro envio do dia: alguns minutos depois de abrir, nunca em ponto. */
export const primeiroEnvioDoDia = (ritmo: Ritmo, sortear: Sortear) => entre(ritmo.primeiroEnvioDoDiaMin, sortear) * MIN;

/** Aberturas por chip no dia, pela rampa, limitadas pelo teto da organização. */
export function tetoAberturas(diaRampa: number, ritmo: Ritmo, tetoDiario: number | null, chipNome?: string): number {
  const d = Math.max(1, diaRampa);
  let teto = ritmo.rampa[Math.min(d, ritmo.rampa.length) - 1]!;
  // Chip frio com rampa própria (exemplo: chip-frio-2): a dele, dia a dia, vence qualquer outra regra de rampa.
  const propria = chipNome ? ritmo.rampasPorChip[chipNome] : undefined;
  if (propria) {
    teto = propria[Math.min(d, propria.length) - 1]!;
  } else if (chipNome && ritmo.chipsRampaAtrasada.includes(chipNome)) {
    // Chip de rampa atrasada (exemplo: chips de uma oferta com base mais fria): um degrau atrás e no máximo `rampaAtrasadaTeto`.
    teto = Math.min(ritmo.rampaAtrasadaTeto, ritmo.rampa[Math.max(0, Math.min(d, ritmo.rampa.length) - 2)]!);
  }
  return tetoDiario !== null && tetoDiario > 0 ? Math.min(teto, tetoDiario) : teto;
}

/** Teto de TODOS os envios do chip no dia (aberturas, toques e respostas). */
export const tetoTotal = (diaRampa: number, ritmo: Ritmo, tetoDiario: number | null, chipNome?: string) =>
  Math.round(tetoAberturas(diaRampa, ritmo, tetoDiario, chipNome) * ritmo.fatorTotal) + ritmo.folgaTotal;

/** "Digitando..." de 3 a 10 s conforme o tamanho do texto, com ±20%. */
export const tempoDigitando = (texto: string, sortear: Sortear) =>
  Math.round(Math.min(10000, Math.max(3000, texto.length * 25 * (0.8 + sortear() * 0.4))));

/** Minuto sorteado dentro dos blocos do dia, com folga nas pontas (bloco escolhido pelo tamanho). */
export function minutoNaJanela(blocos: Bloco[], sortear: Sortear, folgaInicio = 15, folgaFim = 30): number {
  const uteis = blocos
    .map((b) => ({ inicio: b.inicio + folgaInicio, fim: b.fim - folgaFim }))
    .filter((b) => b.fim > b.inicio);
  const usados = uteis.length ? uteis : blocos;
  const total = usados.reduce((s, b) => s + (b.fim - b.inicio), 0);
  let r = sortear() * total;
  for (const b of usados) {
    const tam = b.fim - b.inicio;
    if (r < tam) return Math.floor(b.inicio + r);
    r -= tam;
  }
  return usados[0]!.inicio;
}

/** Instante do minuto `minuto` (local) no dia de `dia`. */
export function noMinuto(dia: Date, minuto: number, ritmo: Ritmo): Date {
  return new Date(inicioDoDia(dia, ritmo.fusoMinutos).getTime() + minuto * MIN);
}

/** Avança `n` dias de envio a partir do dia de `desde` (o dia de partida não conta). */
export function somarDiasDeEnvio(desde: Date, n: number, ritmo: Ritmo): Date {
  let dia = new Date(inicioDoDia(desde, ritmo.fusoMinutos).getTime() + 12 * H);
  let faltam = n;
  while (faltam > 0) {
    dia = new Date(dia.getTime() + DIA);
    if (diaDeEnvio(dia, ritmo)) faltam--;
  }
  return dia;
}

/** Próximo dia de envio a partir do dia de `desde` (inclusive). */
export function proximoDiaDeEnvio(desde: Date, ritmo: Ritmo): Date {
  let dia = new Date(inicioDoDia(desde, ritmo.fusoMinutos).getTime() + 12 * H);
  for (let i = 0; i < 60 && !diaDeEnvio(dia, ritmo); i++) dia = new Date(dia.getTime() + DIA);
  return dia;
}

/**
 * Quando sai uma resposta a quem escreveu: 2 a 6 min depois. Por padrão sai
 * mesmo fora da janela de prospecção (conversa em andamento não espera o dia
 * seguinte); com `respeitarJanela`, vai para o começo do próximo bloco.
 */
export function horaDeResponder(agora: Date, ritmo: Ritmo, sortear: Sortear, respeitarJanela = false): Date {
  const t = new Date(agora.getTime() + (2 + sortear() * 4) * MIN);
  if (!respeitarJanela || dentroDaJanela(t, ritmo)) return t;
  const { minuto } = relogio(t, ritmo.fusoMinutos);
  const ainda = blocosDoDia(t, ritmo).find((b) => b.inicio > minuto);
  if (ainda) return noMinuto(t, ainda.inicio + Math.floor(sortear() * 20), ritmo);
  const dia = proximoDiaDeEnvio(new Date(t.getTime() + DIA), ritmo);
  return noMinuto(dia, blocosDoDia(dia, ritmo)[0]!.inicio + Math.floor(sortear() * 20), ritmo);
}
