/**
 * Pontos de parada e piso de preço do atendimento. Funções PURAS.
 *
 * PONTO DE PARADA (decisão D4): o operador define objetivos que,
 * atingidos, tiram a conversa do automático e a entregam a ele. Quem emite os
 * eventos é a decisão (`venda.ts`, `prospeccao.ts`); aqui só se casa evento/texto
 * com a lista da organização e se monta o aviso. Quem executa (silenciar a
 * conversa, avisar o celular, mover o card, aplicar a tag) é `atendimento.ts`.
 *
 * PISO DE PREÇO (decisão D5): o atendimento NUNCA oferece valor fora da tabela
 * nem fala de desconto. Dinheiro que aparece num texto automático tem de ser o pix
 * ou a parcela de um kit da casa (`kits[*].pixCents` / `parcelaCents`); desconto,
 * cupom e afins são barrados no texto. Pedido de desconto do LEAD não é respondido:
 * para o atendimento e vai para o operador (ver `pedeDesconto` em `../leitura.ts`).
 */
import { normalizar } from "../leitura";
import type { ConfigDeParada, Kit, PontoDeParada } from "./config";
import type { LeadDoAtendimento } from "./estado";

// ---------------------------------------------------------------- pontos --------

/** Os pontos que o evento (ou o texto do lead) aciona, na ordem da configuração. */
export function pontosAcionados(parada: ConfigDeParada, eventos: readonly string[], texto: string): PontoDeParada[] {
  const t = normalizar(texto).replace(/\s+/g, " ").trim();
  return parada.pontos.filter((p) => {
    if (p.evento !== undefined && eventos.includes(p.evento)) return true;
    if (p.padrao === undefined) return false;
    try {
      return new RegExp(p.padrao).test(t);
    } catch {
      return false; // padrão ruim no banco não derruba o atendimento (o seed confere antes de gravar)
    }
  });
}

const trecho = (t: string, n: number) => t.replace(/\s+/g, " ").trim().slice(0, n);

/** WhatsApp do lead para o aviso: só dígitos, com o 55 na frente quando vier sem DDI. */
export function telefoneDoAviso(telefone: string | null): string {
  const d = (telefone ?? "").replace(/\D/g, "");
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

/**
 * O aviso no formato da casa ("Respondeu VALORES / Nome / WhatsApp / Kit / Disse").
 * `{kit}` é o kit detectado ("a definir" quando o lead ainda não disse a quantidade).
 */
export function avisoDoPonto(
  parada: ConfigDeParada,
  ponto: PontoDeParada,
  lead: LeadDoAtendimento,
  texto: string,
  kit: string | null = null,
  /** Campos a mais do aviso (ex.: `{valor}` do Pix do Método). */
  extras: Record<string, string> = {},
): string {
  let aviso = (ponto.aviso ?? parada.aviso);
  for (const [k, v] of Object.entries(extras)) aviso = aviso.replaceAll(`{${k}}`, v);
  return aviso
    .replaceAll("{titulo}", ponto.titulo)
    .replaceAll("{nome}", lead.nome ?? "(sem nome)")
    .replaceAll("{telefone}", telefoneDoAviso(lead.telefone))
    .replaceAll("{kit}", kit ?? "a definir")
    .replaceAll("{disse}", trecho(texto, 200));
}

// ----------------------------------------------------------------- preço --------

/** Valores em dinheiro citados no texto, em centavos: "R$ 897,00", "R$897", "12x 92,77". */
export function valoresDoTexto(texto: string): number[] {
  const cents = (inteiro: string, dec?: string) => Number(inteiro.replace(/\./g, "")) * 100 + (dec ? Number(dec) : 0);
  const achados: number[] = [];
  for (const m of texto.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/g)) achados.push(cents(m[1]!, m[2]));
  for (const m of texto.matchAll(/\b\d{1,2}\s?x\s*(?:de\s*)?(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*),(\d{2})\b/gi)) achados.push(cents(m[1]!, m[2]));
  return achados;
}

/** Valores que a casa pode citar: pix e parcela de cada kit. */
export function valoresDaTabela(kits: readonly Kit[]): Set<number> {
  const v = new Set<number>();
  for (const k of kits) {
    v.add(k.pixCents);
    if (k.parcelaCents !== undefined) v.add(k.parcelaCents);
  }
  return v;
}

const DESCONTO_NO_TEXTO = /descont|cupom|cupon|abatiment|pre[cç]o especial|pre[cç]o de custo|condi[cç][aã]o especial|[uú]ltimo pre[cç]o|pre[cç]o final/i;

/**
 * Por que um texto automático do perfil venda NÃO pode sair, ou null. Sem kits
 * configurados não há tabela para comparar: só a palavra de desconto vale.
 */
export function motivoForaDaTabela(texto: string, kits: readonly Kit[], extras: readonly number[] = []): string | null {
  if (DESCONTO_NO_TEXTO.test(texto)) return "fala de desconto (só o operador negocia)";
  if (!kits.length) return null;
  // `extras`: valores de um produto à parte (o Método), liberados só no contexto dele.
  const permitidos = new Set([...valoresDaTabela(kits), ...extras]);
  const fora = valoresDoTexto(texto).filter((v) => !permitidos.has(v));
  if (!fora.length) return null;
  return `valor fora da tabela: ${fora.map((v) => (v / 100).toFixed(2).replace(".", ",")).join(", ")}`;
}
