#!/usr/bin/env bash
#
# CRM ALQUIM(IA): restauração de um backup (Linux, Mac e Git Bash no Windows).
#
#   bash scripts/restaurar.sh                    # lista os backups e pergunta qual
#   bash scripts/restaurar.sh 2026-11-13-0900    # já escolhe pelo nome
#
# O que faz, nesta ordem: confere o Docker e o Supabase -> mostra os backups -> confere que o escolhido
# está íntegro -> pede para você DIGITAR exatamente RESTAURAR (qualquer outra coisa cancela, sem mexer em
# nada) -> para o app, o worker e o agendador -> faz um backup do estado de AGORA (para você poder voltar)
# -> restaura o banco (numa transação só: se falhar, o banco fica como estava) e os arquivos (os de agora
# são apagados e os do backup copiados no lugar) -> sobe SÓ o app. O worker e o agendador ficam parados até
# você conferir a fila (ela voltou ao momento do backup) e religá-los; a mensagem final diz como.
# Recusa, sem mexer em nada: sem .env.local, backup corrompido, backup de outra versão do CRM ou sem o
# registro de versão (AAAA-MM-DD-HHMM-versao.txt), e quando o backup de segurança falha.
#
# A restauração SUBSTITUI os dados atuais pelos do backup. Restaure na MESMA versão do CRM em que o backup
# foi feito. Numa máquina nova: copie o seu .env.local para a pasta do CRM ANTES de instalar (o instalador
# grava no banco novo a chave de cifra que está nele; instalado antes, o banco ganha uma chave nova e os
# segredos cifrados do backup não abrem), rode bash scripts/instalar.sh e só então restaure.
set -euo pipefail

umask 077
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
# shellcheck source=lib/backup.sh
source scripts/lib/backup.sh

conferir_ambiente_docker || exit 1

# Sem o .env.local não dá para parar o app, o worker e o agendador (o compose precisa dele), e restaurar com
# eles escrevendo no banco mistura dados. Então nem começa.
if [ ! -f .env.local ]; then
  backup_erro "Não achei o .env.local na pasta do CRM. Sem ele eu não consigo parar o app, o worker e o agendador, então não restauro. Nada foi alterado."
  backup_erro "O que fazer: rode este comando na pasta onde o CRM foi instalado; numa máquina nova, copie o seu .env.local antigo para a pasta do CRM ANTES de rodar bash scripts/instalar.sh (senão o banco novo ganha outra chave de cifra e os segredos do backup não abrem) e depois restaure."
  exit 1
fi

# Do mais novo ao mais velho (sem mapfile: o bash 3.2 do macOS não tem).
ASC=()
while IFS= read -r b; do
  if [ -n "$b" ]; then ASC+=("$b"); fi
done < <(listar_backups "$BACKUP_DIR")
BACKUPS=()
i=$((${#ASC[@]} - 1))
while [ "$i" -ge 0 ]; do BACKUPS+=("${ASC[$i]}"); i=$((i - 1)); done
if [ "${#BACKUPS[@]}" -eq 0 ]; then
  backup_erro "Nenhum backup encontrado em $BACKUP_DIR/. Crie um com: bash scripts/backup.sh"
  exit 1
fi

# --- Qual backup ----------------------------------------------------------------------------------
ESCOLHIDO=""
if [ "$#" -ge 1 ]; then
  ESCOLHIDO="${1%.sql.gz}"
  ESCOLHIDO="${ESCOLHIDO##*/}"
  ACHOU=0
  for b in "${BACKUPS[@]}"; do [ "$b" = "$ESCOLHIDO" ] && ACHOU=1; done
  if [ "$ACHOU" -ne 1 ]; then
    backup_erro "Não existe o backup '$ESCOLHIDO' em $BACKUP_DIR/. Rode sem argumentos para ver a lista."
    exit 1
  fi
else
  printf 'Backups disponíveis (do mais novo ao mais velho):\n'
  i=1
  for b in "${BACKUPS[@]}"; do
    printf '  %d) %s\n' "$i" "$b"
    i=$((i + 1))
  done
  printf 'Digite o número do backup que quer restaurar (ou só Enter para cancelar): '
  RESP=""
  # `|| true`: sem quebra de linha no fim o read devolve erro, mas o que foi digitado vale
  IFS= read -r RESP || true
  RESP="${RESP%$'\r'}"
  printf '\n'
  case "$RESP" in
    ''|*[!0-9]*) printf 'Cancelado: nenhuma mudança foi feita.\n'; exit 1 ;;
  esac
  if [ "$RESP" -lt 1 ] || [ "$RESP" -gt "${#BACKUPS[@]}" ]; then
    printf 'Cancelado: o número %s não está na lista. Nenhuma mudança foi feita.\n' "$RESP"
    exit 1
  fi
  ESCOLHIDO="${BACKUPS[$((RESP - 1))]}"
fi

backup_integro "$ESCOLHIDO" "$BACKUP_DIR" || {
  backup_erro "O arquivo $BACKUP_DIR/$ESCOLHIDO.sql.gz está corrompido ou inválido (não é um gzip íntegro). Nada foi alterado. Escolha outro backup."
  exit 1
}
conferir_versao_do_backup "$ESCOLHIDO" "$BACKUP_DIR" || exit 1
avisar_chave_de_cifra_divergente .env.local

# --- Confirmação ----------------------------------------------------------------------------------
printf '\nVocê vai restaurar o backup %s.\n' "$ESCOLHIDO"
printf 'ATENÇÃO: isto SUBSTITUI os dados de agora (contatos, conversas, contas e arquivos) pelos desse backup.\n'
printf 'Antes de começar, eu faço um backup do estado de agora, para você poder voltar.\n'
printf 'Para continuar, digite exatamente RESTAURAR e aperte Enter. Qualquer outra coisa cancela: '
CONFIRMA=""
IFS= read -r CONFIRMA || true
CONFIRMA="${CONFIRMA%$'\r'}"
printf '\n'
if [ "$CONFIRMA" != "RESTAURAR" ]; then
  printf 'Cancelado: nenhuma mudança foi feita.\n'
  exit 1
fi

# --- Para os serviços que escrevem no banco, e garante que voltam --------------------------------------
# FASE=antes: nada mudou ainda; em qualquer saída religa os três. FASE=carga: a carga do banco começou (ou
# terminou); aí só o app volta. A fila de envios voltou ao momento do backup, e religar o worker e o
# agendador sozinho poderia mandar DE NOVO mensagens e follow-ups que já tinham saído.
SERVICOS_PARADOS=0
FASE=antes
RELIGAR_FILA="docker compose -p ${BACKUP_PROJETO} --env-file .env.local start worker scheduler"
aviso_fila_parada() {
  printf '\n'
  printf 'IMPORTANTE: o worker (fila de mensagens e follow-ups) e o agendador ficaram PARADOS de propósito.\n'
  printf 'A fila voltou a ser a do momento do backup: mensagens e follow-ups que estavam pendentes naquela hora\n'
  printf 'podem ser enviados DE NOVO, mesmo que já tenham saído depois do backup.\n'
  printf 'Antes de religar, abra o CRM e confira as mensagens agendadas, as campanhas e os follow-ups pendentes;\n'
  printf 'cancele o que já foi enviado. Depois religue com:\n'
  printf '    %s\n' "$RELIGAR_FILA"
}
religar_servicos() {
  if [ "$SERVICOS_PARADOS" -eq 1 ]; then
    SERVICOS_PARADOS=0
    if [ "$FASE" = "antes" ]; then
      backup_log "Subindo o app, o worker e o agendador de novo (nada foi alterado)"
      compose_crm "$BACKUP_PROJETO" start app worker scheduler >/dev/null \
        || backup_erro "Não consegui subir os serviços sozinho. Rode: bash scripts/instalar.sh"
    else
      backup_log "Subindo só o app"
      compose_crm "$BACKUP_PROJETO" start app >/dev/null \
        || backup_erro "Não consegui subir o app sozinho. Rode: docker compose -p ${BACKUP_PROJETO} --env-file .env.local start app"
      aviso_fila_parada
    fi
  fi
}
# Na saída (inclusive Ctrl+C e kill), a limpeza da lib solta a trava do backup e chama religar_servicos.
BACKUP_AO_SAIR=religar_servicos
instalar_limpeza

backup_log "Parando o app, o worker e o agendador durante a restauração"
SERVICOS_PARADOS=1
compose_crm "$BACKUP_PROJETO" stop app worker scheduler >/dev/null || {
  backup_erro "Não consegui parar o app, o worker e o agendador. Nada foi alterado."
  exit 1
}

# --- Backup do estado de agora (SEM retenção: não pode apagar o que vamos restaurar) ---------------------
backup_log "Fazendo o backup do estado atual (a rede de segurança)"
if ! criar_backup "$BACKUP_DIR"; then
  backup_erro "Sem o backup de segurança do estado atual eu não restauro. Nada foi alterado."
  exit 1
fi
ANTES="$BACKUP_CRIADO"

RC=0
FASE=carga
restaurar_do_backup "$ESCOLHIDO" "$BACKUP_DIR" || RC=$?
if [ "$RC" -eq 1 ]; then
  # a carga falhou e foi desfeita: o banco está como antes, então religa os três
  FASE=antes
  printf '\nA restauração NÃO foi feita; o banco está como antes. O backup do estado de antes continua em %s/%s.sql.gz.\n' "$BACKUP_DIR" "$ANTES" >&2
  exit 1
elif [ "$RC" -ne 0 ]; then
  printf '\nO banco foi restaurado, mas os arquivos (Storage) não. Para desfazer tudo: bash scripts/restaurar.sh %s\n' "$ANTES" >&2
  exit 1
fi

printf '\n'
backup_log "Restauração concluída com o backup $ESCOLHIDO."
# Só quando a chave de cifra do backup (a impressão no registro de versão) não é a desta instalação, ou o
# backup é antigo e não a tem: repetido em toda restauração, o aviso vira ruído.
if chave_do_backup_difere "$ESCOLHIDO"; then
  backup_log "Se este backup veio de OUTRA instalação (outra máquina ou outra pasta) e o .env.local dela não foi copiado para cá ANTES de instalar, os segredos cifrados do backup (webhooks, tokens de integração, credencial do Google) não abrem nesta: confira as integrações e os webhooks e cadastre-os de novo se for preciso."
fi
backup_log "As conexões do WhatsApp não fazem parte do backup: se o número aparecer desconectado, leia o QR de novo."
backup_log "Para VOLTAR ao estado de antes da restauração: bash scripts/restaurar.sh $ANTES   (o backup de antes é $BACKUP_DIR/$ANTES.sql.gz)"
religar_servicos
