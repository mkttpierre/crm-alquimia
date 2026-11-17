/**
 * A PODA DO ARQUIVO DE WEBHOOKS.
 *
 * ─── O defeito, medido numa instalação real ─────────────────────────────────
 *
 * `webhook_events_log` guarda o corpo cru de todo webhook que entra, e nunca
 * foi podado por ninguém. Em 20/08/2026, no banco do dono deste fork:
 *
 *   banco inteiro ............ 545 MB
 *   webhook_events_log ....... 468 MB   (86%)
 *   api_audit_log ............  27 MB
 *   event_log ................  20 MB
 *   messages .................  3,2 MB
 *
 * As 56.291 linhas eram TODAS dos últimos 20 dias — não havia nenhuma com mais
 * de 30. Ou seja: ~23 MB/dia, ~700 MB/mês, sem teto. O plano gratuito do
 * Supabase acaba em 500 MB, que é onde a maioria dos clones vive, e o dado de
 * negócio inteiro (mensagens, contatos, leads) não chegava a 10 MB.
 *
 * ─── Esvaziar, e não apagar ─────────────────────────────────────────────────
 *
 * Apagar a linha responderia ao espaço e mataria o instrumento. A pergunta que
 * este arquivo existe para responder é a de DEPOIS do incidente — "quantos
 * eventos de que tipo chegaram, quando, e a assinatura conferia?" — e foi ela
 * que decidiu o caso das identidades opacas (`@lid`), contando "76 de 76" no
 * banco.
 *
 * As três colunas pesadas são ~97% do peso; a linha sem elas custa ~200 B.
 * Esvaziando, o índice forense inteiro sobrevive por ~11 MB.
 *
 * ─── Por que em lotes, e por que dois passos ────────────────────────────────
 *
 * Um `update` sem teto sobre 31 mil linhas segura a tabela que TODO webhook
 * escreve — a poda derrubaria a entrada de mensagem, que é o oposto do que ela
 * existe para proteger. O lote pequeno, chamado de 5 em 5 minutos (o crontab
 * do serviço `scheduler`), chega ao
 * mesmo lugar sem nunca ser o dono de uma trava longa.
 *
 * ─── Por que a função SQL (26/10/2026) ──────────────────────────────────────
 *
 * A primeira versão escolhia 500 ids e os mandava no `.in("id", ids)` do
 * PostgREST. Em UUID de 36 caracteres isso passa de 18 KB de URL e o servidor
 * responde "URI too long": a poda falhava a cada 5 minutos, nada era esvaziado,
 * e a tabela chegou a 2,16 GB (97% do banco). Agora o lote inteiro roda dentro
 * do Postgres (`fn_podar_webhook_events_log`, migration 0245) com subselect +
 * LIMIT + `skip locked`, e só os números voltam pela rede.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Quantas linhas cada rodada esvazia. Ver o cabeçalho: lote pequeno é o ponto. */
export const LOTE_PADRAO = 500;

export interface ResultadoDaPoda {
  /** Linhas que perderam o corpo nesta rodada. */
  esvaziadas: number;
  /** Linhas apagadas de vez (velhas demais até para o índice forense). */
  apagadas: number;
  /** `true` quando o lote encheu — ainda há trabalho para a próxima rodada. */
  temMais: boolean;
}

/**
 * Esvazia o corpo das linhas velhas e apaga as velhas demais.
 *
 * Os dois horizontes são independentes de propósito: o primeiro protege o
 * ESPAÇO (o corpo é 97% do peso) e o segundo protege a TABELA de crescer em
 * número de linhas para sempre. Colapsá-los num só forçaria a escolha entre
 * perder o índice forense cedo ou carregar o corpo por meses.
 */
export async function podarArquivoDeWebhooks(
  admin: SupabaseClient,
  opcoes: { diasComCorpo: number; diasParaApagar: number; lote?: number },
): Promise<ResultadoDaPoda> {
  const lote = opcoes.lote ?? LOTE_PADRAO;

  const { data, error } = await admin.rpc("fn_podar_webhook_events_log", {
    p_dias_com_corpo: opcoes.diasComCorpo,
    p_dias_para_apagar: opcoes.diasParaApagar,
    p_lote: lote,
  });

  if (error) {
    logger.warn("[retencao-webhook] a poda em lote falhou", {
      detail: error.message.slice(0, 160),
    });
    return { esvaziadas: 0, apagadas: 0, temMais: false };
  }

  const r = (data ?? {}) as { esvaziadas?: unknown; apagadas?: unknown };
  const esvaziadas = typeof r.esvaziadas === "number" ? r.esvaziadas : 0;
  const apagadas = typeof r.apagadas === "number" ? r.apagadas : 0;

  return {
    esvaziadas,
    apagadas,
    // Lote cheio = ainda há fila (no primeiro dia são milhares atrasadas).
    temMais: esvaziadas >= lote || apagadas >= lote,
  };
}
