# CRM ALQUIM(IA): instalação local de UM comando (Windows PowerShell 5.1 ou mais novo).
#
#   powershell -ExecutionPolicy Bypass -File scripts\instalar.ps1
#
# Faz, nesta ordem: confere Docker, Node 22 e a CLI do Supabase (usa `npx supabase` se faltar)
# -> gera os segredos aleatórios do .env.local (SEM imprimir nenhum) -> constrói as imagens uma por vez
# -> sobe o Supabase local -> aplica supabase\baseline.sql -> grava as chaves do `supabase status` no
# .env.local -> docker compose up -d -> espera o app e o worker responderem -> abre http://localhost:3000/signup.
#
# É IDEMPOTENTE: rodar de novo não apaga banco, volume nem segredo. Os segredos que já existem no
# .env.local são mantidos; o baseline é reaplicado em modo de atualização.
#
# Variáveis de ambiente (todas opcionais):
#   CRM_ALQUIMIA_PORTA_APP (3000)  CRM_ALQUIMIA_PORTA_WORKER (8787)  CRM_ALQUIMIA_PORTA_EVOLUTION (8080)
#   CRM_ALQUIMIA_PORTA_SUPABASE_API (54321)  CRM_ALQUIMIA_PORTA_SUPABASE_DB (54322)
#   As portas escolhidas ficam gravadas no .env.local: rodar de novo SEM a variável mantém as portas.
#   CRM_ALQUIMIA_NAO_ABRIR=1   não abre o navegador no fim
#   CRM_ALQUIMIA_SUPABASE_CLI  comando da CLI do Supabase (padrão: `npx --yes supabase@<versão testada>`)
#   CRM_ALQUIMIA_PROJETO (crm-alquimia)  nome do projeto no Docker e no Supabase (duas instalações lado a lado)
#   CRM_ALQUIMIA_HEAP_BUILD_MB (4096)    memória do Node ao compilar o app (menos RAM: 2048 com 1 CPU; mais lento)
#   CRM_ALQUIMIA_BUILD_CPUS (2)          CPUs ao compilar o app (threads do Turbopack; menos RAM: 1; mais lento)
#   CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD (auto)  numa reinstalação com o Supabase deste CRM de pé: auto para o
#                                        Supabase durante o build só se a memória livre (a menor entre a do
#                                        computador e a da VM do Docker) for menor que o limiar
#                                        (o CRM fica fora do ar até o fim do build); sempre; nunca. Parado, ele
#                                        volta se o build falhar ou for interrompido com Ctrl+C. Morto à força
#                                        (kill -9, queda de energia), não volta: rode o instalador de novo.
#   CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB (6144)  o limiar do modo auto
#
# Ao lado de outro sistema: antes de tocar em qualquer coisa, confere que cada porta está livre (ou é do
# próprio CRM); ocupada, para e diz qual variável trocar. Todo `docker compose` leva `-p <projeto>`.
#
# Escrito para o Windows PowerShell 5.1: sem operadores de encadeamento de comandos, sem operador
# ternário e sem coalescência nula. Comandos nativos (docker, npx) escrevem progresso no stderr, então
# $ErrorActionPreference fica em Continue e o sucesso é conferido por $LASTEXITCODE.

$ErrorActionPreference = "Continue"
Set-StrictMode -Version 2.0

$Raiz = Split-Path -Parent $PSScriptRoot
Set-Location $Raiz

$EnvLocal = ".env.local"
$Utf8SemBom = New-Object System.Text.UTF8Encoding($false)

. (Join-Path $PSScriptRoot "lib\instalar-env.ps1")

$EnvCaminho = Join-Path $Raiz $EnvLocal

function Log([string]$msg) { Write-Host "==> $msg" }
function Falha([string]$msg) {
    Write-Host "ERRO: $msg" -ForegroundColor Red
    Restaurar-Migracoes
    Avisar-BuildPodeSeguir
    Religar-SupabaseSeParei
    exit 1
}

# O cliente do build morto (ou que falhou no meio) não para a compilação que ele já
# pediu ao Docker, e o religamento do banco cairia por cima dela. No Windows o Ctrl+C chega ao próprio
# 'docker compose build' pelo console, e não há como parar SÓ o build deste projeto dentro do Docker sem um
# comando que atinja os outros (nada de 'builder prune'): o instalador avisa e diz como conferir.
$script:BuildEmCurso = $false
function Avisar-BuildPodeSeguir {
    if (-not $script:BuildEmCurso) { return }
    $script:BuildEmCurso = $false
    Log "ATENÇÃO: um build interrompido pode seguir compilando dentro do Docker por alguns minutos (e usando memória). Confira com 'docker buildx history ls' (o que está 'Running') ou na aba Builds do Docker Desktop, e espere ele acabar antes de rodar o instalador de novo."
}

# Se o instalador parou o Supabase para o build e vai sair antes de religá-lo (build que
# falhou, Ctrl+C, erro qualquer), ele sobe de novo aqui. Chamada pela Falha e pelo finally do build.
$script:PareiOSupabase = $false
# Chaves novas nesta execução (definido de verdade na etapa 3): o religamento diz para rodar o instalador de novo.
$CredenciaisNovas = $false
function Religar-SupabaseSeParei {
    if (-not $script:PareiOSupabase) { return }
    $script:PareiOSupabase = $false
    Log "Religando o Supabase deste CRM, que o instalador tinha parado para o build"
    if (Subir-SupabaseComRecuperacao) {
        if ($CredenciaisNovas) {
            # O Supabase voltou com as chaves novas, e o .env.local do app ainda tem as de antes (só a etapa 6 as regrava).
            Log "Supabase de volta, já com as chaves novas desta instalação. O app ainda tem as chaves de antes e não entra: rode o instalador de novo para regravá-las."
        } else {
            Log "Supabase de volta: o CRM que já estava instalado tem banco de novo."
        }
    } else {
        Write-Host "ERRO: Não consegui religar o Supabase. O CRM está sem banco: siga a mensagem acima." -ForegroundColor Red
    }
}

# Sobe o Supabase deste CRM e devolve $true se deu certo. A cadeia de migrations não sobe num banco novo:
# o que se aplica é o baseline.sql. A pasta sai do caminho só durante o `start` e volta ao lugar logo depois.
# A saída do `start` traz as chaves do banco: dela, só as linhas de erro passam. O progresso fica no stderr.
# -x: sobe só o que o CRM usa (sem painel, e-mail de teste e redimensionador de imagens).
# O stderr (o progresso e o erro) aparece na tela E fica guardado em $script:ErroDoStart: se o start falhar,
# as últimas linhas vão na mensagem final. Do stdout passa só o erro (a CLI 2.120 o escreve ali, em JSON),
# pela Linha-DeErroDaCli; o resto, com as chaves, é descartado.
$script:ErroDoStart = @()
function Subir-Supabase {
    if (Test-Path "supabase\migrations") { Move-Item "supabase\migrations" "supabase\.migracoes-fora" }
    New-Item -ItemType Directory -Force "supabase\migrations" | Out-Null
    $script:ErroDoStart = @()
    & $CliExe @CliArgs start -x $script:SupabaseServicosFora --workdir $Raiz 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
            $linha = Mascarar-Segredos $_.Exception.Message
            Write-Host $linha
            $script:ErroDoStart += $linha
        } else {
            $linha = Linha-DeErroDaCli ([string]$_)
            if ($linha -ne "") {
                Write-Host $linha
                $script:ErroDoStart += $linha
            }
        }
    }
    $codigoStart = $LASTEXITCODE
    Restaurar-Migracoes
    return ($codigoStart -eq 0)
}

# Um instalador morto no meio do 'supabase start' deixa o contêiner do banco em
# 'Created', e o 'start' seguinte sai com 1 sem mensagem nenhuma. O que destrava é 'supabase stop
# --project-id <projeto>' (guarda os dados; nunca '--no-backup'). Tenta isso UMA vez e um novo 'start'; se
# falhar de novo, diz o que fazer e mostra as últimas linhas do erro.
function Subir-SupabaseComRecuperacao {
    if (Subir-Supabase) { return $true }
    Log "O 'supabase start' falhou. Tentando destravar uma vez: 'supabase stop --project-id $Projeto' (guarda os dados) e um novo 'start'."
    # O erro da primeira tentativa fica guardado: se a segunda falhar por outro motivo, a mensagem mostra os dois.
    $erroDaPrimeira = @($script:ErroDoStart)
    & $CliExe @CliArgs stop --project-id $Projeto --workdir $Raiz | Out-Null
    if (Subir-Supabase) { return $true }
    Write-Host "ERRO: O 'supabase start' falhou duas vezes, a segunda depois de um 'supabase stop' (os dados ficam). Rode scripts\parar.ps1 e depois este instalador de novo. Últimas linhas do erro do 'supabase start':" -ForegroundColor Red
    foreach ($tentativa in @(@{ Nome = "primeira"; Linhas = $erroDaPrimeira }, @{ Nome = "segunda"; Linhas = @($script:ErroDoStart) })) {
        Write-Host "  Na $($tentativa.Nome) tentativa:"
        # O aviso da seção [inbucket] obsoleta sai em toda execução e não diz nada da falha: fica de fora.
        $ultimas = @($tentativa.Linhas | Where-Object { ([string]$_).Trim() -ne "" -and ([string]$_) -notmatch '\[inbucket\]' } | Select-Object -Last 15)
        if ($ultimas.Count -gt 0) {
            foreach ($l in $ultimas) { Write-Host ("    " + (Mascarar-Segredos ([string]$l))) }
        } else {
            Write-Host "    (o 'supabase start' não escreveu nenhuma mensagem)"
        }
    }
    return $false
}

# Portas e projeto: variável do ambiente, depois o que já está no .env.local, depois o padrão. Só LÊ: nada
# é gravado antes de conferir que as portas estão livres.
try { $Projeto = Projeto-Resolvido $EnvCaminho } catch { Write-Host ("ERRO: " + $_.Exception.Message + " Nada foi alterado.") -ForegroundColor Red; exit 1 }
try { $HeapBuildMb = Heap-DoBuild $EnvCaminho } catch { Write-Host ("ERRO: " + $_.Exception.Message + " Nada foi alterado.") -ForegroundColor Red; exit 1 }
try { $BuildCpus = Cpus-DoBuild $EnvCaminho } catch { Write-Host ("ERRO: " + $_.Exception.Message + " Nada foi alterado.") -ForegroundColor Red; exit 1 }
try { $ModoPararBanco = Modo-PararBanco $EnvCaminho } catch { Write-Host ("ERRO: " + $_.Exception.Message + " Nada foi alterado.") -ForegroundColor Red; exit 1 }
try { $LimiarPararBancoMb = Limiar-PararBancoMb $EnvCaminho } catch { Write-Host ("ERRO: " + $_.Exception.Message + " Nada foi alterado.") -ForegroundColor Red; exit 1 }
$PortaApp = Porta-Resolvida $EnvCaminho "CRM_ALQUIMIA_PORTA_APP" "3000"
$PortaWorker = Porta-Resolvida $EnvCaminho "CRM_ALQUIMIA_PORTA_WORKER" "8787"
$PortaEvolution = Porta-Resolvida $EnvCaminho "CRM_ALQUIMIA_PORTA_EVOLUTION" "8080"
$PortaApi = Porta-Resolvida $EnvCaminho "CRM_ALQUIMIA_PORTA_SUPABASE_API" "54321"
$PortaDb = Porta-Resolvida $EnvCaminho "CRM_ALQUIMIA_PORTA_SUPABASE_DB" "54322"

# --- 0. Se uma execução anterior morreu com as migrations fora do lugar, devolve ------------------
function Restaurar-Migracoes {
    if (Test-Path "supabase\.migracoes-fora") {
        if (Test-Path "supabase\migrations") { Remove-Item -Recurse -Force "supabase\migrations" }
        Move-Item "supabase\.migracoes-fora" "supabase\migrations"
    }
}
Restaurar-Migracoes

# Roda um comando nativo e falha com a mensagem dada se o código de saída não for 0.
function Rodar([string]$mensagemDeErro, [scriptblock]$comando) {
    & $comando
    if ($LASTEXITCODE -ne 0) { Falha $mensagemDeErro }
}

# --- 1. Confere o ambiente ------------------------------------------------------------------------
Log "Conferindo Docker, Node e a CLI do Supabase"
if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
    Falha "Docker não encontrado. Instale o Docker Desktop (https://www.docker.com/products/docker-desktop) e abra-o."
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Falha "O Docker está instalado mas não está rodando. Abra o Docker Desktop, espere ele ficar verde e rode de novo."
}
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Falha "O plugin 'docker compose' não foi encontrado. Atualize o Docker Desktop." }

if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
    Falha "Node não encontrado. Instale o Node 22 (https://nodejs.org)."
}
$NodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 22) { Falha "Node $NodeMajor encontrado; este projeto pede o Node 22 ou mais novo (https://nodejs.org)." }

# A CLI do Supabase na versão testada (o npx baixa na primeira vez), como (programa, argumentos fixos)
# para chamar com splatting, sempre apontada para ESTA pasta (--workdir).
try { $Cli = Supabase-Cli } catch { Falha $_.Exception.Message }
$CliExe = $Cli[0]
$CliArgs = @()
if ($Cli.Length -gt 1) { $CliArgs = $Cli[1..($Cli.Length - 1)] }
if ($null -eq (Get-Command $CliExe -ErrorAction SilentlyContinue)) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_SUPABASE_CLI"))) {
        Falha "O 'npx' não foi encontrado. Instale o Node 22 (vem com o npx)."
    }
    Falha "Não achei o programa '$CliExe' de CRM_ALQUIMIA_SUPABASE_CLI."
}
function Supabase {
    & $CliExe @CliArgs @args --workdir $Raiz
}

# --- 2. As portas estão livres? (antes de tocar em qualquer coisa) ---------------------------------
Log "Conferindo se as portas estão livres"
$Itens = @(
    "CRM_ALQUIMIA_PORTA_APP=$PortaApp", "CRM_ALQUIMIA_PORTA_WORKER=$PortaWorker",
    "CRM_ALQUIMIA_PORTA_EVOLUTION=$PortaEvolution", "CRM_ALQUIMIA_PORTA_SUPABASE_API=$PortaApi",
    "CRM_ALQUIMIA_PORTA_SUPABASE_DB=$PortaDb"
) + @(Portas-ExtrasDoConfig (Join-Path $Raiz "supabase\config.toml") $PortaDb)
if (-not (Conferir-PortasLivres $Projeto $Itens)) {
    # A última linha segue o motivo. Recusa só pelo nome do projeto não manda "escolher portas".
    if ($script:RecusaPorDocker) {
        Falha "Nada foi alterado. O Docker não respondeu a uma listagem (a mensagem dele está acima): confira com 'docker ps' e 'docker volume ls' e rode de novo scripts\instalar.ps1."
    }
    if ($script:RecusaPorPorta) {
        Falha "Nada foi alterado. Escolha portas livres (as sugestões estão acima; por exemplo `$env:CRM_ALQUIMIA_PORTA_APP = ""<porta>"") e rode de novo scripts\instalar.ps1 (as escolhidas ficam gravadas no .env.local)."
    }
    Falha "Nada foi alterado. Corrija o que está acima (por exemplo, outro nome em `$env:CRM_ALQUIMIA_PROJETO) e rode de novo scripts\instalar.ps1."
}

# Agora sim: portas e projeto ficam gravados no .env.local (rodar de novo sem as variáveis os mantém).
if (-not (Test-Path $EnvCaminho)) {
    [System.IO.File]::WriteAllText($EnvCaminho, "", $Utf8SemBom)
}
# SEMPRE (também quando o .env.local já existia, de uma instalação antiga ou copiado de outro lugar).
Restringir-ArquivoAoDono $EnvCaminho
Definir-NoEnv $EnvCaminho "CRM_ALQUIMIA_PROJETO" $Projeto "sempre"
Definir-NoEnv $EnvCaminho "CRM_ALQUIMIA_PORTA_APP" $PortaApp "sempre"
Definir-NoEnv $EnvCaminho "CRM_ALQUIMIA_PORTA_WORKER" $PortaWorker "sempre"
Definir-NoEnv $EnvCaminho "CRM_ALQUIMIA_PORTA_EVOLUTION" $PortaEvolution "sempre"
Definir-NoEnv $EnvCaminho "CRM_ALQUIMIA_PORTA_SUPABASE_API" $PortaApi "sempre"
Definir-NoEnv $EnvCaminho "CRM_ALQUIMIA_PORTA_SUPABASE_DB" $PortaDb "sempre"

# O docker-compose.yml lê as portas do host e o heap do build do ambiente do próprio compose.
$env:CRM_ALQUIMIA_PORTA_APP = $PortaApp
$env:CRM_ALQUIMIA_PORTA_WORKER = $PortaWorker
$env:CRM_ALQUIMIA_PORTA_EVOLUTION = $PortaEvolution
# Pouca memória (modo auto, abaixo do limiar) e nada escolhido para o build: a combinação medida que cabe.
# Memória que não deu para medir não troca nada. A escolha não vai para o .env.local.
if (($ModoPararBanco -eq "auto") -and -not (Build-DefinidoPeloUsuario $EnvCaminho)) {
    $MemoriaDoBuildMb = Memoria-ParaBuildMb
    if (($MemoriaDoBuildMb -ne "") -and ([long]$MemoriaDoBuildMb -lt [long]$LimiarPararBancoMb)) {
        $BuildCpus = "1"
        $HeapBuildMb = "2048"
        Log "Pouca memória livre ($MemoriaDoBuildMb MB, abaixo de $LimiarPararBancoMb MB): o app vai compilar com 1 CPU e 2048 MB (mais lento, mas cabe). Para escolher outro valor, defina CRM_ALQUIMIA_BUILD_CPUS e CRM_ALQUIMIA_HEAP_BUILD_MB."
    }
}
$env:CRM_ALQUIMIA_HEAP_BUILD_MB = $HeapBuildMb
$env:CRM_ALQUIMIA_BUILD_CPUS = $BuildCpus

# A versão da imagem é a do package.json desta pasta: o compose a passa ao build (APP_VERSION), e ela fica no
# .env.local para um `docker compose up --build` manual responder o mesmo. Rodar o instalador de novo (atualizar)
# a renova. Só uma versão de forma conhecida entra; sem package.json, a imagem fica sem versão.
$VersaoDoPacote = [string](node -e "try{const v=require('./package.json').version;if(typeof v==='string')process.stdout.write(v)}catch(e){}")
if ($VersaoDoPacote -cmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
    Definir-NoEnv $EnvCaminho "APP_VERSION" $VersaoDoPacote "sempre"
    $env:APP_VERSION = $VersaoDoPacote
} else {
    $VersaoDoPacote = ""
}

# Portas do Supabase, URLs de retorno do login e nome do projeto no supabase\config.toml.
Ajustar-ConfigToml (Join-Path $Raiz "supabase\config.toml") $PortaApi $PortaDb $PortaApp $Projeto
# Sem as quatro linhas do [auth] (por exemplo, um conflito de 'git pull' resolvido com a versão antiga), a CLI
# usaria chaves públicas sem avisar ninguém: para antes do primeiro comando dela.
$FaltamNoConfig = Conferir-ConfigDasChaves (Join-Path $Raiz "supabase\config.toml")
if ($FaltamNoConfig -ne "") {
    Falha "O supabase\config.toml não aponta para as chaves desta instalação: falta, na seção [auth], $FaltamNoConfig. Sem isso o Supabase subiria com chaves públicas. Volte essas linhas ao que está no repositório (git checkout -- supabase/config.toml, ou copie a seção [auth] da versão baixada) e rode o instalador de novo."
}

# --- 3. Segredos e imagens (ANTES do Supabase) --------------------------------------------------
# O build do app pede cerca de 4 GB na VM do Docker, e com o Supabase de pé ao lado (mais
# ~1,1 GB) a instalação limpa não coube numa máquina de 8 GB. As imagens não dependem do banco: o compose
# só precisa dos segredos gerados aqui. Então elas saem primeiro, e o Supabase sobe depois. Numa
# reinstalação com o Supabase deste CRM já de pé, ele para durante o build (os dados ficam) e volta logo.
function Segredo-Hex { return [string](node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))") }
function Segredo-Base64 { return [string](node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))") }

# O .env.local já existe (criado no começo; Restringir-ArquivoAoDono tirou a herança de permissões).
$PrimeiraLinha = Ler-LinhasDoEnv $EnvCaminho
if (@($PrimeiraLinha | Where-Object { $_ -like "# CRM ALQUIM(IA)*" }).Count -eq 0) {
    $todas = New-Object System.Collections.Generic.List[string]
    $todas.Add("# CRM ALQUIM(IA): gerado por scripts/instalar.ps1. NUNCA commitar. Referencia: .env.example")
    foreach ($l in $PrimeiraLinha) { $todas.Add($l) }
    [System.IO.File]::WriteAllText($EnvCaminho, (($todas -join "`n") + "`n"), $Utf8SemBom)
}

function Definir([string]$chave, [string]$valor, [string]$modo) { Definir-NoEnv $EnvCaminho $chave $valor $modo }
function Valor-Atual([string]$chave) { return (Valor-DoEnv $EnvCaminho $chave) }

# $CredenciaisNovas: alguma das chaves desta instalação (o segredo do JWT, a chave secreta da API ou a chave de
# assinatura) nasce nesta execução (instalação de antes delas, ou linha/arquivo apagado), ou uma execução anterior
# as gerou e não chegou a reiniciar o Supabase (o marcador abaixo). Um Supabase de pé ainda usa as de antes.
$MarcadorReinicio = Join-Path $Raiz "supabase\.env.pendente"
$ArquivoDaChave = Join-Path $Raiz "supabase\signing_keys.json"
$CredenciaisNovas = ((Test-Path -LiteralPath $MarcadorReinicio) -or ((Valor-Atual "CRM_ALQUIMIA_JWT_SECRET") -eq "") -or ((Valor-Atual "CRM_ALQUIMIA_SECRET_KEY") -eq ""))
$EstadoDaChave = Estado-DaChaveDeAssinatura $ArquivoDaChave
if ($EstadoDaChave -eq "invalida") {
    Falha "A supabase\signing_keys.json existe, mas não é uma lista de chaves que a CLI do Supabase entenda. Não apago chave sua: mova o arquivo para fora da pasta supabase (ou conserte-o) e rode o instalador de novo. Ele gera outra chave, e as sessões abertas podem pedir novo login; os dados ficam."
}
if ($EstadoDaChave -ne "valida") { $CredenciaisNovas = $true }
# A pendência vai para o disco ANTES de qualquer credencial nova: se esta execução for interrompida (Ctrl+C, queda
# do PC, 'supabase stop' que falha) antes de o Supabase subir com elas, a próxima o reinicia em vez de confiar no que
# está de pé. Sai só depois de o Supabase subir com as chaves desta instalação (etapa 4).
if ($CredenciaisNovas) {
    [System.IO.File]::WriteAllText($MarcadorReinicio, "", $Utf8SemBom)
    Restringir-ArquivoAoDono $MarcadorReinicio
}
# Segredos (gerados uma vez; mantidos nas reinstalações)
foreach ($nome in @("INTERNAL_SECRET", "EVOLUTION_API_KEY", "EVOLUTION_WEBHOOK_TOKEN", "EVOLUTION_DB_PASSWORD", "SRH_TOKEN", "WAHA_HMAC_SECRET", "IMPERSONATE_COOKIE_SECRET", "LGPD_SIGNING_KEY", "CRM_ALQUIMIA_JWT_SECRET")) {
    if ((Valor-Atual $nome) -eq "") { Definir $nome (Segredo-Hex) "sempre" }
}
foreach ($nome in @("CPF_ENCRYPTION_KEY", "WAHA_BYO_ENCRYPTION_KEY", "AI_CRED_AES_KEY")) {
    if ((Valor-Atual $nome) -eq "") { Definir $nome (Segredo-Base64) "sempre" }
}
# O segredo do JWT do Supabase desta instalação (supabase\config.toml lê `env(CRM_ALQUIMIA_JWT_SECRET)`) nasce na
# lista de segredos acima; ele e as chaves da API vão para todo comando da CLI pelo Exportar-SegredosDaCli abaixo.
# As chaves novas da API (sb_publishable_, sb_secret_), que o gateway do Supabase troca pelas chaves anon e
# service_role: as padrão da CLI são públicas (a secreta padrão abriria tudo). Uma por instalação, mantidas.
Definir "CRM_ALQUIMIA_PUBLISHABLE_KEY" ("sb_publishable_" + (Segredo-Hex).Substring(0, 32)) "se_vazio"
Definir "CRM_ALQUIMIA_SECRET_KEY" ("sb_secret_" + (Segredo-Hex)) "se_vazio"
Exportar-SegredosDaCli $EnvCaminho
# O supabase\.env, que a CLI lê sozinha: quem subir o Supabase à mão fica com as chaves desta instalação.
Gravar-EnvDaCli $EnvCaminho (Join-Path $Raiz "supabase\.env")
# A chave ES256 que assina as sessões e as chaves anon e service_role: gerada pela própria CLI, uma vez, em
# supabase\signing_keys.json (só do dono; fora do git, da imagem e do backup). Sem ela, a CLI assinaria com a
# chave que vem dentro dela, igual em toda instalação. Vem ANTES do primeiro comando da CLI que lê o config
# (o `status` e o `start` falham sem o arquivo). Gerada agora, numa instalação que já existia: um Supabase de pé
# assina com a de antes, e as sessões caem no reinício (o aviso vem logo abaixo).
# Uma chave privada que já existe nunca é trocada nem apagada.
if ($EstadoDaChave -ne "valida") {
    Log "Gerando a chave de assinatura das sessões desta instalação (supabase\signing_keys.json, só o seu usuário a lê; nada dela é impresso)"
    if (-not (Gerar-ChaveDeAssinatura $ArquivoDaChave $CliExe $CliArgs $Raiz)) {
        Falha "Não consegui gerar a chave de assinatura das sessões com a CLI do Supabase (a mensagem dela está acima). Rode o instalador de novo."
    }
}
# O UPSTASH_REDIS_REST_TOKEN é o mesmo SRH_TOKEN.
Definir "UPSTASH_REDIS_REST_TOKEN" (Valor-Atual "SRH_TOKEN") "sempre"

# Com o Supabase deste CRM de pé (reinstalação, atualização), parar só se falta memória
# (CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=auto, o padrão; ou sempre/nunca). Parado, o CRM fica fora do ar
# durante o build, e a Falha e o finally abaixo garantem que ele sobe de novo se o build não terminar.
Supabase status *> $null
if ($LASTEXITCODE -eq 0) {
    $LivreMb = Memoria-ParaBuildMb
    $LivreTexto = $LivreMb
    if ($LivreTexto -eq "") { $LivreTexto = "não medida" }
    if ($CredenciaisNovas) {
        # Os contêineres de pé validam com as chaves antigas; as chaves gravadas no fim sairão das novas.
        Log "ATENÇÃO: esta instalação ganhou agora chaves só dela (a que assina as sessões e as da API). O Supabase deste CRM vai parar e subir de novo com elas, para as chaves do app baterem. As sessões abertas podem pedir novo login (o token de renovação antigo costuma renovar com a chave nova, mas não conte com isso). Os dados ficam, e o CRM fica fora do ar até o fim do build."
        $script:PareiOSupabase = $true
        & $CliExe @CliArgs stop --project-id $Projeto --workdir $Raiz
        if ($LASTEXITCODE -ne 0) { Falha "O 'supabase stop' falhou antes da construção das imagens. Veja a mensagem acima." }
    } elseif (Deve-PararBanco $ModoPararBanco $LivreMb $LimiarPararBancoMb) {
        Log "ATENÇÃO: o Supabase deste CRM vai parar durante a construção das imagens (memória livre, a menor entre o computador e a VM do Docker: $LivreTexto MB; limiar $LimiarPararBancoMb MB; CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=$ModoPararBanco). O CRM fica fora do ar até o fim do build; os dados ficam, e ele volta se o build falhar ou for interrompido com Ctrl+C. Se este instalador for morto à força, rode-o de novo para subir o Supabase."
        $script:PareiOSupabase = $true
        & $CliExe @CliArgs stop --project-id $Projeto --workdir $Raiz
        if ($LASTEXITCODE -ne 0) { Falha "O 'supabase stop' falhou antes da construção das imagens. Veja a mensagem acima." }
    } else {
        Log "O Supabase deste CRM continua de pé durante o build (memória livre, a menor entre o computador e a VM do Docker: $LivreTexto MB; CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=$ModoPararBanco)."
    }
}
# UMA imagem por vez: em paralelo, o build do app (até CRM_ALQUIMIA_HEAP_BUILD_MB de memória só para o
# Node) somado ao do worker pode esgotar a memória do Docker e derrubar o que mais estiver rodando nele.
Log "Construindo as imagens do CRM, uma por vez (a primeira vez demora: compila o app)"
Log (Aviso-DoBuild $HeapBuildMb $BuildCpus)
$BuildTerminou = $false
try {
    foreach ($servico in @("app", "worker", "scheduler")) {
        $script:BuildEmCurso = $true
        Compose-Crm $Projeto build $servico
        if ($LASTEXITCODE -ne 0) { Falha "A construção da imagem '$servico' falhou. Veja a mensagem acima (falta de memória aparece como 'killed' ou 'heap out of memory')." }
    }
    $script:BuildEmCurso = $false
    $BuildTerminou = $true
} finally {
    # Ctrl+C ou erro que não passou pela Falha: avisa do build que pode ter sobrado, e o Supabase parado volta.
    if (-not $BuildTerminou) {
        Avisar-BuildPodeSeguir
        Religar-SupabaseSeParei
    }
}

# --- 4. Supabase local ----------------------------------------------------------------------------
Log "Subindo o Supabase local (a primeira vez baixa as imagens e leva alguns minutos)"
$AvisoJwks = "AVISO: não consegui conferir pelo JWKS do Supabase (http://127.0.0.1:$PortaApi/auth/v1/.well-known/jwks.json) a chave que assina as sessões. Se o app não entrar, rode o parar e este instalador de novo."
$SubiAgora = $false
Supabase status *> $null
if ($LASTEXITCODE -eq 0) {
    # De pé não quer dizer com as chaves desta instalação: uma execução interrompida, ou um 'supabase start' à mão
    # sem o supabase\.env, deixa a chave da CLI (pública) no ar.
    $MotivoReinicio = ""
    if (Test-Path -LiteralPath $MarcadorReinicio) {
        $MotivoReinicio = "uma execução anterior deste instalador gerou chaves novas e não chegou a reiniciar o Supabase"
    } else {
        $CodigoVivo = Conferir-SupabaseVivo $PortaApi $Projeto $ArquivoDaChave
        if ($CodigoVivo -eq 1) { $MotivoReinicio = "o Supabase de pé não usa as chaves desta instalação (a que assina as sessões, o segredo do JWT ou as da API)" }
        elseif ($CodigoVivo -eq 2) { Log $AvisoJwks }
    }
    if ($MotivoReinicio -ne "") {
        Log "ATENÇÃO: $MotivoReinicio. Ele vai parar e subir de novo com as chaves desta instalação. As sessões abertas podem pedir novo login (o token de renovação antigo costuma renovar com a chave nova, mas não conte com isso); os dados ficam."
        & $CliExe @CliArgs stop --project-id $Projeto --workdir $Raiz
        if ($LASTEXITCODE -ne 0) { Falha "O 'supabase stop' falhou. Veja a mensagem acima, rode o parar (scripts\parar.ps1) e este instalador de novo." }
        if (-not (Subir-SupabaseComRecuperacao)) { exit 1 }
        $SubiAgora = $true
    } else {
        Log "Supabase já está rodando"
    }
} else {
    # Quem sobe agora é esta etapa: a Falha não tenta de novo se este start falhar.
    $EstavaParadoPeloInstalador = $script:PareiOSupabase
    $script:PareiOSupabase = $false
    if (-not (Subir-SupabaseComRecuperacao)) { exit 1 }
    if ($EstavaParadoPeloInstalador) { Log "Supabase de volta depois do build." }
    $SubiAgora = $true
}
if ($SubiAgora) {
    $CodigoVivo = Conferir-SupabaseVivo $PortaApi $Projeto $ArquivoDaChave
    if ($CodigoVivo -eq 1) {
        Falha "O Supabase subiu, mas não com as chaves desta instalação (a que assina as sessões, o segredo do JWT ou as da API): o JWKS ou os contêineres do Auth e do Kong mostram outras. Confira se o supabase\config.toml e o supabase\.env são os que o instalador gravou, rode o parar e este instalador de novo."
    } elseif ($CodigoVivo -eq 2) { Log $AvisoJwks }
}
# O Supabase está de pé com as chaves desta instalação: nada pendente para a próxima execução.
if (Test-Path -LiteralPath $MarcadorReinicio) { Remove-Item -Force -LiteralPath $MarcadorReinicio }

$DbContainer = "supabase_db_$Projeto"
docker inspect $DbContainer *> $null
if ($LASTEXITCODE -ne 0) {
    Falha "Não achei o contêiner $DbContainer depois do 'supabase start'. Rode 'supabase status' para ver o que houve."
}

# --- 5. Schema (baseline.sql) ---------------------------------------------------------------------
Log "Aplicando o schema (supabase\baseline.sql)"
Rodar "Falha ao copiar o prelúdio de extensões para o banco." { docker cp "scripts\instalar-extensoes.sql" "${DbContainer}:/tmp/instalar-extensoes.sql" }
Rodar "Falha ao copiar o baseline.sql para o banco." { docker cp "supabase\baseline.sql" "${DbContainer}:/tmp/baseline.sql" }
Rodar "Falha ao habilitar as extensões do banco." { docker exec $DbContainer psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/instalar-extensoes.sql }
$JaTemSchema = (docker exec $DbContainer psql -U postgres -d postgres -At -c "select to_regclass('public.organizations') is not null") | Out-String
if ($JaTemSchema.Trim() -eq "t") {
    # Banco que já tem o schema: reaplica em modo de atualização (sem ON_ERROR_STOP; o baseline é idempotente).
    docker exec $DbContainer psql -U postgres -d postgres -q -f /tmp/baseline.sql | Out-Null
} else {
    docker exec $DbContainer psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/baseline.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { Falha "O baseline.sql falhou num banco novo. Rode scripts\parar.ps1 e tente de novo; se repetir, abra uma issue com a mensagem acima." }
}
docker exec $DbContainer rm -f /tmp/baseline.sql /tmp/instalar-extensoes.sql | Out-Null

# A versão instalada vai para o banco. A tela de Atualização a mostra, e nesta
# versão não há agente do host para gravá-la (a coluna nascia vazia: "Versão instalada: ."). Só uma versão
# de forma conhecida entra no SQL; sem package.json ou com versão estranha, nada é gravado e a tela usa a
# versão da imagem.
$VersaoInstalada = $VersaoDoPacote
if ($VersaoInstalada -cmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
    docker exec $DbContainer psql -U postgres -d postgres -q -c "update public.system_version set current_version = '$VersaoInstalada', updated_at = now() where id = 1" | Out-Null
    if ($LASTEXITCODE -ne 0) { Log "Aviso: não consegui gravar a versão instalada ($VersaoInstalada) no banco; a tela de Atualização mostra a versão da imagem." }
}

# O Realtime só enxerga as tabelas que o baseline pôs na publication se reiniciar depois dele.
# Pelo nome EXATO (o filtro `name=` do docker casa por pedaço do nome).
docker inspect "supabase_realtime_$Projeto" *> $null
if ($LASTEXITCODE -eq 0) { docker restart "supabase_realtime_$Projeto" | Out-Null }

# --- 6. .env.local ---------------------------------------------------------------------------------
Log "Gravando o .env.local (nenhum segredo é impresso)"
$StatusEnv = (Supabase status -o env 2>$null) | Out-String
if ($LASTEXITCODE -ne 0) { Falha "Não consegui ler o 'supabase status'." }
function Ler-Status([string]$chave) {
    foreach ($l in ($StatusEnv -split "`r?`n")) {
        if ($l.StartsWith($chave + "=")) { return $l.Substring($chave.Length + 1).Trim('"') }
    }
    return ""
}
$ChaveAnon = Ler-Status "ANON_KEY"
$ChaveServico = Ler-Status "SERVICE_ROLE_KEY"
$StatusEnv = $null
if ([string]::IsNullOrEmpty($ChaveAnon) -or [string]::IsNullOrEmpty($ChaveServico)) {
    Falha "O 'supabase status' não devolveu as chaves (ANON_KEY, SERVICE_ROLE_KEY). Atualize a CLI do Supabase."
}



# Derivados (sempre atualizados). O NAVEGADOR usa localhost; os CONTÊINERES usam host.docker.internal
# (SUPABASE_URL_INTERNA, lida só pelo servidor).
Definir "NEXT_PUBLIC_SUPABASE_URL" "http://localhost:$PortaApi" "sempre"
Definir "SUPABASE_URL_INTERNA" "http://host.docker.internal:$PortaApi" "sempre"
Definir "NEXT_PUBLIC_SUPABASE_ANON_KEY" $ChaveAnon "sempre"
Definir "SUPABASE_SERVICE_ROLE_KEY" $ChaveServico "sempre"
Definir "SUPABASE_DB_URL" "postgresql://postgres:postgres@host.docker.internal:$PortaDb/postgres" "sempre"
Definir "NEXT_PUBLIC_APP_URL" "http://localhost:$PortaApp" "sempre"
Definir "NEXT_PUBLIC_ADMIN_URL" "http://localhost:$PortaApp" "sempre"
Definir "UPSTASH_REDIS_REST_URL" "http://srh:80" "sempre"
Definir "EVOLUTION_API_BASE_URL" "http://evolution:8080" "sempre"
Definir "EVOLUTION_WEBHOOK_GLOBAL" "true" "sempre"
Definir "WAHA_HEALTH_CHECK" "off" "sempre"
Definir "SENTRY_DSN" "off" "sempre"
Definir "NEXT_TELEMETRY_DISABLED" "1" "sempre"
$ChaveAnon = $null
$ChaveServico = $null

# Chave de cifra do banco (segredos de webhook, token de canal oficial, credencial do Google): gerada uma
# vez, gravada em private.app_secrets e guardada no .env.local. Se o banco já tem uma, ela fica (e o
# .env.local passa a guardar a mesma): trocar tornaria ilegível o que já foi cifrado.
try { Ativar-ChaveDeCifra $EnvCaminho $DbContainer } catch { Falha ("Não consegui ativar a chave de cifra do banco. " + $_.Exception.Message) }
# Envio real DESLIGADO: a linha existe, vazia. Quem a liga é você (README, "Ligar o envio real").
if (@(Ler-LinhasDoEnv $EnvCaminho | Where-Object { $_.StartsWith("DISPARO_REAL_LIBERADO=") }).Count -eq 0) {
    Definir "DISPARO_REAL_LIBERADO" "" "sempre"
}


# --- 7. Aplicação ---------------------------------------------------------------------------------
Log "Subindo o CRM"
Rodar "O 'docker compose up' falhou. Veja a mensagem acima." { Compose-Crm $Projeto up -d }

Log "Esperando o app e o worker responderem"
function Esperar-Http([string]$url, [int]$esperado, [int]$tentativas) {
    for ($i = 0; $i -lt $tentativas; $i++) {
        $codigo = 0
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0
            $codigo = [int]$r.StatusCode
        } catch {
            if ($null -ne $_.Exception.Response) { $codigo = [int]$_.Exception.Response.StatusCode }
        }
        if ($codigo -eq $esperado) { return $true }
        Start-Sleep -Seconds 5
    }
    return $false
}
if (-not (Esperar-Http "http://localhost:$PortaApp/login" 200 120)) {
    Falha "O app não respondeu 200 em http://localhost:$PortaApp/login. Veja: docker compose -p $Projeto --env-file .env.local logs app"
}
if (-not (Esperar-Http "http://127.0.0.1:$PortaWorker/healthz" 200 60)) {
    Falha "O worker não respondeu em http://127.0.0.1:$PortaWorker/healthz. Veja: docker compose -p $Projeto --env-file .env.local logs worker"
}

$Url = "http://localhost:$PortaApp/signup"
Log "Pronto. Crie sua conta em: $Url"
Log "Crie a SUA conta antes de abrir o CRM para a internet (proxy, túnel, porta pública): a primeira conta vira a dona do servidor, com o console de plataforma."
Log "Portas usadas (projeto $Projeto): app $PortaApp, worker $PortaWorker, Evolution $PortaEvolution, Supabase API $PortaApi, banco $PortaDb"
Log "O envio real de mensagens está DESLIGADO (modo simulado). Veja o README, seção ""Ligar o envio real""."
Log "ATENÇÃO, REDE: o banco do Supabase (porta $PortaDb) aceita conexões da sua rede local com a senha padrão da CLI. Numa rede que não é só sua (Wi-Fi de café, coworking, empresa), qualquer pessoa nela lê e altera todos os dados do CRM, sem conta. Use em rede confiável ou bloqueie as portas $PortaApi e $PortaDb para conexões de entrada (veja o SECURITY.md)."
Log "Para bloquear no Windows (PowerShell como administrador): New-NetFirewallRule -DisplayName 'CRM ALQUIM(IA) Supabase' -Direction Inbound -Protocol TCP -LocalPort $PortaApi,$PortaDb -Action Block"
if ([Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_NAO_ABRIR") -ne "1") {
    try { Start-Process $Url } catch { }
}
