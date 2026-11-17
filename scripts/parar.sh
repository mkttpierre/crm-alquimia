#!/usr/bin/env bash
#
# Para o CRM ALQUIM(IA) sem apagar nada: o banco, os volumes da Evolution (conexões do WhatsApp) e o
# .env.local continuam onde estão. Para subir de novo: bash scripts/instalar.sh
#
#   bash scripts/parar.sh
#
# Só mexe NESTE CRM: o projeto (do Docker e do Supabase) vem do .env.local desta pasta, e todo comando
# leva o nome explícito. Um COMPOSE_PROJECT_NAME ou COMPOSE_FILE de outro sistema na sessão não o desvia.
# Variável opcional: CRM_ALQUIMIA_SUPABASE_CLI (padrão: `npx --yes supabase@<versão testada>`).
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

# shellcheck source=lib/instalar-env.sh
source scripts/lib/instalar-env.sh

log() { printf '==> %s\n' "$*"; }

PROJETO="$(projeto_da_instalacao .env.local)"
SUPABASE="$(supabase_cli)"
# A CLI lê o segredo do JWT desta instalação no config.toml (env(CRM_ALQUIMIA_JWT_SECRET)).
exportar_segredos_da_cli .env.local

if [ -f .env.local ]; then
  log "Parando o CRM, o worker, o agendador e a Evolution (projeto ${PROJETO})"
  # `down` SEM `-v`: os volumes (banco da Evolution e conexões do WhatsApp) ficam.
  compose_crm "$PROJETO" down
else
  log "Sem .env.local: nada do CRM a parar pelo compose"
fi

log "Parando o Supabase local (os dados ficam guardados)"
# SEM `--no-backup` (apaga os volumes do banco) e SEM `--all` (pararia o Supabase de outros sistemas).
if ! $SUPABASE stop --project-id "$PROJETO" --workdir .; then
  # Falhou, não digo que parou.
  printf "ERRO: o 'supabase stop' falhou (a mensagem dele está acima). O Supabase deste CRM pode continuar de pé: confira com 'docker ps' e rode bash scripts/parar.sh de novo.\n" >&2
  exit 1
fi

log "Parado. Para subir de novo: bash scripts/instalar.sh"
