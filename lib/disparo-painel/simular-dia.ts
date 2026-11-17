/**
 * Simulação do dia do motor, para a tela mostrar o que um ritmo (ou um perfil ainda não salvo) faz: a que horas saem
 * as aberturas de cada chip, onde caem as pausas longas, quantas cabem no dia. Nada é enviado nem gravado.
 *
 * A simulação NÃO reimplementa regra nenhuma: ela anda o dia minuto a minuto, como a volta do cron, e pergunta às
 * MESMAS funções que o motor usa (`lib/disparo/fila.ts`: `abrirDia`, `podeEnviar`, `aposMensagemNova`, que por sua
 * vez usam `blocosDoDia`, `primeiroEnvioDoDia`, `intervaloNova`, `pausaACada`, `pausaLonga` e `tetoAberturas` de
 * `lib/disparo/ritmo.ts`). Mudou a regra do motor, muda a simulação. O sorteio é determinístico pela semente: a
 * mesma semente dá o mesmo dia (a tela não "pisca" a cada recarga).
 *
 * O que ela não sabe, de propósito: se há leads na etapa, respostas e toques (que também gastam o teto total), a
 * saúde do chip ao longo do dia. É o dia de um chip verde com fila cheia de aberturas.
 */
import type { Ritmo } from "@/lib/disparo/config";
import { abrirDia, aposMensagemNova, type Chip, chipNaVolta, type Contagem, type EstadoChip, podeEnviar, type SaudeChip } from "@/lib/disparo/fila";
import { blocosDoDia, inicioDoDia, MIN, type Sortear } from "@/lib/disparo/ritmo";

/**
 * O chip como está no banco. Só `nome` e `diaRampa` são obrigatórios; o resto, ausente, é o chip ativo e verde, sem
 * pausa e sem o dia aberto. `proximoEnvioEm` (a vez gravada) diz se o motor já abriu o dia do chip hoje, e
 * `mandouRecente` (algo saiu nos últimos 4 dias) se a rampa sobe um degrau ao abrir — a mesma pergunta que o motor
 * faz (`repo.mandouDesde`).
 */
export type ChipSimulado = {
  nome: string;
  diaRampa: number;
  maduro?: boolean;
  estado?: EstadoChip;
  saude?: SaudeChip;
  pausadoAte?: Date | null;
  proximoEnvioEm?: Date | null;
  mandouRecente?: boolean;
};
export type DiaSimuladoDoChip = {
  nome: string;
  /** O degrau da rampa que vale no dia simulado (o de hoje, já com a subida da abertura do dia). */
  diaRampa: number;
  envios: Date[];
  pausas: { inicio: Date; fim: Date }[];
  /** Por que o chip não manda nada hoje (pausado, desligado, saúde vermelha, em pausa); null = manda. */
  parado: string | null;
};
export type DiaSimulado = {
  porChip: DiaSimuladoDoChip[];
  totalNovas: number;
  primeira: Date | null;
  ultima: Date | null;
  pausasLongas: number;
};

const H = 60 * MIN;

/** mulberry32: sorteio pequeno e determinístico em [0, 1). */
function sorteador(semente: number): Sortear {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simularChip(ritmo: Ritmo, entrada: ChipSimulado, dia: Date, sortear: Sortear, tetoDiario: number | null): DiaSimuladoDoChip {
  const meiaNoite = inicioDoDia(dia, ritmo.fusoMinutos).getTime();
  const blocos = blocosDoDia(new Date(meiaNoite + 12 * H), ritmo);
  const diaRampa = entrada.maduro ? Math.max(entrada.diaRampa, ritmo.diaMaduro) : Math.max(1, entrada.diaRampa);
  const chip: Chip = {
    id: entrada.nome,
    nome: entrada.nome,
    estado: entrada.estado ?? "ativo",
    saude: entrada.saude ?? "verde",
    diaRampa,
    proximoEnvioEm: entrada.proximoEnvioEm ?? null,
    pausadoAte: entrada.pausadoAte ?? null,
    enviosDesdePausa: 0,
    pausaACada: 1,
  };
  const resultado: DiaSimuladoDoChip = { nome: entrada.nome, diaRampa, envios: [], pausas: [], parado: null };

  // Chip parado agora (pausado, desligado, vermelho, em pausa de saúde) não manda nada no dia: a mesma porta da volta
  // do motor (`chipNaVolta`). Quem o solta (a saúde, o operador) não é simulado.
  const naVolta = chipNaVolta(chip, dia);
  if (!naVolta.ok) {
    resultado.parado = naVolta.motivo;
    return resultado;
  }
  if (blocos.length === 0) return resultado;

  const inicio = meiaNoite + Math.min(...blocos.map((b) => b.inicio)) * MIN;
  const fim = meiaNoite + Math.max(...blocos.map((b) => b.fim)) * MIN;
  // Abertura do dia como o motor faz: dia ainda não aberto hoje = sorteia o primeiro envio e, em rampa, verde e com
  // envio recente, sobe um degrau. Dia já aberto: o degrau gravado já é o de hoje, e o dia é desenhado inteiro, do
  // começo da janela (sem subir de novo).
  const jaAberto = chip.proximoEnvioEm !== null && chip.proximoEnvioEm.getTime() >= meiaNoite;
  chip.proximoEnvioEm = null;
  const aberto = abrirDia(chip, !jaAberto && entrada.mandouRecente === true, ritmo, new Date(inicio), sortear);
  if (aberto) Object.assign(chip, aberto);
  resultado.diaRampa = chip.diaRampa;

  for (let t = inicio; t < fim; t += MIN) {
    const agora = new Date(t);
    const desdeUmaHora = t - H;
    const naUltimaHora = resultado.envios.filter((e) => e.getTime() > desdeUmaHora).length;
    const ultimo = resultado.envios.at(-1) ?? null;
    const contagem: Contagem = {
      ultimoEnvioEm: ultimo,
      ultimaNovaEm: ultimo,
      enviosHoje: resultado.envios.length,
      aberturasHoje: resultado.envios.length,
      enviosUltimaHora: naUltimaHora,
      aberturasUltimaHora: naUltimaHora,
    };
    const decisao = podeEnviar("abertura", chip, contagem, ritmo, tetoDiario, agora);
    if (!decisao.ok) {
      if (decisao.motivo.startsWith("teto")) break; // teto do dia batido: o resto do dia não muda nada
      continue;
    }
    resultado.envios.push(agora);
    const depois = aposMensagemNova(chip, ritmo, agora, sortear);
    if (depois.pausou) resultado.pausas.push({ inicio: agora, fim: depois.proximoEnvioEm });
    chip.proximoEnvioEm = depois.proximoEnvioEm;
    chip.enviosDesdePausa = depois.enviosDesdePausa;
    chip.pausaACada = depois.pausaACada;
  }
  return resultado;
}

/**
 * O dia `dia` (qualquer instante dele, no fuso do ritmo) de cada chip, com aberturas até o teto da rampa.
 * `tetoDiario` é o teto externo da organização (`disparo_config.teto_diario`); null = só a rampa.
 */
export function simularDia(ritmo: Ritmo, chips: ChipSimulado[], dia: Date, semente: number, tetoDiario: number | null = null): DiaSimulado {
  // Uma sorte por chip, derivada da semente: acrescentar um chip não muda o dia dos outros.
  const porChip = chips.map((c, i) => simularChip(ritmo, c, dia, sorteador(semente + i * 0x9e3779b1), tetoDiario));
  const todos = porChip.flatMap((c) => c.envios).sort((a, b) => a.getTime() - b.getTime());
  return {
    porChip,
    totalNovas: todos.length,
    primeira: todos[0] ?? null,
    ultima: todos.at(-1) ?? null,
    pausasLongas: porChip.reduce((s, c) => s + c.pausas.length, 0),
  };
}
