# syntax=docker/dockerfile:1
# CRM ALQUIM(IA) — imagem de produção self-host (Next.js standalone).
# Build: docker build --build-arg NEXT_PUBLIC_SUPABASE_URL=... -t crm-alquimia-app .

# ---- deps: instala dependências (layer cacheável) ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build: gera .next/standalone ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# IMAGEM GENÉRICA: os NEXT_PUBLIC_* recebem placeholders no build. Os valores
# REAIS do usuário são injetados em RUNTIME — no browser via <PublicEnvScript/>
# (window.__PUBLIC_ENV__) e no servidor via lib/env.ts (parseia process.env em
# runtime). Assim UMA imagem serve qualquer projeto Supabase, sem rebuild.
# (Segredos de runtime NUNCA entram no build — guarda de fase em lib/env.ts.)
ARG NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key
ARG NEXT_PUBLIC_APP_URL=https://placeholder.invalid
ARG NEXT_PUBLIC_ADMIN_URL=https://placeholder.invalid
# O build do Next é faminto: o heap default do Node (~2GB) estoura. NODE_OPTIONS
# eleva pra 4GB. Nesta versão quem builda é a máquina de quem instala (o
# instalador roda `docker compose build`, uma imagem por vez): o requisito de RAM
# de build vale para ela (README, "Problemas comuns").
# Na instalação local o heap vem do compose (CRM_ALQUIMIA_HEAP_BUILD_MB): numa máquina
# com pouca RAM, ou que já roda outro sistema no mesmo Docker, dá para baixar (2048, com 1 CPU).
ARG NODE_HEAP_MB=4096
# O heap não é o que mais pesa: o Turbopack abre uma thread por CPU (tokio e
# rayon, no Rust) e o Next um worker por CPU, e numa máquina de 12 CPUs a RAM livre do
# host caiu de 2,2 GB para 382 MB em 16 s. BUILD_CPUS (compose: CRM_ALQUIMIA_BUILD_CPUS,
# padrão 2) limita os dois. Mais CPUs = build mais rápido e mais memória.
ARG BUILD_CPUS=2
# Type-check do `next build`: na prova, a etapa "Running TypeScript" levou o host de 3,3 GB
# livres a 1 MB e o build não coube. O código que se instala é o da versão publicada, e quem cobra os tipos
# é o CI (`pnpm typecheck`). Padrão 0: a imagem pula o type-check; 1 liga de novo. O `next build` fora do
# Docker continua checando (a variável só existe aqui). O `next build` do Next 16 não roda o lint.
ARG BUILD_TYPECHECK=0
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_ADMIN_URL=$NEXT_PUBLIC_ADMIN_URL \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB}

# Turbopack (`pnpm build`): ~4min vs ~34min do webpack num VPS. O bloco `webpack:`
# do Sentry (tree-shake + upload de sourcemap em build-time) é ignorado, mas o
# Sentry RUNTIME segue ativo (DSN hardcoded nas configs). Sourcemap upload é
# concern só da Vercel; aqui o ganho de tempo de build é o que importa pro leigo.
RUN TOKIO_WORKER_THREADS=${BUILD_CPUS} RAYON_NUM_THREADS=${BUILD_CPUS} CRM_ALQUIMIA_BUILD_CPUS=${BUILD_CPUS} \
    CRM_ALQUIMIA_BUILD_TYPECHECK=${BUILD_TYPECHECK} \
    pnpm build

# ---- runner: imagem slim de produção ----
FROM node:22-alpine AS runner
WORKDIR /app

# Procedência (doutrina de packaging, invariante 2). O CI já injeta os labels
# OCI via docker/metadata-action; estes aqui são defesa em profundidade — valem
# para qualquer build, inclusive o local do instalador, que não passa pelo
# metadata-action e sem isto sairia sem origem nenhuma.
LABEL org.opencontainers.image.source="https://github.com/mkttpierre/crm-alquimia" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="CRM ALQUIM(IA)"

# A versão que /api/v1/health reporta (invariante 7). Precisa vir por ARG: a
# alternativa anterior era `process.env.npm_package_version`, que é `undefined`
# sob `CMD ["node","server.js"]` — só existe quando o processo nasce de um
# `npm`/`pnpm run`. Toda instalação do mundo reportava o fallback "0.1.0".
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    APP_VERSION=$APP_VERSION
# ffmpeg: a derivação de vídeo (Onda 3.1) roda no processo do app — o cron
# event-log-drain executa o media_derive handler, que chama `ffmpeg` via spawn
# pra extrair áudio+frames. Sem o binário, todo vídeo recebido falha a derivação.
RUN apk add --no-cache ffmpeg
# non-root
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# O output standalone NÃO inclui public/ nem .next/static — copiar explicitamente,
# senão CSS/JS/assets retornam 404 (app "sem estilo").
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
# server.js é o entrypoint gerado pelo output standalone.
CMD ["node", "server.js"]
