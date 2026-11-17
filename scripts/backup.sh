#!/usr/bin/env bash
#
# CRM ALQUIM(IA): backup de UM comando (Linux, Mac e Git Bash no Windows).
#
#   bash scripts/backup.sh
#
# Grava em backups/ (só o seu usuário lê):
#   AAAA-MM-DD-HHMM.sql.gz       os dados do banco (contatos, conversas, contas...)
#   AAAA-MM-DD-HHMM-storage/     os arquivos (mídias, logos, exportações)
#   AAAA-MM-DD-HHMM-versao.txt   a versão do CRM e do schema (a restauração recusa backup de outra versão)
# e guarda só os 14 backups mais novos (apaga os mais velhos; o que acabou de ser criado nunca é apagado).
#
# NÃO entram: as conexões do WhatsApp (depois de restaurar numa máquina nova, leia o QR de novo) e o
# .env.local (tem os segredos, inclusive a chave de cifra do banco: guarde uma cópia sua, num lugar seguro;
# sem ela, numa máquina nova, os segredos de webhook e de integrações gravados no banco ficam ilegíveis). O backup tem dados pessoais dos
# seus contatos: não o deixe em pasta compartilhada nem o envie por e-mail.
#
# O CRM precisa estar no ar (o backup é tirado de dentro dos contêineres do Supabase). Para agendar:
# rode este comando todo dia pelo cron (Linux/Mac) ou pelo Agendador de Tarefas (Windows).
#
# Variáveis opcionais: CRM_ALQUIMIA_BACKUP_DIR (padrão: backups), CRM_ALQUIMIA_STORAGE_DIR (padrão: /mnt,
# onde o contêiner do Storage guarda os arquivos).
set -euo pipefail

# Tudo o que este script cria nasce só para o dono: 600/700.
umask 077
# Git Bash converte argumentos que parecem caminho Unix (`container:/tmp/x`); isto desliga.
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
# shellcheck source=lib/backup.sh
source scripts/lib/backup.sh

conferir_ambiente_docker || exit 1
criar_backup "$BACKUP_DIR" || exit 1
aplicar_retencao "$BACKUP_DIR" "$BACKUP_MANTER" "$BACKUP_CRIADO"

backup_log "Backup pronto: $BACKUP_DIR/$BACKUP_CRIADO.sql.gz (arquivos em $BACKUP_DIR/$BACKUP_CRIADO-storage/)"
backup_log "Guardo os $BACKUP_MANTER mais novos. Para voltar a um deles: bash scripts/restaurar.sh"
