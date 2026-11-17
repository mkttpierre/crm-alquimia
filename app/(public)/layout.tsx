import type { CSSProperties } from "react";
import { Syne } from "next/font/google";

import { marcaDeSaidaFoiConfigurada } from "@/lib/branding/resolve";
import { marcaDaSaida } from "@/lib/branding/saida";
import { SOL_GRANDE_DO_PRODUTO } from "@/lib/branding/sol-grande-do-produto";
import { createClient } from "@/lib/supabase/server";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * A casca das telas de acesso — login, cadastro, recuperação, MFA.
 *
 * ── Fachada preto e branco (16/11/2026) ─────────────────────
 *
 * Painel dividido: à esquerda o sol do produto girando devagar e a escrita
 * "CRM ALQUIM(IA)"; à direita o formulário. No celular o painel vira um
 * cabeçalho compacto em cima do formulário. Tudo em preto e branco, como a
 * barra lateral: a cor de destaque da instalação (o verde de fábrica, por exemplo) é
 * trocada por branco SÓ dentro desta casca, redefinindo os tokens de accent no
 * contêiner (`TOKENS_PRETO_E_BRANCO`) — os utilitários do Tailwind 4 leem
 * `var(--color-accent*)` no ponto de uso, então o botão das seis telas fica
 * branco sem tocar em `components/ui`.
 *
 * O sol vem de `lib/branding/sol-grande-do-produto.ts` (384 px, embutido no código):
 * a versão de `arte-do-produto.ts` tem 128 px e borraria no tamanho do painel, e
 * a doutrina de marca própria proíbe imagem estática em `public/` (a imagem Docker
 * é uma só para todas as marcas).
 *
 * ── Marca própria (o que a versão aberta acrescenta) ──────────────────────────
 *
 * O sol e a escrita do produto (o nome sem o "CRM" de cima) são a marca do PRODUTO e só aparecem quando a
 * instalação não definiu marca (`marcaDeSaidaFoiConfigurada`, pelas origens —
 * nunca comparando o nome com uma constante). Com marca própria, o painel mostra
 * só o NOME dela em texto, sem sol e sem imagem; o logo configurado continua no
 * topo do formulário (`logo-da-fachada`).
 *
 * ── Por que o LOGO mora aqui, e não em `login/page.tsx` ───────────────────────
 *
 * São seis telas no grupo `(public)`, e todas são "antes de entrar": quem instala
 * o produto para clientes mostra a marca dele exatamente aí. Um `<img>` por
 * página seriam seis cópias que divergem na primeira vez que alguém mexer numa
 * só — e a que ficaria para trás é sempre a que ninguém abre (recuperação de
 * senha, cadastro de MFA), que é justamente onde o cliente do revendedor
 * aparece sozinho e sem contexto. Com logo próprio configurado, ele aparece no
 * topo do formulário (`logo-da-fachada`), acima do padrão do produto.
 *
 * ── Por que `marcaDaSaida(null)` ──────────────────────────────────────────────
 *
 * Aqui não existe organização resolvida: `null` é a declaração disso, e a pilha
 * resultante é a mesma do layout raiz (banco acima, `.env` embaixo). Montar a
 * pilha à mão nesta tela faria a fachada anunciar uma precedência que o resto do
 * produto não usa. E `marcaDaSaida` NUNCA lança (ver o cabeçalho dela): uma cor
 * ou um logo mal gravados não podem derrubar a única tela por onde se entra para
 * corrigi-los.
 *
 * O NOME continua saindo de `branding()` dentro de cada página — não é descuido,
 * está medido em `tests/e2e/icone-da-marca.spec.ts:64-77`: aquela spec cruza duas
 * resoluções independentes (o título da aba, que lê o banco, contra o texto sob
 * o "Entrar", que lê o `.env`). Trocar o texto para este mesmo resolvedor
 * deixaria a spec verde medindo nada.
 */

const display = Syne({
  subsets: ["latin", "latin-ext"],
  weight: ["700", "800"],
  display: "swap",
  variable: "--font-fachada-display",
});

const TOKENS_PRETO_E_BRANCO = {
  "--color-bg": "#050505",
  "--color-text": "#f4f4f4",
  "--color-text-muted": "#8f8f8f",
  "--color-border": "rgba(255,255,255,0.12)",
  "--color-border-strong": "rgba(255,255,255,0.28)",
  "--color-accent": "#f4f4f4",
  "--color-accent-hover": "#d6d6d6",
  "--color-accent-500": "#ffffff",
  "--color-accent-600": "#e5e5e5",
  "--color-accent-soft": "rgba(255,255,255,0.08)",
  "--color-accent-fg": "#050505",
  "--primary": "#f4f4f4",
  "--primary-foreground": "#050505",
  "--ring": "#ffffff",
  colorScheme: "dark",
} as CSSProperties;

// Grão de filme em SVG (feTurbulence), sem arquivo novo em `public/`.
const GRAO =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(%23g)'/></svg>\")";

const CSS_DA_FACHADA = `
@keyframes fachada-giro { to { transform: rotate(360deg); } }
@keyframes fachada-giro-inverso { to { transform: rotate(-360deg); } }
@keyframes fachada-surgir {
  from { opacity: 0; transform: translateY(18px); filter: blur(6px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes fachada-sol-entra {
  from { opacity: 0; transform: scale(0.86); }
  to { opacity: 1; transform: none; }
}
@keyframes fachada-pulso {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50% { opacity: 0.85; transform: scale(1.06); }
}
.fachada-giro { animation: fachada-giro 140s linear infinite; }
.fachada-giro-inverso { animation: fachada-giro-inverso 90s linear infinite; }
.fachada-sol-entra { animation: fachada-sol-entra 1.4s cubic-bezier(.16,1,.3,1) both; }
.fachada-pulso { animation: fachada-pulso 7s ease-in-out infinite; }
.fachada-surgir { animation: fachada-surgir 0.9s cubic-bezier(.16,1,.3,1) both; }
.fachada-atraso-1 { animation-delay: .15s; }
.fachada-atraso-2 { animation-delay: .3s; }
.fachada-atraso-3 { animation-delay: .45s; }
.fachada-atraso-4 { animation-delay: .6s; }
[data-fachada] input:-webkit-autofill,
[data-fachada] input:-webkit-autofill:hover,
[data-fachada] input:-webkit-autofill:focus {
  -webkit-box-shadow: 0 0 0 1000px #0b0b0b inset;
  -webkit-text-fill-color: #f4f4f4;
  caret-color: #ffffff;
}
@media (prefers-reduced-motion: reduce) {
  .fachada-giro, .fachada-giro-inverso, .fachada-pulso { animation: none; }
  .fachada-surgir, .fachada-sol-entra { animation-duration: 1ms; }
}
`;

function Sol({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={SOL_GRANDE_DO_PRODUTO}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  );
}

/**
 * A escrita do painel. SÓ com marca própria: o nome dela, em texto. A marca do produto não leva escrita
 * (o logotipo "ALQUIM(IA)" saiu da tela de login a pedido do dono, 17/11/2026): fica o sol.
 */
function Escrita({ tamanho, nome }: { tamanho: "grande" | "compacta"; nome: string }) {
  const grande = tamanho === "grande";
  return (
    <div className="select-none">
      <span
        className={
          grande
            ? "fachada-surgir fachada-atraso-3 block break-words font-[family-name:var(--font-fachada-display)] font-extrabold leading-[0.9] tracking-[-0.04em] text-white"
            : "block break-words font-[family-name:var(--font-fachada-display)] font-extrabold leading-none tracking-[-0.03em] text-white"
        }
        style={{ fontSize: grande ? "clamp(2.2rem, 4vw, 4.5rem)" : "1.5rem" }}
      >
        {nome}
      </span>
    </div>
  );
}

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const marca = await marcaDaSaida(null);
  // O sol e a escrita do produto são a marca do PRODUTO: só aparecem quando
  // ninguém configurou marca (mesma pergunta da barra lateral, pelas origens).
  const marcaPropria = marcaDeSaidaFoiConfigurada(marca);
  // A maioria destas telas roda ANTES do login (não há usuário nenhum), mas
  // duas — `/login/mfa` e, em parte, `/login/recovery` — rodam com uma sessão
  // parcial já criada (primeiro fator verificado, segundo pendente). Onde há
  // sessão, o idioma salvo no perfil vale; sem ela, `IdiomaProvider` já cai no
  // padrão pt-BR sozinho (ver o cabeçalho do provider) — nunca lança.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const locale = (user?.user_metadata?.locale as string | undefined) ?? null;
  const idioma = normalizarIdioma(locale);
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <IdiomaProvider locale={locale}>
      <style dangerouslySetInnerHTML={{ __html: CSS_DA_FACHADA }} />
      <div
        data-fachada="preto-e-branco"
        style={TOKENS_PRETO_E_BRANCO}
        className={`${display.variable} relative isolate min-h-screen overflow-hidden bg-[#050505] text-[#f4f4f4] lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(26rem,1fr)]`}
      >
        {/* Grão por cima de tudo, sem pegar clique. */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 opacity-[0.07] mix-blend-screen"
          style={{ backgroundImage: GRAO }}
        />

        {/* ── Painel da marca (computador) ─────────────────────────────── */}
        <aside className="relative hidden min-h-screen flex-col justify-between overflow-hidden border-r border-white/[0.07] px-12 py-10 lg:flex xl:px-16">
          {/* grade fina de fundo */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 opacity-[0.35]"
            style={{
              backgroundImage:
                "linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.045) 1px, transparent 1px)",
              backgroundSize: "72px 72px",
              maskImage: "radial-gradient(ellipse 70% 60% at 50% 45%, #000 30%, transparent 75%)",
              WebkitMaskImage:
                "radial-gradient(ellipse 70% 60% at 50% 45%, #000 30%, transparent 75%)",
            }}
          />

          <div className="fachada-surgir flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.32em] text-white/45">
            <span className="flex items-center gap-3">
              <span className="inline-block size-1.5 rounded-full bg-white" />
              {t("Acesso")}
            </span>
            <span>{t("Área restrita")}</span>
          </div>

          {/* sol central com anéis (só a marca do produto) */}
          {!marcaPropria && (
          <div data-marca="produto" className="pointer-events-none absolute left-1/2 top-[44%] -z-10 aspect-square w-[min(68vh,44vw)] -translate-x-1/2 -translate-y-1/2">
            <div className="fachada-pulso absolute inset-[18%] rounded-full bg-white/[0.07] blur-3xl" />
            <div className="absolute inset-0 rounded-full border border-white/[0.06]" />
            <div className="fachada-giro-inverso absolute inset-[6%] rounded-full border border-dashed border-white/[0.09]" />
            <div className="absolute inset-[-12%] rounded-full border border-white/[0.035]" />
            <div className="fachada-sol-entra absolute inset-[13%]">
              <Sol className="fachada-giro size-full object-contain opacity-95" />
            </div>
          </div>
          )}

          <div className="flex items-end">
            {marcaPropria && <Escrita tamanho="grande" nome={marca.nome} />}
          </div>
        </aside>

        {/* ── Formulário ───────────────────────────────────────────────── */}
        <main className="relative flex min-h-screen flex-col px-6 py-8 sm:px-10 lg:px-14">
          {/* cabeçalho compacto (celular e tablet) */}
          <header className="fachada-surgir flex items-center gap-4 lg:hidden">
            {!marcaPropria && (
              <div className="relative size-16 shrink-0">
                <div className="absolute inset-0 rounded-full bg-white/[0.08] blur-xl" />
                <Sol className="fachada-giro relative size-full object-contain" />
              </div>
            )}
            {marcaPropria && <Escrita tamanho="compacta" nome={marca.nome} />}
          </header>

          <div className="flex flex-1 items-center justify-center py-10">
            <div className="fachada-surgir fachada-atraso-1 w-full max-w-sm space-y-8">
              {marca.logoUrl && (
                <div className="flex justify-start">
                  {/*
                    <img> em vez de next/image pelo mesmo motivo da barra lateral: a URL
                    é de quem hospeda e o `next/image` exige allowlist de domínios
                    fechada em BUILD — a imagem pré-buildada do self-host recusaria o
                    domínio do operador. Altura fixa e largura livre para não distorcer
                    arte de proporção desconhecida.

                    O `alt` é o nome DESTA resolução (`marca.nome`), e não o de
                    `branding()`: é a legenda da imagem que está ali, e nomeá-la com a
                    marca de outra fonte descreveria uma marca que não é a do logo.

                    O `data-testid` é lido por `tests/e2e/marca-logo.spec.ts`, que prova
                    que o logo da EMPRESA não vaza para cá. Sem ele a spec caía na
                    "primeira <img> da página", e uma asserção de negação com seletor
                    largo passa sozinha assim que outra imagem entra na tela.
                  */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    data-testid="logo-da-fachada"
                    src={marca.logoUrl}
                    alt={marca.nome}
                    className="h-10 w-auto max-w-[12rem] object-contain"
                  />
                </div>
              )}
              {children}
            </div>
          </div>

          <footer className="flex items-center justify-end font-mono text-[10px] uppercase tracking-[0.3em] text-white/30">
            <span>{new Date().getFullYear()}</span>
          </footer>
        </main>
      </div>
    </IdiomaProvider>
  );
}
