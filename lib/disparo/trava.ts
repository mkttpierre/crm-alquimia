/**
 * TRAVA DURA do envio real.
 *
 * O motor só chama o canal de verdade quando as DUAS chaves estão viradas:
 *
 *   1. `disparo_config.modo = 'real'` na organização (decisão de quem opera), E
 *   2. `DISPARO_REAL_LIBERADO=sim` no ambiente do servidor (decisão de quem
 *      administra a máquina — não se liga pela tela nem pelo banco).
 *
 * Qualquer outro valor — modo `simulado` (o default), variável ausente, `true`,
 * `1`, `SIM` com espaço — é simulado. Fail-closed: errar para o lado do
 * simulado custa um dia de fila parada; errar para o outro lado manda mensagem
 * pelo chip de alguém, e isso não volta.
 *
 * Terceira trava, OPCIONAL (`DISPARO_SO_PARA`): lista de números E.164 separados
 * por vírgula. Definida, o envio real só sai para esses números; qualquer outro
 * destino é barrado e registrado como `bloqueado_por_allowlist` (sem erro, sem
 * nova tentativa, sem marcar o lead como falho). Não definida (ausente ou só
 * espaços), nada muda. Definida mas sem nenhum número legível, barra TUDO:
 * fail-closed, porque quem escreveu a variável queria restringir.
 *
 * Por que duas chaves e não uma: uma organização já está enviando de verdade pelos chips
 * dele. Enquanto a virada (Fase 7) não acontecer, um `update` errado numa linha
 * do banco não pode bastar para colocar um segundo motor no mesmo chip.
 */
import type { ModoDisparo } from "./config";

export const VARIAVEL_DA_TRAVA = "DISPARO_REAL_LIBERADO";

export function envioRealLiberado(
  config: { modo: ModoDisparo | string },
  ambiente: Record<string, string | undefined>,
): boolean {
  return config.modo === "real" && ambiente[VARIAVEL_DA_TRAVA] === "sim";
}

/** Por que está simulado — vai no resumo do cron e no motivo do envio. */
export function motivoDoSimulado(
  config: { modo: ModoDisparo | string },
  ambiente: Record<string, string | undefined>,
): string | null {
  if (envioRealLiberado(config, ambiente)) return null;
  if (config.modo !== "real") return "modo simulado na organização";
  return `modo real pedido, mas ${VARIAVEL_DA_TRAVA} não está liberado no servidor`;
}

export const VARIAVEL_DA_ALLOWLIST = "DISPARO_SO_PARA";
/** Motivo gravado em `disparo_envios.motivo` quando a allowlist barra o destino. */
export const MOTIVO_ALLOWLIST = "bloqueado_por_allowlist";

/**
 * Chave de comparação de um telefone: só dígitos, com 55 na frente quando vier
 * sem país (10 ou 11 dígitos), e o nono dígito dos celulares brasileiros
 * normalizado para fora (55 + DDD + 9 + 8 dígitos == 55 + DDD + 8 dígitos), já
 * que o canal e o cadastro nem sempre concordam. null = não parece telefone.
 */
export function chaveDoTelefone(bruto: string | null | undefined): string | null {
  let d = String(bruto ?? "").replace(/[^0-9]/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (d.length < 11 || d.length > 15) return null;
  if (d.startsWith("55") && d.length === 13 && d[4] === "9") d = d.slice(0, 4) + d.slice(5);
  return d;
}

/** null = trava não definida (comportamento de sempre). Conjunto vazio = definida e ilegível (barra tudo). */
export function listaPermitida(ambiente: Record<string, string | undefined>): Set<string> | null {
  const bruto = ambiente[VARIAVEL_DA_ALLOWLIST];
  if (bruto === undefined || !bruto.trim()) return null;
  const chaves = bruto
    .split(",")
    .map((n) => chaveDoTelefone(n))
    .filter((c): c is string => c !== null);
  return new Set(chaves);
}

/** Pode o envio real ir para este número? Sem allowlist definida, sempre sim. */
export function destinoPermitido(telefone: string | null | undefined, ambiente: Record<string, string | undefined>): boolean {
  const lista = listaPermitida(ambiente);
  if (lista === null) return true;
  const chave = chaveDoTelefone(telefone);
  return chave !== null && lista.has(chave);
}
