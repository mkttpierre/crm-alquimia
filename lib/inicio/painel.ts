/**
 * Os painéis do Início e a escolha de cada pessoa.
 *
 * Dois painéis prontos: "Atendimento e envios" (o Início de sempre) e "Vendas e faturamento". Só `manager`+ vê o seletor e o
 * painel de vendas — o mesmo papel de Análise → Faturamento; os demais papéis veem o Início de hoje, sem seletor.
 *
 * ─── Como a escolha é lembrada: cookie, lido no servidor ───────────────────
 *
 * O Início é uma página de servidor (`force-dynamic`). Ler o painel escolhido de um COOKIE faz o HTML já nascer com o painel
 * certo: SSR e hidratação enxergam o mesmo, então o elemento não troca depois do primeiro render. `localStorage` só existe no
 * navegador e obrigaria a renderizar um painel e trocar pelo outro depois da hidratação (piscada, ou erro de hidratação).
 * Uma coluna no banco resolveria também, mas pede migration por uma preferência de tela; o cookie não pede.
 *
 * O nome do cookie leva o id da pessoa: quem divide o navegador não herda a escolha do outro. O custo aceito: a escolha vale
 * por aparelho, não acompanha a pessoa entre aparelhos.
 */
import { roleAtLeast } from "@/lib/auth/types";

export const PAINEIS_DO_INICIO = ["atendimento", "vendas"] as const;
export type PainelDoInicio = (typeof PAINEIS_DO_INICIO)[number];

export const PAINEL_PADRAO_DO_INICIO: PainelDoInicio = "atendimento";

/** Um ano. */
export const VALIDADE_DO_COOKIE_DO_PAINEL_S = 60 * 60 * 24 * 365;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O nome do cookie da pessoa. `null` se o id não for um uuid (não monta nome de cookie com texto de fora). */
export function nomeDoCookieDoPainel(userId: string): string | null {
  return UUID.test(userId) ? `inicio_painel_${userId.toLowerCase()}` : null;
}

export function ehPainelDoInicio(valor: unknown): valor is PainelDoInicio {
  return typeof valor === "string" && (PAINEIS_DO_INICIO as readonly string[]).includes(valor);
}

/**
 * Quem vê o seletor e o painel de vendas: `manager`+ (a régua da tela Faturamento e da API `/api/v1/revenue`), ou o
 * administrador da plataforma fora do modo suporte (que na página de Faturamento também passa).
 */
export function podeVerPainelDeVendas(quem: { role: string | null | undefined; isPlatformAdmin: boolean; emSuporte: boolean }): boolean {
  return (quem.isPlatformAdmin && !quem.emSuporte) || roleAtLeast(quem.role, "manager");
}

/**
 * Só o admin da empresa define a meta mensal (o banco confere de novo). A tela segue a Server Action: quem chama passa
 * `escritaBloqueadaPeloSuporte = supportWriteError(user.support) !== null`, a mesma pergunta que `definirMetaMensal` faz.
 * Suporte com acesso total NÃO bloqueia (a ação grava); somente leitura e acompanhamento vencido bloqueiam, mesmo com o
 * papel `admin` que o suporte recebe no vínculo.
 */
export function podeDefinirMeta(quem: { role: string | null | undefined; isPlatformAdmin: boolean; escritaBloqueadaPeloSuporte: boolean }): boolean {
  if (quem.escritaBloqueadaPeloSuporte) return false;
  return quem.isPlatformAdmin || roleAtLeast(quem.role, "admin");
}

/**
 * Qual painel desenhar. Sem permissão, SEMPRE o de atendimento — mesmo com cookie de vendas (cargo rebaixado, cookie
 * velho, cookie forjado). Valor desconhecido também cai no padrão.
 */
export function painelEscolhido(cookie: string | null | undefined, podeVerVendas: boolean): PainelDoInicio {
  if (!podeVerVendas) return PAINEL_PADRAO_DO_INICIO;
  return ehPainelDoInicio(cookie) ? cookie : PAINEL_PADRAO_DO_INICIO;
}
