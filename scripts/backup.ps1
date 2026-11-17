# CRM ALQUIM(IA): backup de UM comando (Windows PowerShell 5.1 ou mais novo).
#
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
#
# Grava em backups\ (só o seu usuário acessa):
#   AAAA-MM-DD-HHMM.sql.gz       os dados do banco (contatos, conversas, contas...)
#   AAAA-MM-DD-HHMM-storage\     os arquivos (mídias, logos, exportações)
#   AAAA-MM-DD-HHMM-versao.txt   a versão do CRM e do schema (a restauração recusa backup de outra versão)
# e guarda só os 14 backups mais novos (apaga os mais velhos; o que acabou de ser criado nunca é apagado).
#
# NÃO entram: as conexões do WhatsApp (depois de restaurar numa máquina nova, leia o QR de novo) e o
# .env.local (tem os segredos, inclusive a chave de cifra do banco: guarde uma cópia sua, num lugar seguro;
# sem ela, numa máquina nova, os segredos de webhook e de integrações gravados no banco ficam ilegíveis). O backup tem dados pessoais dos
# seus contatos: não o deixe em pasta compartilhada nem o envie por e-mail.
#
# O CRM precisa estar no ar (o backup é tirado de dentro dos contêineres do Supabase). Para agendar, use
# o Agendador de Tarefas do Windows chamando este comando.
#
# Variáveis opcionais: CRM_ALQUIMIA_BACKUP_DIR (padrão: backups), CRM_ALQUIMIA_STORAGE_DIR (padrão: /mnt).
# Windows PowerShell 5.1: sem encadeamento de comandos, sem ternário, sem coalescência nula.

$ErrorActionPreference = "Continue"
Set-StrictMode -Version 2.0

$Raiz = Split-Path -Parent $PSScriptRoot
Set-Location $Raiz
. (Join-Path $PSScriptRoot "lib\backup.ps1")

if (-not (Conferir-AmbienteDocker)) { exit 1 }

$Pasta = Pasta-DeBackups $Raiz
if (-not (Criar-Backup $Pasta $Raiz)) { exit 1 }
Aplicar-Retencao $Pasta $script:BackupManter $script:BackupCriado

Backup-Log ("Backup pronto: " + $Pasta + "\" + $script:BackupCriado + ".sql.gz (arquivos em " + $Pasta + "\" + $script:BackupCriado + "-storage\)")
Backup-Log ("Guardo os " + $script:BackupManter + " mais novos. Para voltar a um deles: scripts\restaurar.ps1")
exit 0
