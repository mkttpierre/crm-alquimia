/**
 * Tipos de envio do follow-up do kit e da oferta do Método (`disparo_envios.tipo`).
 *
 * O follow-up é planejado inteiro quando a lead escreve (`atendimento/metodo.ts`): sete toques e a oferta do
 * Método, todos pendentes. Qualquer resposta dela cancela o que ainda não saiu (a regra do motor), e a
 * próxima mensagem replaneja a partir da nova data. Como o índice único de `disparo_envios` é por
 * (lead, tipo) para a origem `motor`, o tipo leva a data-base do planejamento (AAMMDDHHmmss, UTC).
 *
 *   kit_t<n>_<base>        toque n do follow-up (mensagem nova: janela, vez do chip, ritmo e saúde do motor)
 *   metodo_oferta_<base>   oferta do Método depois do último toque sem retorno (mensagem nova, MAS fala de preço)
 *   metodo_d7 / metodo_d14 depois do pagamento (resposta ao cliente: só o ritmo do chip)
 */
export const TIPO_TOQUE_DO_KIT = /^kit_t([1-9])_\d{12}$/;
export const TIPO_OFERTA_DO_METODO = /^metodo_oferta_\d{12}$/;

/** AAMMDDHHmmss em UTC. */
export function carimboDaBase(base: Date): string {
  return base.toISOString().slice(2, 19).replace(/[-T:]/g, "");
}

export const tipoDoToque = (n: number, base: Date) => `kit_t${n}_${carimboDaBase(base)}`;
export const tipoDaOferta = (base: Date) => `metodo_oferta_${carimboDaBase(base)}`;

export const ehToqueDoKit = (tipo: string) => TIPO_TOQUE_DO_KIT.test(tipo);
export const ehOfertaDoMetodo = (tipo: string) => TIPO_OFERTA_DO_METODO.test(tipo);

/** Mensagem nova do follow-up: entra no ritmo de toque (janela, vez do chip, piso de 10 min). */
export const ehEnvioNovoDoKit = (tipo: string) => ehToqueDoKit(tipo) || ehOfertaDoMetodo(tipo);

/** Número do toque (1 a 9) ou null. */
export const numeroDoToque = (tipo: string): number | null => {
  const m = TIPO_TOQUE_DO_KIT.exec(tipo);
  return m ? Number(m[1]) : null;
};

export const TIPO_POS_PAGAMENTO_DO_METODO = /^metodo_d(7|14)$/;
export const ehPosPagamentoDoMetodo = (tipo: string) => TIPO_POS_PAGAMENTO_DO_METODO.test(tipo);

/** Tudo que o atendimento agenda com dias de antecedência para a lead do kit / do Método (conferido de novo ao enviar). */
export const ehEnvioAgendadoDoKit = (tipo: string) => ehEnvioNovoDoKit(tipo) || ehPosPagamentoDoMetodo(tipo);
