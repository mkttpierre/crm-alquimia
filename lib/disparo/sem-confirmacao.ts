/**
 * Chip mudo (E3): o chip que parou de entregar e que a Evolution continua aceitando.
 *
 * A Evolution devolve 2xx com `key.id` mesmo quando o chip não entrega mais nada; o motor gravava `enviado` e seguia
 * mandando (medido em produção: dois chips com ~37 e ~18 envios seguidos sem nenhum ack, 368 mensagens presas em
 * `sent`). A trava de não entregue (`trava-nao-entregue.ts`) não pega isso de propósito: ela olha o lead (1 tique sem
 * entrega) e ignora o ack nulo. Aqui o assunto é o CHIP, e o sinal é justamente a ausência de qualquer ack.
 *
 * Regra: `ENVIOS_SEM_CONFIRMACAO` envios reais seguidos do chip sem NENHUMA confirmação (nem o 1 tique do servidor,
 * nem entrega, nem leitura), o mais antigo deles com pelo menos `MINUTOS_PARA_A_CONFIRMACAO` de vida:
 *   - com `ritmo.saude.ligado`: o chip para pelo freio de saúde que já existe (vermelho + `pausado_ate` por
 *     `vermelhoHoras`). A rampa não é mexida aqui. A retomada é a de sempre (`saude-job.ts`: depois da pausa, com a
 *     sessão conectada, ou pela mão do operador);
 *   - com a saúde desligada na organização, NADA muda sozinho: só o aviso na Central, dizendo que nada foi pausado.
 * Nos dois casos há UM aviso aberto por chip (atualizado no lugar), que fecha sozinho quando um envio feito depois
 * dele é confirmado.
 *
 * Os envios que já derrubaram o chip não o derrubam de novo: com a saúde ligada só contam os envios feitos depois do
 * último aviso deste chip (é o que deixa o operador devolver o chip sem o histórico velho o parar na volta seguinte).
 */
import type { ConfigDisparo } from "./config";
import type { Chip } from "./fila";
import type { RepositorioDisparo } from "./motor";
import { H, MIN } from "./ritmo";

/**
 * Quantos envios seguidos sem confirmação fazem o chip mudo. 8 porque um chip sadio recebe o 1 tique do servidor em
 * segundos: oito seguidos sem nada não é atraso, é chip que não fala mais com o WhatsApp. Abaixo disso, uma queda curta
 * da assinatura `MESSAGES_UPDATE` (o ack não chega ao CRM) pararia chip bom; acima, o chip queima mais leads à toa.
 */
export const ENVIOS_SEM_CONFIRMACAO = 8;

/**
 * Tempo mínimo desde o PRIMEIRO dos envios seguidos sem confirmação. Dá ao ack tempo de chegar (webhook atrasado,
 * reaplicação de ack que chegou antes do espelho): sem isto, oito envios de uma sequência rápida pareceriam mudos.
 */
export const MINUTOS_PARA_A_CONFIRMACAO = 30;

/** Até onde a conta olha para trás. Cobre o fim de semana (o chip mudo da sexta segue mudo na segunda). */
export const JANELA_SEM_CONFIRMACAO_H = 72;

/** Quantos envios a conta lê, no máximo (o necessário para contar a sequência e achar o primeiro dela). */
export const LIMITE_DE_LEITURA = 100;

/** Começo fixo do título do aviso do chip: é por ele que o aviso aberto é achado (um por chip). */
export const PREFIXO_AVISO_CHIP_MUDO = "Disparo: chip sem confirmação de entrega";

/** Um envio real que saiu do chip, com o que a Evolution confirmou dele. */
export type EnvioDoChip = { enviadoEm: Date; ack: number | null; entregueEm: Date | null; lidoEm: Date | null };

/** Algum ack chegou (1 tique do servidor, entrega ou leitura)? `ack = 0` é "pendente": não confirma nada. */
export const confirmado = (e: EnvioDoChip) => (e.ack ?? 0) >= 1 || e.entregueEm !== null || e.lidoEm !== null;

/** Conta, do mais novo para trás, os envios seguidos sem confirmação. `mudo` = a regra acima bateu. */
export function avaliarSemConfirmacao(envios: EnvioDoChip[], agora: Date): { seguidas: number; primeiraEm: Date | null; mudo: boolean } {
  const ordem = [...envios].sort((a, b) => b.enviadoEm.getTime() - a.enviadoEm.getTime());
  let seguidas = 0;
  let primeiraEm: Date | null = null;
  for (const e of ordem) {
    if (confirmado(e)) break;
    seguidas++;
    primeiraEm = e.enviadoEm;
  }
  const mudo = seguidas >= ENVIOS_SEM_CONFIRMACAO && primeiraEm !== null && agora.getTime() - primeiraEm.getTime() >= MINUTOS_PARA_A_CONFIRMACAO * MIN;
  return { seguidas, primeiraEm, mudo };
}

const hora = (d: Date, fusoMinutos: number) => {
  const l = new Date(d.getTime() + fusoMinutos * MIN);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(l.getUTCDate())}/${p(l.getUTCMonth() + 1)} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
};

/**
 * A pausa por chip mudo está ligada? Vale o campo `ritmo.chipMudo.pausa` da organização (desligado por padrão), mas a
 * variável `DISPARO_CHIP_MUDO_PAUSA`, quando definida no servidor, vence o banco: `on` liga, qualquer outro valor
 * desliga. É a trava de emergência de quem já usava a variável antes de o campo existir.
 */
export function pausaPorChipMudoLigada(ritmo: Pick<ConfigDisparo["ritmo"], "chipMudo">): boolean {
  const variavel = (process.env.DISPARO_CHIP_MUDO_PAUSA ?? "").trim().toLowerCase();
  if (variavel) return variavel === "on";
  return ritmo.chipMudo.pausa;
}

/**
 * Roda na volta do chip, depois da saúde e antes de qualquer envio. Texto = o chip parou nesta volta (nada sai);
 * null = segue (inclusive com a saúde desligada, quando só avisa). Repositório sem os métodos novos: não faz nada.
 */
export async function freioDeChipMudo(repo: RepositorioDisparo, config: ConfigDisparo, chip: Chip, agora: Date): Promise<string | null> {
  if (!repo.enviosRecentesDoChip || !repo.avisoVivo || !repo.gravarAvisoVivo) return null;
  const org = config.organizationId;
  // A pausa por chip mudo nasce DESLIGADA: medida contra 14 dias de produção, a regra teria parado 6 chips, dois deles
  // (sem ack por queda do webhook) ainda entregando. Até o dono ver os avisos e mandar ligar, só avisa. Liga com
  // `ritmo.chipMudo.pausa` (tela do motor) ou DISPARO_CHIP_MUDO_PAUSA=on; mesmo ligada, continua valendo só com o
  // freio de saúde da organização ligado.
  const pausa = config.ritmo.saude.ligado && pausaPorChipMudoLigada(config.ritmo);
  const cfg = { ...config.ritmo.saude, ligado: pausa };
  const nome = chip.nome ?? chip.id.slice(0, 8);
  const chave = { prefixo: `${PREFIXO_AVISO_CHIP_MUDO} (${nome})`, chipId: chip.id };
  const { aberto, ultimoEm } = await repo.avisoVivo(org, chave);

  // Com o freio ligado, o que já derrubou o chip (antes do último aviso) não conta de novo.
  const janela = new Date(agora.getTime() - JANELA_SEM_CONFIRMACAO_H * H);
  const desde = cfg.ligado && ultimoEm && ultimoEm > janela ? ultimoEm : janela;
  const envios = await repo.enviosRecentesDoChip(org, chip.id, desde, LIMITE_DE_LEITURA);
  const r = avaliarSemConfirmacao(envios, agora);

  if (!r.mudo) {
    // O chip voltou a entregar: um envio feito DEPOIS do aviso foi confirmado.
    if (aberto && envios.some((e) => confirmado(e) && e.enviadoEm.getTime() >= aberto.criadoEm.getTime())) {
      await repo.gravarAvisoVivo(org, chave, null, agora);
    }
    return null;
  }

  const fuso = config.ritmo.fusoMinutos;
  const quantas = `${r.seguidas}${r.seguidas >= LIMITE_DE_LEITURA ? "+" : ""} mensagens seguidas sem confirmação de entrega`;
  const base = `O chip ${nome} mandou ${quantas} (nem o 1 tique do servidor) desde ${hora(r.primeiraEm!, fuso)}. A Evolution aceitou os envios, mas o WhatsApp não confirmou nenhum: o chip pode estar restrito ou desconectado por dentro. Confira o chip no celular e em Conexões.`;
  if (!cfg.ligado) {
    const titulo = `${chave.prefixo}: ${quantas}; envios não pausados`;
    const corpo = `${base} A pausa automática por chip mudo está desligada (ou o freio de saúde desta organização está desligado), então o motor NÃO pausou o chip: os envios por ele continuam. Pause o chip na tela Disparo se confirmar o problema.`;
    if (!aberto || aberto.titulo !== titulo) await repo.gravarAvisoVivo(org, chave, { titulo, corpo, nivel: "critical" }, agora);
    return null;
  }

  // Freio de saúde de sempre (vermelho + pausa), primeiro: se o aviso falhar, o chip já está parado.
  const motivo = `Chip mudo: ${quantas} desde ${hora(r.primeiraEm!, fuso)}`;
  const patch = { saude: "vermelho" as const, pausadoAte: new Date(agora.getTime() + cfg.vermelhoHoras * H), saudeMotivo: motivo, saudeCalculadaEm: agora };
  await repo.atualizarChip(org, chip.id, patch);
  Object.assign(chip, patch);
  // Um aviso aberto por chip; o novo marca a partir de quando os envios contam de novo.
  if (aberto) await repo.gravarAvisoVivo(org, chave, null, agora);
  await repo.gravarAvisoVivo(org, chave, {
    titulo: `${chave.prefixo}: ${quantas}; envios por ele pausados`,
    corpo: `${base} O motor pausou os envios por este chip por ${cfg.vermelhoHoras} h (saúde vermelha). A volta segue a regra de saúde: depois da pausa, com a conexão de pé, ou quando você devolver o chip na tela Disparo.`,
    nivel: "critical",
  }, agora);
  return `chip mudo: ${quantas}; saúde vermelha, chip parado por ${cfg.vermelhoHoras} h`;
}
