import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

/**
 * CPUs do build (`CRM_ALQUIMIA_BUILD_CPUS`, que o Dockerfile define a partir do
 * ARG `BUILD_CPUS`, padrão 2). Sem a variável, o Next decide sozinho, como antes.
 * Na máquina de quem instala, um worker por CPU esgotava a RAM do host.
 * `experimental.cpus` é lido por `getNumberOfWorkers` em
 * `node_modules/next/dist/build/index.js` (Next 16.3.4).
 */
const cpusDoBuild = (() => {
  const n = Number.parseInt(process.env.CRM_ALQUIMIA_BUILD_CPUS ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
})();

/** Performance budget (EPIC-12 §S-12.05):
 *  - LCP < 2.5s p75
 *  - CLS < 0.1 p75
 *  - INP < 200ms p75
 *  - Initial bundle /app/inbox < 250KB gzipped
 */
const nextConfig: NextConfig = {
  // Self-host: gera .next/standalone pro container Docker (node server.js).
  // Na Vercel (VERCEL=1) fica desligado — Next 16.3 + adapter + standalone
  // quebra o onBuildComplete com ENOENT next-server.js.nft.json (#96646).
  output: process.env.VERCEL ? undefined : "standalone",
  /**
   * O `standalone` copia SÓ o que o file tracing detecta — e ele não detecta
   * tudo de `@swc/helpers`.
   *
   * Medido no build da `main`: o pacote real tem 108 arquivos em `esm/`, e o
   * standalone levava **2**. Em runtime o Node pedia
   * `@swc/helpers/esm/_interop_require_default`, não achava, e o container
   * subia em crashloop com `MODULE_NOT_FOUND` — a imagem construía, publicava e
   * só morria ao dar `docker compose up` na VPS.
   *
   * Não aparecia no `next@16.3.0`: aquela versão resolvia o helper pelo CJS. O
   * bump para `16.3.1` passou a resolvê-lo por `exports`/ESM, e o buraco do
   * trace virou falha dura. Como o helper é injetado pelo COMPILADOR (nenhum
   * arquivo nosso o importa), não há import para o trace seguir — a inclusão
   * precisa ser declarada.
   *
   * O glob passa pelo layout do pnpm (`.pnpm/@swc+helpers@<versão>/…`) porque é
   * onde o pacote realmente mora aqui; o `*` cobre o bump de versão seguinte
   * sem exigir que alguém lembre de editar esta linha.
   */
  outputFileTracingIncludes: {
    "/**": ["./node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**"],
  },
  /**
   * Type-check no build. O Dockerfile passa `CRM_ALQUIMIA_BUILD_TYPECHECK=0` (padrão do ARG
   * `BUILD_TYPECHECK`): a imagem que a máquina de quem instala constrói pula a etapa, que sozinha esgotava
   * a RAM. Sem a variável (o `pnpm build` de quem desenvolve, o CI), os tipos são checados.
   */
  typescript: { ignoreBuildErrors: process.env.CRM_ALQUIMIA_BUILD_TYPECHECK === "0" },
  reactStrictMode: true,
  poweredByHeader: false,
  // typedRoutes moved out of experimental in Next 15.5+
  typedRoutes: true,
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react", "lucide-react", "date-fns"],
    // Com `proxy.ts` ativo o Next 16 só bufferiza 10MB do corpo e entrega o
    // resto CORTADO: o upload de vídeo (até MAX_MEDIA_BYTES = 50MB) chegava em
    // `/conversations/[id]/media` truncado, `formData()` falhava e a rota
    // respondia "Campo 'file' (multipart) obrigatório". 60MB = 50MB + slack
    // de multipart (a rota ainda barra acima disso pelo Content-Length).
    proxyClientMaxBodySize: "60mb",
    ...(cpusDoBuild ? { cpus: cpusDoBuild } : {}),
  },
  images: {
    // O app não usa next/image de fato (só <img> raw); desligar o otimizador
    // evita exigir o binário `sharp` no runtime do container.
    unoptimized: true,
    remotePatterns: [
      // Supabase Storage (assinado)
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.supabase.in" },
    ],
  },
  async headers() {
    return [
      {
        source: "/notify-sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // microphone=(self): o gravador de voz do composer (PTT estilo WhatsApp)
          // usa getUserMedia({audio}); microphone=() bloquearia em TODA origem,
          // inclusive a própria — daria "microphone is not allowed in this document".
          // Câmera e geolocalização seguem bloqueadas (não usadas).
          // notifications=(self): bandeja do SO quando a janela está minimizada.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), notifications=(self)",
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "automatik-labs",

  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
