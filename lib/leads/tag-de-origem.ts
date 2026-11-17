import { z } from "zod";

/**
 * TAG DE ORIGEM AUTOMÁTICA — só com origem comprovada.
 *
 * Função pura: recebe o que o lead já carrega e as regras da organização
 * (`organizations.settings.origem`) e devolve as tags a ACRESCENTAR. Nunca
 * remove, nunca repete, nunca inventa: sem prova, `[]`. Sem regra cadastrada,
 * também `[]` — o produto não conhece nome de marca nem de oferta.
 */

export interface RegrasDeOrigem {
  /** Chaves de produto reconhecidas (ex.: o nome curto que a planilha traz). */
  produtos: string[];
  /** `source` do lead → tag a aplicar. */
  por_fonte: Record<string, string>;
}

export const REGRAS_VAZIAS: RegrasDeOrigem = { produtos: [], por_fonte: {} };

// Tolerante: qualquer defeito vira vazio, nunca lança.
const regrasSchema = z.object({
  produtos: z.array(z.string()).catch([]),
  por_fonte: z.record(z.string(), z.string()).catch({}),
});

/** Lê `organizations.settings` e devolve as regras; malformado = vazias. */
export function lerRegrasDeOrigem(settings: unknown): RegrasDeOrigem {
  try {
    if (!settings || typeof settings !== "object") return { produtos: [], por_fonte: {} };
    const bruto = (settings as { origem?: unknown }).origem;
    if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
      return { produtos: [], por_fonte: {} };
    }
    const r = regrasSchema.safeParse(bruto);
    if (!r.success) return { produtos: [], por_fonte: {} };
    return {
      produtos: r.data.produtos.map((p) => p.trim()).filter(Boolean),
      por_fonte: r.data.por_fonte,
    };
  } catch {
    return { produtos: [], por_fonte: {} };
  }
}

export function normalizarOrigem(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function comoBooleano(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const t = normalizarOrigem(v);
  if (t === "true" || t === "sim") return true;
  if (t === "false" || t === "nao") return false;
  return null;
}

export interface LeadParaOrigem {
  source?: string | null;
  custom_fields?: unknown;
  tags?: string[] | null;
}

export function tagsDeOrigem(lead: LeadParaOrigem, regras: RegrasDeOrigem): string[] {
  const produtos = regras.produtos ?? [];
  const porFonte = regras.por_fonte ?? {};
  if (produtos.length === 0 && Object.keys(porFonte).length === 0) return [];

  const existentes = new Set((lead.tags ?? []).map((t) => normalizarOrigem(t)));
  const saida: string[] = [];
  const acrescenta = (tag: string) => {
    const k = normalizarOrigem(tag);
    if (!k || existentes.has(k)) return;
    existentes.add(k);
    saida.push(tag.toUpperCase());
  };
  const produtoDaLista = (texto: string): string | null =>
    produtos.find((p) => normalizarOrigem(p) === normalizarOrigem(texto)) ?? null;

  // 1 · fonte conhecida
  const fonte = lead.source ? porFonte[lead.source] : undefined;
  if (typeof fonte === "string" && fonte.trim()) acrescenta(fonte.trim());

  // 2 · produto de origem + comprou (prova dupla)
  const cf =
    lead.custom_fields && typeof lead.custom_fields === "object" && !Array.isArray(lead.custom_fields)
      ? (lead.custom_fields as Record<string, unknown>)
      : {};
  if (typeof cf.produto_origem === "string") {
    const p = produtoDaLista(cf.produto_origem);
    const comprou = comoBooleano(cf.comprou);
    if (p && comprou !== null) acrescenta(`${comprou ? "COMPROU" : "LEAD"} ${p}`);
  }

  // 3 · tag de pagamento já existente (só em org com produtos cadastrados)
  if (produtos.length > 0) {
    const tags = (lead.tags ?? []).map((t) => normalizarOrigem(t));
    const estornou = tags.some((t) => t === "charge back" || t === "chargeback");
    if (!estornou) {
      for (const t of tags) {
        if (!t.startsWith("pago ")) continue;
        const p = produtoDaLista(t.slice(5));
        if (p) acrescenta(`COMPROU ${p}`);
      }
      // "COMPROU" solto só quando nenhuma compra específica já foi marcada.
      const jaTemCompra = [...existentes].some((t) => t === "comprou" || t.startsWith("comprou "));
      if (tags.includes("pago") && !jaTemCompra) acrescenta("COMPROU");
    }
  }

  return saida;
}

/**
 * Tags de COMPRA a partir dos nomes dos produtos de uma venda registrada.
 * A venda é a prova. Só para organização com `produtos` cadastrados (opt-in).
 * Cada chave contida no nome vira `COMPROU <CHAVE>` (kit com 2 chaves = 2 tags).
 * Nome sem chave NUNCA vira tag com o nome (seria tag genérica, ex.: "Venda
 * online"): gera só `COMPROU`, e só se o lead não tem nenhuma compra marcada.
 */
export function tagsDeCompra(nomes: string[], regras: RegrasDeOrigem, tagsAtuais: string[]): string[] {
  const produtos = regras.produtos ?? [];
  if (produtos.length === 0) return [];
  const existentes = new Set(tagsAtuais.map((t) => normalizarOrigem(t)));
  const saida: string[] = [];
  let semChave = false;
  for (const bruto of nomes) {
    const alvo = normalizarOrigem(bruto ?? "");
    if (!alvo) continue;
    const chaves = produtos.filter((p) => alvo.includes(normalizarOrigem(p)));
    if (chaves.length === 0) semChave = true;
    for (const chave of chaves) {
      const tag = `COMPROU ${chave}`.toUpperCase();
      const k = normalizarOrigem(tag);
      if (existentes.has(k)) continue;
      existentes.add(k);
      saida.push(tag);
    }
  }
  const jaTemCompra = [...existentes].some((t) => t === "comprou" || t.startsWith("comprou "));
  if (semChave && !jaTemCompra) saida.push("COMPROU");
  return saida;
}

/** "Produto comprado" do painel: derivado das tags `COMPROU <P>` (a `COMPROU` solta não nomeia produto). */
export function produtosComprados(tags: string[] | null | undefined): string[] {
  const saida: string[] = [];
  for (const t of tags ?? []) {
    const m = /^comprou\s+(.+)$/i.exec(t.trim());
    if (m && !saida.includes(m[1]!.toUpperCase())) saida.push(m[1]!.toUpperCase());
  }
  return saida;
}
