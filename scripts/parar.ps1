# Para o CRM ALQUIM(IA) sem apagar nada: o banco, os volumes da Evolution (conexões do WhatsApp) e o
# .env.local continuam onde estão. Para subir de novo: scripts\instalar.ps1
#
#   powershell -ExecutionPolicy Bypass -File scripts\parar.ps1
#
# Só mexe NESTE CRM: o projeto (do Docker e do Supabase) vem do .env.local desta pasta, e todo comando
# leva o nome explícito. Um COMPOSE_PROJECT_NAME ou COMPOSE_FILE de outro sistema na sessão não o desvia.
# Variável opcional: CRM_ALQUIMIA_SUPABASE_CLI (padrão: `npx --yes supabase@<versão testada>`).
# Windows PowerShell 5.1: sem encadeamento de comandos nem operador ternário; comandos nativos escrevem
# progresso no stderr, então o sucesso é conferido por $LASTEXITCODE.

$ErrorActionPreference = "Continue"
$Raiz = Split-Path -Parent $PSScriptRoot
Set-Location $Raiz
. (Join-Path $PSScriptRoot "lib\instalar-env.ps1")

function Log([string]$msg) { Write-Host "==> $msg" }

$Projeto = Projeto-DaInstalacao (Join-Path $Raiz ".env.local")
try { $Cli = Supabase-Cli } catch { Write-Host ("ERRO: " + $_.Exception.Message) -ForegroundColor Red; exit 1 }
$CliExe = $Cli[0]
$CliArgs = @()
if ($Cli.Length -gt 1) { $CliArgs = $Cli[1..($Cli.Length - 1)] }
# A CLI lê o segredo do JWT desta instalação no config.toml (env(CRM_ALQUIMIA_JWT_SECRET)).
Exportar-SegredosDaCli (Join-Path $Raiz ".env.local")

if (Test-Path ".env.local") {
    Log "Parando o CRM, o worker, o agendador e a Evolution (projeto $Projeto)"
    # `down` SEM `-v`: os volumes (banco da Evolution e conexões do WhatsApp) ficam.
    Compose-Crm $Projeto down
} else {
    Log "Sem .env.local: nada do CRM a parar pelo compose"
}

Log "Parando o Supabase local (os dados ficam guardados)"
# SEM `--no-backup` (apaga os volumes do banco) e SEM `--all` (pararia o Supabase de outros sistemas).
& $CliExe @CliArgs stop --project-id $Projeto --workdir $Raiz
# O código agora é o real (B1); falhou, não digo que parou.
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO: o 'supabase stop' falhou (código $LASTEXITCODE; a mensagem dele está acima). O Supabase deste CRM pode continuar de pé: confira com 'docker ps' e rode scripts\parar.ps1 de novo." -ForegroundColor Red
    exit 1
}

Log "Parado. Para subir de novo: scripts\instalar.ps1"
