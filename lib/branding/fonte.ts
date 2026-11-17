/**
 * A FONTE da organização — o leitor único de `settings.tipografia`.
 *
 * ── Por que NÃO mora em `settings.branding` ──────────────────────────────────
 * `fn_definir_marca_da_organizacao` (migrations 0157/0158) SUBSTITUI o objeto
 * `branding` inteiro a cada "Salvar" da tela de marca, preservando só `logo_path`.
 * Uma chave nova ali seria apagada em silêncio no primeiro save do admin, e a
 * correção exigiria mexer na função (tripla de migration). `settings.tipografia`
 * é irmã de `branding`: a função não a toca, e nenhuma migration é necessária.
 *
 * ── Por que a lista é FECHADA ────────────────────────────────────────────────
 * O valor vira CSS no `<head>`. Só se emite família que o `app/layout.tsx` carrega
 * via `next/font`; qualquer outra coisa cai no padrão do produto. Nunca se
 * interpola texto vindo do banco no CSS.
 *
 * Nunca lança: roda no layout de `/app` inteiro (mesma regra de `organizacao.ts`).
 */

/** Famílias que o layout raiz carrega, e a variável `next/font` de cada uma. */
const FAMILIAS = {
  inter: "--font-inter",
} as const;

export type FamiliaDaOrganizacao = keyof typeof FAMILIAS;

export function familiaDaOrganizacaoDeSettings(settings: unknown): FamiliaDaOrganizacao | null {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  const bloco = (settings as Record<string, unknown>).tipografia;
  if (typeof bloco !== "object" || bloco === null || Array.isArray(bloco)) return null;
  const familia = (bloco as Record<string, unknown>).familia;
  if (typeof familia !== "string") return null;
  const chave = familia.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FAMILIAS, chave) ? (chave as FamiliaDaOrganizacao) : null;
}

const RESERVA = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/**
 * O CSS que troca a fonte sem-serifa SÓ dentro do marcador da organização
 * (`data-marca-org`, ver `app/app/layout.tsx`). `--font-sans` precisa ser
 * redeclarada porque o `@theme` a resolve no `:root` com Atkinson, e `font-sans`
 * lê o valor herdado; `font-family` cobre o que não passa por utilitário.
 * Sem camada (`@layer`): vence o `font-family` do `body` do globals.css.
 */
export function cssDaFonteDaOrganizacao(familia: FamiliaDaOrganizacao | null): string | null {
  if (!familia) return null;
  const variavel = FAMILIAS[familia];
  const pilha = `var(${variavel}), ${RESERVA}`;
  return `body:has([data-marca-org]) {\n  --font-sans: ${pilha};\n  font-family: ${pilha};\n}`;
}
