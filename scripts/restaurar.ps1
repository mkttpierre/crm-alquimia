# CRM ALQUIM(IA): restauração de um backup (Windows PowerShell 5.1 ou mais novo).
#
#   powershell -ExecutionPolicy Bypass -File scripts\restaurar.ps1                    # lista e pergunta qual
#   powershell -ExecutionPolicy Bypass -File scripts\restaurar.ps1 2026-11-13-0900    # já escolhe pelo nome
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
# segredos cifrados do backup não abrem), rode scripts\instalar.ps1 e só então restaure.
# Windows PowerShell 5.1: sem encadeamento de comandos, sem ternário, sem coalescência nula.

$ErrorActionPreference = "Continue"
Set-StrictMode -Version 2.0

$Raiz = Split-Path -Parent $PSScriptRoot
Set-Location $Raiz
. (Join-Path $PSScriptRoot "lib\backup.ps1")

# Fase "antes": nada mudou ainda; em qualquer saída religa os três. Fase "carga": a carga do banco começou
# (ou terminou); aí só o app volta. A fila de envios voltou ao momento do backup, e religar o worker e o
# agendador sozinho poderia mandar DE NOVO mensagens e follow-ups que já tinham saído.
$Servicos = $false
$Fase = "antes"
$ReligarFila = "docker compose -p " + $script:BackupProjeto + " --env-file .env.local start worker scheduler"
function Aviso-FilaParada {
    Write-Host ""
    Write-Host "IMPORTANTE: o worker (fila de mensagens e follow-ups) e o agendador ficaram PARADOS de propósito." -ForegroundColor Yellow
    Write-Host "A fila voltou a ser a do momento do backup: mensagens e follow-ups que estavam pendentes naquela hora"
    Write-Host "podem ser enviados DE NOVO, mesmo que já tenham saído depois do backup."
    Write-Host "Antes de religar, abra o CRM e confira as mensagens agendadas, as campanhas e os follow-ups pendentes;"
    Write-Host "cancele o que já foi enviado. Depois religue com:"
    Write-Host ("    " + $script:ReligarFila)
}
function Religar-Servicos {
    if ($script:Servicos) {
        $script:Servicos = $false
        if ($script:Fase -eq "antes") {
            Backup-Log "Subindo o app, o worker e o agendador de novo (nada foi alterado)"
            Compose-Crm $script:BackupProjeto start app worker scheduler | Out-Null
            if ($LASTEXITCODE -ne 0) { Backup-Erro "Não consegui subir os serviços sozinho. Rode: scripts\instalar.ps1" }
        } else {
            Backup-Log "Subindo só o app"
            Compose-Crm $script:BackupProjeto start app | Out-Null
            if ($LASTEXITCODE -ne 0) { Backup-Erro ("Não consegui subir o app sozinho. Rode: docker compose -p " + $script:BackupProjeto + " --env-file .env.local start app") }
            Aviso-FilaParada
        }
    }
}

if (-not (Conferir-AmbienteDocker)) { exit 1 }

# Sem o .env.local não dá para parar o app, o worker e o agendador (o compose precisa dele), e restaurar com
# eles escrevendo no banco mistura dados. Então nem começa.
if (-not (Test-Path -LiteralPath (Join-Path $Raiz ".env.local"))) {
    Backup-Erro "Não achei o .env.local na pasta do CRM. Sem ele eu não consigo parar o app, o worker e o agendador, então não restauro. Nada foi alterado."
    Backup-Erro "O que fazer: rode este comando na pasta onde o CRM foi instalado; numa máquina nova, copie o seu .env.local antigo para a pasta do CRM ANTES de rodar scripts\instalar.ps1 (senão o banco novo ganha outra chave de cifra e os segredos do backup não abrem) e depois restaure."
    exit 1
}

$Pasta = Pasta-DeBackups $Raiz
$Asc = @(Listar-Backups $Pasta)
if ($Asc.Count -eq 0) {
    Backup-Erro "Nenhum backup encontrado em $Pasta. Crie um com: scripts\backup.ps1"
    exit 1
}
$Backups = @()
for ($i = $Asc.Count - 1; $i -ge 0; $i--) { $Backups += $Asc[$i] }   # do mais novo ao mais velho

# --- Qual backup ----------------------------------------------------------------------------------
$Escolhido = ""
if ($args.Count -ge 1) {
    $Escolhido = [System.IO.Path]::GetFileName([string]$args[0])
    if ($Escolhido.EndsWith(".sql.gz")) { $Escolhido = $Escolhido.Substring(0, $Escolhido.Length - 7) }
    if ($Backups -notcontains $Escolhido) {
        Backup-Erro "Não existe o backup '$Escolhido' em $Pasta. Rode sem argumentos para ver a lista."
        exit 1
    }
} else {
    Write-Host "Backups disponíveis (do mais novo ao mais velho):"
    for ($i = 0; $i -lt $Backups.Count; $i++) { Write-Host ("  " + ($i + 1) + ") " + $Backups[$i]) }
    Write-Host "Digite o número do backup que quer restaurar (ou só Enter para cancelar): " -NoNewline
    $Resp = [Console]::In.ReadLine()
    Write-Host ""
    $Numero = 0
    if (($null -eq $Resp) -or (-not [int]::TryParse($Resp.Trim(), [ref]$Numero))) {
        Write-Host "Cancelado: nenhuma mudança foi feita."
        exit 1
    }
    if (($Numero -lt 1) -or ($Numero -gt $Backups.Count)) {
        Write-Host "Cancelado: o número $Numero não está na lista. Nenhuma mudança foi feita."
        exit 1
    }
    $Escolhido = $Backups[$Numero - 1]
}

if (-not (Backup-Integro $Pasta $Escolhido)) {
    Backup-Erro "O arquivo $Pasta\$Escolhido.sql.gz está corrompido ou inválido (não é um gzip íntegro). Nada foi alterado. Escolha outro backup."
    exit 1
}
if (-not (Conferir-VersaoDoBackup $Raiz $Pasta $Escolhido)) { exit 1 }
Avisar-ChaveDeCifraDivergente (Join-Path $Raiz ".env.local")

# --- Confirmação ----------------------------------------------------------------------------------
Write-Host ""
Write-Host "Você vai restaurar o backup $Escolhido."
Write-Host "ATENÇÃO: isto SUBSTITUI os dados de agora (contatos, conversas, contas e arquivos) pelos desse backup."
Write-Host "Antes de começar, eu faço um backup do estado de agora, para você poder voltar."
Write-Host "Para continuar, digite exatamente RESTAURAR e aperte Enter. Qualquer outra coisa cancela: " -NoNewline
$Confirma = [Console]::In.ReadLine()
Write-Host ""
if (($null -eq $Confirma) -or ($Confirma -cne "RESTAURAR")) {
    Write-Host "Cancelado: nenhuma mudança foi feita."
    exit 1
}

# --- Para os serviços que escrevem no banco, e garante que voltam --------------------------------------
# Do stop em diante, TUDO fica dentro do try: o finally roda no exit, num erro terminante e no Ctrl+C
# (o mesmo papel do `trap ... EXIT` do .sh).
try {
    Backup-Log "Parando o app, o worker e o agendador durante a restauração"
    $Servicos = $true
    Compose-Crm $script:BackupProjeto stop app worker scheduler | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Backup-Erro "Não consegui parar o app, o worker e o agendador. Nada foi alterado."
        exit 1
    }

    # --- Backup do estado de agora (SEM retenção: não pode apagar o que vamos restaurar) -----------------
    Backup-Log "Fazendo o backup do estado atual (a rede de segurança)"
    if (-not (Criar-Backup $Pasta $Raiz)) {
        Backup-Erro "Sem o backup de segurança do estado atual eu não restauro. Nada foi alterado."
        exit 1
    }
    $Antes = $script:BackupCriado

    $Fase = "carga"
    $Rc = Restaurar-DoBackup $Raiz $Pasta $Escolhido
    if ($Rc -eq 1) {
        # a carga falhou e foi desfeita: o banco está como antes, então religa os três
        $Fase = "antes"
        Write-Host ""
        Write-Host "A restauração NÃO foi feita; o banco está como antes. O backup do estado de antes continua em $Pasta\$Antes.sql.gz."
        exit 1
    } elseif ($Rc -ne 0) {
        Write-Host ""
        Write-Host "O banco foi restaurado, mas os arquivos (Storage) não. Para desfazer tudo: scripts\restaurar.ps1 $Antes"
        exit 1
    }

    Write-Host ""
    Backup-Log "Restauração concluída com o backup $Escolhido."
    # Só quando a chave de cifra do backup (a impressão no registro de versão) não é a desta instalação, ou o
    # backup é antigo e não a tem: repetido em toda restauração, o aviso vira ruído.
    if (Chave-DoBackupDifere $Pasta $Escolhido) {
        Backup-Log "Se este backup veio de OUTRA instalação (outra máquina ou outra pasta) e o .env.local dela não foi copiado para cá ANTES de instalar, os segredos cifrados do backup (webhooks, tokens de integração, credencial do Google) não abrem nesta: confira as integrações e os webhooks e cadastre-os de novo se for preciso."
    }
    Backup-Log "As conexões do WhatsApp não fazem parte do backup: se o número aparecer desconectado, leia o QR de novo."
    Backup-Log "Para VOLTAR ao estado de antes da restauração: scripts\restaurar.ps1 $Antes   (o backup de antes é $Pasta\$Antes.sql.gz)"
} finally {
    Religar-Servicos
}
exit 0
