/**
 * O AGENTE PARA ANTES DE FECHAR A VENDA.
 *
 * Decisão do dono (13/11/2026) para os agentes externos (OpenBot, Claude Code, Codex): eles operam o CRM inteiro, mas
 * nunca registram venda, nunca mandam preço e nunca mandam link de pagamento. Fechar é de uma PESSOA da equipe.
 *
 * Vale para todo token com `actor:ai_agent` no MCP externo (`lib/mcp/server.ts`). NÃO vale para a ponte do agente
 * nativo (`lib/ai/runtime/tools.ts`): aquele é o atendimento configurado pelo dono, com o catálogo e as regras dele.
 *
 * O que é recusado, e por quê:
 *   - `crm_close_demand` com `outcome: "won"` — é registrar a venda (perder com motivo continua livre);
 *   - `crm_create_lead` / `crm_update_lead` com valor do negócio — é pôr preço no negócio;
 *   - `crm_create_lead` numa etapa de GANHO e `crm_move_lead_stage` para uma — é fechar pelo funil;
 *   - `crm_update_stage` com `is_won: true` — marcar uma etapa como de ganho dá por vendidos os negócios que estão nela
 *     (tirar a marca, `is_won: false`, segue a regra da própria ferramenta);
 *   - `crm_send_whatsapp_message` com preço ou pagamento no texto/legenda, ou com mídia (`media_url`) num link de
 *     pagamento;
 *   - `crm_disparo_ajustar_ritmo` com preço ou pagamento em qualquer mensagem do motor (`modelos`), ou que REMOVA
 *     palavra proibida (acrescentar pode; tirar uma trava que o dono pôs, não).
 *
 * `crm_search_products` e `crm_list_contact_orders` não são recusadas: o servidor devolve o resultado SEM os campos de
 * preço e valor (`semPrecos`), e o agente continua sabendo o que existe e o que o cliente já comprou.
 *
 * O detector (`falaDePrecoOuPagamento`) é ESTREITO de propósito (decisão do controlador): só preço com marca
 * de moeda, só os jeitos inequívocos de pagar (chave pix, pix copia e cola, linha digitável, payload EMV do pix) e só
 * links de provedor de pagamento ou com "checkout/pay/pagamento/pague/pagar/boleto" como subdomínio ou primeiro trecho
 * do caminho. "Posso pagar no boleto?", "1,75 m" e pixabay.com passam. A organização acrescenta domínios próprios em
 * `organizations.settings.agentes_externos.dominios_de_pagamento`.
 *
 * A recusa é UMA frase, a mesma em todo caso, e diz o que fazer: criar uma tarefa para alguém da equipe. Ela vira
 * erro da ferramenta, e o erro fica no histórico (`mcp.tool_called` com `success: false` e a frase em `error`).
 * A trava de comissão (`sem-comissao.ts`) e o descarte de grupos continuam valendo por baixo disto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CAMPO_DE_DINHEIRO } from "@/lib/negocio/valor-sigiloso";

export const MENSAGEM_DE_FECHAMENTO_HUMANO = "Fechamento é com uma pessoa da equipe: crie uma tarefa para ela.";

/** Ferramentas que devolvem preço ou valor de venda: o resultado sai sem esses campos para o agente externo. */
export const FERRAMENTAS_DE_PRECO = new Set(["crm_search_products", "crm_list_contact_orders"]);

// ---------------------------------------------------------------------------
// o detector
// ---------------------------------------------------------------------------

const PRECO = [/R\$\s*\d/i, /\b\d+(?:[.,]\d{1,2})?\s*(?:reais|real|BRL)\b/i];

const PAGAMENTO = [/\bchave\s+pix\b/i, /\bpix\s+copia\s+e\s+cola\b/i, /000201[\s\S]*br\.gov\.bcb\.pix/i];

/**
 * Linha digitável de boleto: 47 (bancário) ou 48 (convênio) dígitos, juntos ou com pontos, espaços e hífens.
 *
 * Janela deslizante sobre os GRUPOS de dígitos de cada trecho numérico: "Pedido 1234 34191.79001 …" tem 51 dígitos
 * no trecho, mas uma janela de grupos soma 47 — e é ela que conta. Contar o trecho inteiro deixava um número
 * qualquer na frente esconder o boleto.
 */
function temLinhaDigitavel(texto: string): boolean {
  for (const trecho of texto.match(/\d+(?:[.\s-]\d+)*/g) ?? []) {
    const grupos = trecho.split(/[.\s-]/).map((g) => g.length);
    for (let i = 0; i < grupos.length; i += 1) {
      let soma = 0;
      for (let j = i; j < grupos.length && soma < 48; j += 1) {
        soma += grupos[j]!;
        if (soma === 47 || soma === 48) return true;
      }
    }
  }
  return false;
}

/** Provedores de pagamento: o host é o domínio ou um subdomínio dele. */
export const DOMINIOS_DE_PAGAMENTO = [
  "mercadopago.com",
  "mercadopago.com.br",
  "mpago.la",
  "pag.ae",
  "pagseguro.com.br",
  "pagseguro.uol.com.br",
  "pagbank.com.br",
  "picpay.com",
  "stripe.com",
  "paypal.com",
  "paypal.me",
  "asaas.com",
  "pagar.me",
  "iugu.com",
  "hotmart.com", // cobre pay., checkout. e go. pelo sufixo
  "kiwify.com",
  "kiwify.com.br",
  "kiwify.app",
  "eduzz.com",
  "monetizze.com.br",
  "ton.com.br",
  "sumup.com",
  "sumup.com.br",
  "infinitepay.io",
  "cielo.com.br",
  "getnet.com.br",
  // Plataformas de checkout de infoproduto e gateways comuns no Brasil (a lista só cresce).
  "braip.com",
  "perfectpay.com.br",
  "ticto.com.br",
  "ticto.app",
  "greenn.com.br",
  "cakto.com.br",
  "lastlink.com",
  "yampi.com.br",
  "appmax.com.br",
  "vindi.com.br",
  "efipay.com.br",
  "gerencianet.com.br",
  "abacatepay.com",
  "digitalmanager.guru",
  "ebanx.com",
] as const;

const TRECHOS_DE_PAGAMENTO = new Set(["checkout", "pay", "pagamento", "pague", "pagar", "boleto"]);

const ehDoDominio = (host: string, dominio: string) => host === dominio || host.endsWith(`.${dominio}`);

/** O link leva a pagamento? `dominiosExtras` são os da organização. */
export function linkDePagamento(url: string, dominiosExtras: readonly string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const dominios = [...DOMINIOS_DE_PAGAMENTO, ...dominiosExtras.map((d) => d.toLowerCase().trim()).filter(Boolean)];
  if (dominios.some((d) => ehDoDominio(host, d))) return true;
  const rotulos = host.split(".");
  if (rotulos.length > 2 && TRECHOS_DE_PAGAMENTO.has(rotulos[0]!)) return true;
  const cru = u.pathname.split("/").filter(Boolean)[0] ?? "";
  let primeiroTrecho: string;
  try {
    primeiroTrecho = decodeURIComponent(cru).toLowerCase();
  } catch {
    // Percent malformado ("%E0%A4%A"): não lança; o trecho não decide nada (o host já foi olhado acima).
    return false;
  }
  return TRECHOS_DE_PAGAMENTO.has(primeiroTrecho);
}

const URLS = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+/gi;

/**
 * Endereço SEM esquema nem "www" ("mpago.la/abc", "nubank.com.br/pagar"): rótulos com ponto terminando num TLD de
 * letras, opcionalmente com caminho. Não pega "1,75 m", "obs.: ok" nem e-mail (o "@" antes impede).
 */
const ENDERECOS_SEM_ESQUEMA = /(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>"'()]*)?/gi;

/** O texto fala preço, mostra um jeito de pagar ou leva link de pagamento? */
export function falaDePrecoOuPagamento(texto: string, dominiosExtras: readonly string[] = []): boolean {
  if (PRECO.some((r) => r.test(texto))) return true;
  if (PAGAMENTO.some((r) => r.test(texto))) return true;
  if (temLinhaDigitavel(texto)) return true;
  const limpa = (url: string) => url.replace(/[.,;:!?]+$/, "");
  if ((texto.match(URLS) ?? []).some((url) => linkDePagamento(limpa(url), dominiosExtras))) return true;
  const semUrls = texto.replace(URLS, " ");
  return (semUrls.match(ENDERECOS_SEM_ESQUEMA) ?? []).some((end) => linkDePagamento(limpa(end), dominiosExtras));
}

// ---------------------------------------------------------------------------
// a recusa
// ---------------------------------------------------------------------------

/** Todos os textos dentro de um valor (as mensagens do motor são `{ tipo: string[] }`). */
function textosDentro(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(textosDentro);
  if (v && typeof v === "object") return Object.values(v).flatMap(textosDentro);
  return [];
}

async function dominiosDaOrganizacao(supabase: SupabaseClient, organizationId: string): Promise<string[]> {
  const { data } = await supabase.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  const bloco = ((data as { settings?: Record<string, unknown> } | null)?.settings?.agentes_externos ?? null) as
    | Record<string, unknown>
    | null;
  const lista = bloco?.dominios_de_pagamento;
  return Array.isArray(lista) ? lista.filter((d): d is string => typeof d === "string") : [];
}

async function etapaDeGanho(supabase: SupabaseClient, organizationId: string, etapa: unknown): Promise<boolean> {
  if (typeof etapa !== "string") return false;
  const { data, error } = await supabase
    .from("crm_stages")
    .select("is_won")
    .eq("organization_id", organizationId)
    .eq("id", etapa)
    .maybeSingle();
  // Erro de leitura FECHA: não dá para saber se a etapa é de ganho, e o custo de errar é uma venda sem pessoa.
  if (error) return true;
  return (data as { is_won?: boolean } | null)?.is_won === true;
}

/**
 * A recusa para um agente externo, ou `null` quando a chamada pode seguir. Só lê (etapa de destino, domínios da
 * organização, palavras proibidas gravadas), nunca escreve.
 */
export async function recusaDeFechamento(
  ferramenta: string,
  argumentos: Record<string, unknown>,
  contexto: { supabase: SupabaseClient; organizationId: string },
): Promise<string | null> {
  const { supabase, organizationId } = contexto;
  const recusa = MENSAGEM_DE_FECHAMENTO_HUMANO;

  if (ferramenta === "crm_close_demand" && argumentos.outcome === "won") return recusa;

  if (ferramenta === "crm_create_lead" || ferramenta === "crm_update_lead") {
    if (Object.keys(argumentos).some((k) => CAMPO_DE_DINHEIRO.test(k) && argumentos[k] !== undefined)) {
      return recusa;
    }
    if (ferramenta === "crm_create_lead" && (await etapaDeGanho(supabase, organizationId, argumentos.stage_id))) return recusa;
  }

  if (ferramenta === "crm_move_lead_stage" && (await etapaDeGanho(supabase, organizationId, argumentos.to_stage_id))) {
    return recusa;
  }

  if (ferramenta === "crm_update_stage" && argumentos.is_won === true) return recusa;

  if (ferramenta === "crm_send_whatsapp_message") {
    const textos = textosDentro(argumentos.body);
    const midia = typeof argumentos.media_url === "string" ? argumentos.media_url : null;
    if (textos.length === 0 && !midia) return null;
    const extras = await dominiosDaOrganizacao(supabase, organizationId);
    if (textos.some((t) => falaDePrecoOuPagamento(t, extras))) return recusa;
    if (midia && linkDePagamento(midia, extras)) return recusa;
  }

  if (ferramenta === "crm_disparo_ajustar_ritmo") {
    const textos = textosDentro(argumentos.modelos);
    if (textos.length > 0) {
      const extras = await dominiosDaOrganizacao(supabase, organizationId);
      if (textos.some((t) => falaDePrecoOuPagamento(t, extras))) return recusa;
    }
    if (argumentos.proibidos !== undefined) {
      // Acrescentar palavra proibida pode; tirar uma (ou trocar o padrão) não: é desligar uma trava que o dono pôs.
      const { data } = await supabase.from("disparo_config").select("proibidos").eq("organization_id", organizationId).maybeSingle();
      // A regra gravada tem de continuar IGUAL: o mesmo padrão, o mesmo motivo e o mesmo `excetoUltimo` (ligar
      // `excetoUltimo` numa regra que já existe também é enfraquecer a trava).
      type Regra = { padrao?: unknown; motivo?: unknown; excetoUltimo?: unknown };
      const chave = (r: Regra | null | undefined) =>
        JSON.stringify([r?.padrao ?? null, r?.motivo ?? null, r?.excetoUltimo === true]);
      const gravados = ((data as { proibidos?: unknown } | null)?.proibidos ?? []) as Regra[];
      const novos = new Set((Array.isArray(argumentos.proibidos) ? (argumentos.proibidos as Regra[]) : []).map(chave));
      if (Array.isArray(gravados) && gravados.some((r) => !novos.has(chave(r)))) return MENSAGEM_PROIBIDO_NAO_SAI;
    }
  }

  return null;
}

/** Recusa de quem tenta tirar uma palavra proibida do motor pelo MCP. */
export const MENSAGEM_PROIBIDO_NAO_SAI =
  "Palavra proibida só sai pela tela, com uma pessoa da equipe. Pelo agente, só dá para acrescentar.";

// ---------------------------------------------------------------------------
// o resultado sem preço
// ---------------------------------------------------------------------------

function ehObjetoSimples(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Tira, em qualquer profundidade, todo campo de dinheiro (preço, valor, total, desconto em centavos…). */
export function semPrecos<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map((v) => semPrecos(v)) as unknown as T;
  if (!ehObjetoSimples(valor)) return valor;
  const saida: Record<string, unknown> = {};
  for (const [chave, v] of Object.entries(valor)) {
    if (CAMPO_DE_DINHEIRO.test(chave)) continue;
    saida[chave] = semPrecos(v);
  }
  return saida as T;
}
