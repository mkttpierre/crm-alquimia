/**
 * A nota de LIGAÇÃO da conversa: regra pura, usada nos dois lados.
 *
 * O servidor (`lib/channels/evolution/ligacoes.ts`) grava a linha `type=system` com
 * `metadata.ligacao` e um corpo em português; a tela (`MessageBubble`) desenha a
 * ligação com rótulo e ícone próprios, a partir do MESMO desfecho e da MESMA hora,
 * passando o rótulo por `t()`. Um só lugar para a regra e para o texto: a tela
 * não pode dizer "perdida" onde o banco disse "recebida".
 *
 * Sem dependência de servidor de propósito: este arquivo entra no bundle do cliente.
 */

export type DesfechoDaLigacao = "recebida" | "perdida" | "feita";

/** Rótulo por desfecho (chave do dicionário; a hora vem depois, fora do `t()`). */
export const ROTULO_DA_LIGACAO: Record<DesfechoDaLigacao, string> = {
  recebida: "Ligação recebida às",
  perdida: "Ligação perdida às",
  feita: "Ligação feita às",
};

/** Estados que encerram a ligação; sem `accept` antes, ninguém atendeu. */
const ESTADOS_DE_FIM = new Set(["reject", "timeout", "terminate"]);

export function desfechoDaLigacao(estados: readonly string[], feita: boolean): DesfechoDaLigacao {
  if (feita) return "feita";
  if (estados.includes("accept")) return "recebida";
  return estados.some((e) => ESTADOS_DE_FIM.has(e)) ? "perdida" : "recebida";
}

/**
 * Só extrai hora e minuto NO FUSO; não traduz nada. O texto "HH:MM" é montado
 * aqui, igual em qualquer idioma — por isso não depende da etiqueta de idioma de
 * quem lê, e os algarismos são sempre latinos.
 */
const PARTES_EM_SAO_PAULO = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

/** HH:MM no fuso de São Paulo — o do negócio, não o do navegador de quem lê. */
export function horaDaLigacao(quando: Date): string {
  const partes = PARTES_EM_SAO_PAULO.formatToParts(quando);
  const de = (tipo: "hour" | "minute") => (partes.find((p) => p.type === tipo)?.value ?? "0").padStart(2, "0");
  return `${de("hour")}:${de("minute")}`;
}

/** "Ligação recebida às 14:05" — o corpo que o servidor grava. */
export function textoDaLigacao(desfecho: DesfechoDaLigacao, quando: Date): string {
  return `${ROTULO_DA_LIGACAO[desfecho]} ${horaDaLigacao(quando)}`;
}

/** A ligação desta linha, ou null se ela não é nota de ligação (ou o metadata não fecha). */
export function ligacaoDaMensagem(m: {
  type?: string | null;
  metadata?: unknown;
}): { desfecho: DesfechoDaLigacao; inicio: Date } | null {
  if (m.type !== "system" || !m.metadata || typeof m.metadata !== "object") return null;
  const l = (m.metadata as Record<string, unknown>).ligacao;
  if (!l || typeof l !== "object") return null;
  const { desfecho, inicio } = l as Record<string, unknown>;
  if (desfecho !== "recebida" && desfecho !== "perdida" && desfecho !== "feita") return null;
  const quando = typeof inicio === "string" ? new Date(inicio) : null;
  if (!quando || Number.isNaN(quando.getTime())) return null;
  return { desfecho, inicio: quando };
}
