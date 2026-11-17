# Funções de backup e restauração do CRM ALQUIM(IA), separadas de `scripts\backup.ps1` e
# `scripts\restaurar.ps1` para poderem ser EXECUTADAS por teste (tests/unit/backup-restauracao-executavel.test.ts)
# com um `docker` falso. Só define funções: carregar (dot-source) não faz nada. Espelha `lib/backup.sh`.
# Windows PowerShell 5.1: sem encadeamento de comandos, sem ternário, sem coalescência nula. Comandos
# nativos (docker) escrevem progresso no stderr, então o sucesso é conferido por $LASTEXITCODE.
# Todo caminho que vai ao docker é ABSOLUTO ($Raiz): o diretório atual do .NET não acompanha o Set-Location.
#
# O que entra no backup (e o que não entra):
#   - os DADOS do banco do Supabase local (schemas public, auth e storage), por pg_dump DENTRO do contêiner
#     do banco (socket local: nenhuma senha, nenhuma porta, nada de segredo em argumento de processo);
#   - os ARQUIVOS do Storage (mídias, logos, exportações), copiados do contêiner do Storage.
#   Fora: as conexões do WhatsApp (volume da Evolution; é só reconectar o QR) e o .env.local (segredos).

. (Join-Path $PSScriptRoot "instalar-env.ps1")

# O projeto vem do .env.local DESTA pasta (quem carrega esta lib já fez Set-Location para a raiz do CRM).
$script:BackupProjeto = Projeto-DaInstalacao (Join-Path (Get-Location).Path ".env.local")
$script:BackupDb = "supabase_db_" + $script:BackupProjeto
$script:BackupStorage = "supabase_storage_" + $script:BackupProjeto
$script:BackupStorageDir = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_STORAGE_DIR")
if ([string]::IsNullOrWhiteSpace($script:BackupStorageDir)) { $script:BackupStorageDir = "/mnt" }
$script:BackupManter = 14
$script:BackupCriado = ""

function Backup-Log([string]$msg) { Write-Host "==> $msg" }
function Backup-Erro([string]$msg) { Write-Host "ERRO: $msg" -ForegroundColor Red }

# --- Avisos do Postgres: para o log, não para a tela --------------------------------------
# O pg_dump avisa de chaves estrangeiras circulares e a carga da restauração solta um NOTICE por tabela
# esvaziada: centenas de linhas que, na tela, parecem erro e não são. Elas vão para logs\backup.log e
# logs\restaurar.log (na raiz do CRM); na tela ficam o resumo e as linhas de erro de verdade.
$script:BackupAvisos = 0

# Erros-DoPostgres LINHAS: só o que é erro de verdade (ERROR, FATAL, PANIC, "error:" das ferramentas e
# "Error" do docker), com o DETAIL/HINT/CONTEXT que vem logo depois. Igual ao erros_do_postgres do .sh.
function Erros-DoPostgres([string[]]$linhas) {
    $saida = @()
    $segue = $false
    foreach ($l in $linhas) {
        if (($l -cmatch '(ERROR|FATAL|PANIC):') -or ($l -cmatch '(^|[^A-Za-z])error:') -or ($l -cmatch '^Error')) {
            $saida += $l; $segue = $true; continue
        }
        if ($segue -and ($l -cmatch '^(DETAIL|HINT|CONTEXT|LINE [0-9]+):')) { $saida += $l; continue }
        $segue = $false
    }
    return $saida
}

# Sem-DadosDaLinha LINHA: tira os VALORES que o Postgres cita num erro, que podem ser dados pessoais de um
# contato. Ficam a coluna, a tabela, a linha e a causa. Igual ao sem_dados_da_linha do .sh:
#   DETAIL  Key (email)=(...) / Key (lower(email::text))=(...) already exists | is not present | ...
#   DETAIL  Failing row contains (...)
#   CONTEXT COPY tabela, line N[, column c]: "..."   (a carga do backup é COPY: é a linha do contato)
#   ERROR   invalid input syntax for type integer: "..."  /  invalid input value for enum x: "..."
#   ERROR   date/time field value out of range: "..."  /  value "..." is out of range for type integer
#   DETAIL  Token "..." is invalid.  /  CONTEXT JSON data, line N: ...  
function Sem-DadosDaLinha([string]$l) {
    $l = $l -replace '\)=\(.*\) (already exists|is not present in table|is still referenced from table)', ')=(omitido) $1'
    $l = $l -replace '\)=\([^)]*\)', ')=(omitido)'
    $l = $l -replace '(Failing row contains )\(.*\)', '$1(omitido)'
    $l = $l -replace '(COPY [^,]+, line [0-9]+(, column [^:]+)?): .*', '$1: (omitido)'
    $l = $l -replace '(invalid input (syntax|value)[^:]*): ".*"', '$1: "(omitido)"'
    $l = $l -replace '(out of range[^:]*): ".*"', '$1: "(omitido)"'
    $l = $l -replace '(value )".*"( is out of range)', '$1"(omitido)"$2'
    $l = $l -replace '(Token )".*"( is invalid)', '$1"(omitido)"$2'
    return ($l -replace '(JSON data, line [0-9]+): .*', '$1: (omitido)')
}

# Logs: só do dono (como backups\ e o .env.local) a CADA execução, também se a pasta já existia e nos girados
#girados quando passam de 256 KB (guardo os 3 anteriores).
$script:BackupLogMaxBytes = 262144
function Preparar-Log([string]$log) {
    $pasta = Split-Path -Parent $log
    if (-not (Test-Path -LiteralPath $pasta)) { New-Item -ItemType Directory -Force $pasta | Out-Null }
    Restringir-PastaAoDono $pasta
    if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt $script:BackupLogMaxBytes)) {
        if (Test-Path -LiteralPath ($log + ".3")) { Remove-Item -Force -LiteralPath ($log + ".3") }
        foreach ($n in @(2, 1)) {
            if (Test-Path -LiteralPath ($log + "." + $n)) { Move-Item -Force -LiteralPath ($log + "." + $n) -Destination ($log + "." + ($n + 1)) }
        }
        Move-Item -Force -LiteralPath $log -Destination ($log + ".1")
    }
    foreach ($f in @($log, ($log + ".1"), ($log + ".2"), ($log + ".3"))) {
        if (Test-Path -LiteralPath $f) { Restringir-ArquivoAoDono $f }
    }
}

# Rodar-ComLog LOG ROTULO { comando }: roda o comando nativo com a saída (e a de erro) no LOG, acrescentada
# com data e rótulo, e mostra na tela só os erros. Devolve o código de saída; $script:BackupAvisos fica com
# o número de linhas que foram só para o log. (2>&1 de um programa no 5.1 vira ErrorRecord: pega a mensagem.)
# Falhou sem nenhuma linha reconhecível (o docker sem conseguir rodar o programa, ou ele morto por falta de
# memória, código 137): mostra as últimas linhas da saída, ou diz que não houve mensagem.
function Rodar-ComLog([string]$log, [string]$rotulo, [scriptblock]$comando) {
    $ErrorActionPreference = "Continue"
    try { Preparar-Log $log } catch { }
    $linhas = @(& $comando 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { [string]$_.Exception.Message } else { [string]$_ }
    })
    $rc = $LASTEXITCODE
    $cabeca = "### " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $rotulo + " (código " + $rc + ")"
    $paraLog = @($linhas | ForEach-Object { Sem-DadosDaLinha $_ })
    try {
        [System.IO.File]::AppendAllText($log, (((@($cabeca) + $paraLog) -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
    $erros = @(Erros-DoPostgres $linhas)
    $comTexto = @($linhas | Where-Object { $_ -ne "" })
    if ($erros.Count -gt 0) {
        foreach ($e in $erros) { [Console]::Error.WriteLine($e) }
    } elseif ($rc -ne 0) {
        if ($comTexto.Count -gt 0) {
            [Console]::Error.WriteLine("O comando saiu com o código $rc. As últimas linhas da saída de erro:")
            foreach ($e in ($comTexto | Select-Object -Last 15)) { [Console]::Error.WriteLine($e) }
        } else {
            [Console]::Error.WriteLine("O comando saiu com o código $rc, sem nenhuma mensagem (o código 137 costuma ser falta de memória: o processo foi morto).")
        }
    }
    $script:BackupAvisos = $comTexto.Count
    return $rc
}

# --- Impressão da chave de cifra -------------------------------------------------------
# O backup não leva private.app_secrets: os segredos cifrados dele só abrem com a chave da instalação em que
# foi feito. O registro de versão guarda uma IMPRESSÃO da chave (12 hex do sha256, nunca a chave), e a
# restauração compara com a do banco e a do .env.local. Pasta e projeto iguais não provam chave igual.

# Impressao TEXTO: 12 hex do sha256 do texto (vazio se vazio). Igual ao impressao do .sh.
function Impressao([string]$t) {
    if ([string]::IsNullOrEmpty($t)) { return "" }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash((New-Object System.Text.UTF8Encoding($false)).GetBytes($t)) } finally { $sha.Dispose() }
    return (-join ($h | ForEach-Object { $_.ToString("x2") })).Substring(0, 12)
}

# Impressao-DaChaveDoBanco: a impressão da chave de cifra que o banco usa (vazio se não der para ler). A chave
# chega pela saída do psql e não vai a argumento de processo nenhum.
function Impressao-DaChaveDoBanco {
    $saida = (docker exec $script:BackupDb psql -U postgres -d postgres -At -c "select value from private.app_secrets where name = 'nuvemshop_oauth_key'" 2>$null) | Out-String
    if ($LASTEXITCODE -ne 0) { return "" }
    $k = (@($saida -split "`r?`n" | Where-Object { $_ -ne "" }) | Select-Object -First 1)
    $r = Impressao ([string]$k)
    $k = $null; $saida = $null
    return $r
}

# Chave-DoBackupDifere DIR NOME: $true se a impressão da chave gravada no backup falta (backup antigo) ou é
# diferente da do banco ou da do .env.local desta instalação. Decide o lembrete final.
function Chave-DoBackupDifere([string]$dir, [string]$nome) {
    $arquivo = Join-Path $dir ($nome + "-versao.txt")
    if (-not (Test-Path -LiteralPath $arquivo)) { return $true }
    $b = Ler-Campo @(Get-Content -LiteralPath $arquivo) "chave"
    if ($b -eq "") { return $true }
    $d = Impressao-DaChaveDoBanco
    # só a linha da chave, como no Avisar-ChaveDeCifraDivergente (o backup não lê o resto do .env.local)
    $e = ""
    $envLocal = Join-Path (Get-Location).Path ".env.local"
    if (Test-Path -LiteralPath $envLocal) {
        $k = Chave-DoEnvLocal $envLocal
        $e = Impressao $k
        $k = $null
    }
    if (($d -ne "") -and ($d -ne $b)) { return $true }
    if (($e -ne "") -and ($e -ne $b)) { return $true }
    if (($d -eq "") -and ($e -eq "")) { return $true }
    return $false
}

# sha256 do supabase\baseline.sql SEM os bytes \r (o mesmo arquivo dá o mesmo hash num checkout do Windows
# e no Linux; igual ao `tr -d '\r' | sha256sum` do .sh). "ausente" se o arquivo não existir.
function Hash-DoSchema([string]$raiz) {
    $arquivo = Join-Path $raiz "supabase\baseline.sql"
    if (-not (Test-Path -LiteralPath $arquivo)) { return "ausente" }
    $bytes = [System.IO.File]::ReadAllBytes($arquivo)
    $limpo = New-Object System.IO.MemoryStream
    $i = 0
    while ($i -lt $bytes.Length) {
        $j = [Array]::IndexOf($bytes, [byte]13, $i)
        if ($j -lt 0) { $j = $bytes.Length }
        $limpo.Write($bytes, $i, $j - $i)
        $i = $j + 1
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash($limpo.ToArray()) } finally { $sha.Dispose(); $limpo.Dispose() }
    return (-join ($h | ForEach-Object { $_.ToString("x2") }))
}

# current_version de public.system_version (vazio se não houver; é só leitura).
function Versao-Instalada {
    $v = (docker exec $script:BackupDb psql -U postgres -d postgres -At -c "select current_version from public.system_version where id = 1" 2>$null) | Out-String
    if ($LASTEXITCODE -ne 0) { return "" }
    $linhas = @($v -split "`r?`n" | Where-Object { $_ -ne "" })
    if ($linhas.Count -eq 0) { return "" }
    return $linhas[0].Trim()
}

# Só a linha NUVEMSHOP_OAUTH_ENCRYPTION_KEY do .env.local, sem espaços das pontas e um par de aspas (como o
# instalador grava no banco). Não é o leitor geral do .env.local.
function Chave-DoEnvLocal([string]$arquivo) {
    $k = ""
    if (-not (Test-Path -LiteralPath $arquivo)) { return $k }
    foreach ($l in [System.IO.File]::ReadAllLines($arquivo)) {
        if ($l -match '^NUVEMSHOP_OAUTH_ENCRYPTION_KEY=(.*)$') { $k = $Matches[1].Trim() }
    }
    if ($k.Length -ge 2 -and (($k.StartsWith('"') -and $k.EndsWith('"')) -or ($k.StartsWith("'") -and $k.EndsWith("'")))) {
        $k = $k.Substring(1, $k.Length - 2)
    }
    return $k
}

# Avisar-ChaveDeCifraDivergente ARQUIVO_ENV: só AVISA (nunca recusa) quando a chave de cifra do .env.local
# não é a que o banco usa (private.app_secrets) — o caso de quem instalou antes de copiar o .env.local antigo.
# Nenhuma das duas chaves é impressa nem vai no argv: o valor do banco chega pela saída do psql.
function Avisar-ChaveDeCifraDivergente([string]$arquivo) {
    if (-not (Test-Path -LiteralPath $arquivo)) { return }
    $doEnv = Chave-DoEnvLocal $arquivo
    if (-not $doEnv) { return }
    $saida = (docker exec $script:BackupDb psql -U postgres -d postgres -At -c "select value from private.app_secrets where name = 'nuvemshop_oauth_key'" 2>$null) | Out-String
    if ($LASTEXITCODE -ne 0) { $doEnv = $null; return }
    $doBanco = (@($saida -split "`r?`n" | Where-Object { $_ -ne "" }) | Select-Object -First 1)
    if ($doBanco -and ($doBanco.Trim() -cne $doEnv)) {
        [Console]::Error.WriteLine("AVISO: a chave de cifra do .env.local (NUVEMSHOP_OAUTH_ENCRYPTION_KEY) é diferente da que este banco usa. Os segredos cifrados do backup (webhooks, tokens de integração, credencial do Google) só abrem com a chave da instalação em que o backup foi feito. Se este backup veio de outra instalação, cancele agora: ponha o .env.local dela na pasta do CRM ANTES de instalar e restaure de novo. Nenhuma das duas chaves é mostrada.")
    }
    $doEnv = $null
    $doBanco = $null
}

function Ler-Campo([string[]]$linhas, [string]$chave) {
    foreach ($l in $linhas) {
        if ($l.StartsWith($chave + "=")) { return $l.Substring($chave.Length + 1).Trim() }
    }
    return ""
}

# Recusa ($false) backup sem registro de versão ou feito em outra versão do CRM.
function Conferir-VersaoDoBackup([string]$raiz, [string]$dir, [string]$nome) {
    $arquivo = Join-Path $dir ($nome + "-versao.txt")
    if (-not (Test-Path -LiteralPath $arquivo)) {
        Backup-Erro "O backup $nome não tem o registro de versão ($nome-versao.txt): foi feito por uma versão antiga do comando de backup."
        Backup-Erro "Sem saber em que versão do CRM ele foi feito, eu não restauro (restaurar em outra versão pode quebrar o CRM). Nada foi alterado."
        Backup-Erro "O que fazer: escolha um backup mais novo (feito depois desta atualização) ou, se este é o único, peça ajuda antes de restaurar à mão."
        return $false
    }
    $linhas = @(Get-Content -LiteralPath $arquivo)
    $bHash = Ler-Campo $linhas "baseline_sha256"
    $bVer = Ler-Campo $linhas "current_version"
    $aHash = Hash-DoSchema $raiz
    $aVer = Versao-Instalada
    $diferente = ($bHash -eq "") -or ($bHash -eq "ausente") -or ($aHash -eq "ausente") -or ($bHash -ne $aHash)
    if (($bVer -ne "") -and ($aVer -ne "") -and ($bVer -ne $aVer)) { $diferente = $true }
    if ($diferente) {
        $bNum = $bVer
        if ($bNum -eq "") { $bNum = "sem número" }
        $aNum = $aVer
        if ($aNum -eq "") { $aNum = "sem número" }
        $bCurto = $bHash
        if ($bCurto.Length -gt 12) { $bCurto = $bCurto.Substring(0, 12) }
        $aCurto = $aHash
        if ($aCurto.Length -gt 12) { $aCurto = $aCurto.Substring(0, 12) }
        Backup-Erro "O backup $nome foi feito com outra versão do CRM (backup: $bNum, esquema $bCurto; instalado agora: $aNum, esquema $aCurto)."
        Backup-Erro "Restaurar dados de uma versão em outra pode quebrar o CRM, então eu não restauro. Nada foi alterado."
        Backup-Erro "O que fazer: volte o código do CRM para a versão do backup, rode o instalar (scripts\instalar.ps1), restaure, e só depois atualize de novo. Ou escolha um backup feito nesta versão."
        return $false
    }
    return $true
}

# Apaga trabalho interrompido (.parcial-*, .restaurando-*) com mais de 1 dia; mais novo pode estar rodando agora.
function Limpar-Sobras([string]$dir) {
    if (-not (Test-Path -LiteralPath $dir)) { return }
    $limite = (Get-Date).AddDays(-1)
    foreach ($d in (Get-ChildItem -LiteralPath $dir -Force)) {
        if ((($d.Name -like ".parcial-*") -or ($d.Name -like ".restaurando-*")) -and ($d.LastWriteTime -lt $limite)) {
            Remove-Item -Recurse -Force -LiteralPath $d.FullName -ErrorAction SilentlyContinue
        }
    }
}

# Pasta dos backups: CRM_ALQUIMIA_BACKUP_DIR (relativa à raiz do projeto, ou absoluta) ou "backups".
function Pasta-DeBackups([string]$raiz) {
    $v = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_BACKUP_DIR")
    if ([string]::IsNullOrWhiteSpace($v)) { $v = "backups" }
    if ([System.IO.Path]::IsPathRooted($v)) { return $v }
    return (Join-Path $raiz $v)
}

# Docker de pé, contêineres do Supabase no ar e banco aceitando conexão. Devolve $true/$false.
# CRM_ALQUIMIA_STORAGE_DIR é um caminho absoluto simples (vai a um `sh -c` dentro do contêiner do Storage, na
# limpeza da restauração): nada de espaço, ; $ ` nem a raiz sozinha.
function Storage-DirValido {
    if ($script:BackupStorageDir -cnotmatch '^/[A-Za-z0-9._/-]*[A-Za-z0-9._-][A-Za-z0-9._/-]*$') { return $false }
    # nenhum segmento . ou .. (rm -rf '/mnt/..'/* seria rm -rf /* dentro do contêiner)
    return (($script:BackupStorageDir + "/") -notmatch '/\.\.?/')
}

function Conferir-AmbienteDocker {
    if (-not (Storage-DirValido)) {
        Backup-Erro ("CRM_ALQUIMIA_STORAGE_DIR=" + $script:BackupStorageDir + " não é um caminho válido (use um caminho absoluto só com letras, números, . _ - e /, como /mnt). Nada foi alterado.")
        return $false
    }
    if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
        Backup-Erro "Docker não encontrado. Instale o Docker Desktop (https://www.docker.com/products/docker-desktop) e abra-o."
        return $false
    }
    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Backup-Erro "O Docker está instalado mas não está rodando. Abra o Docker Desktop, espere ele ficar verde e rode de novo."
        return $false
    }
    foreach ($c in @($script:BackupDb, $script:BackupStorage)) {
        $rodando = (docker inspect -f "{{.State.Running}}" $c 2>$null) | Out-String
        if ($rodando.Trim() -ne "true") {
            Backup-Erro "O Supabase local não está no ar (o contêiner $c está parado ou não existe). Suba o CRM com: scripts\instalar.ps1"
            return $false
        }
    }
    docker exec $script:BackupDb pg_isready -U postgres *> $null
    if ($LASTEXITCODE -ne 0) {
        Backup-Erro "O banco ainda não está aceitando conexões. Espere um minuto e rode de novo; se persistir, rode: scripts\instalar.ps1"
        return $false
    }
    return $true
}

# Nomes (sem .sql.gz) dos backups completos, do MAIS VELHO ao mais novo.
function Listar-Backups([string]$dir) {
    $itens = @()
    if (Test-Path -LiteralPath $dir) {
        foreach ($f in (Get-ChildItem -LiteralPath $dir -File)) {
            if ($f.Name -match '^(\d{4}-\d{2}-\d{2}-\d{4})(?:-(\d+))?\.sql\.gz$') {
                $n = 0
                if ($Matches.ContainsKey(2)) { $n = [int]$Matches[2] }
                $itens += [pscustomobject]@{ Nome = $f.Name.Substring(0, $f.Name.Length - 7); Data = $Matches[1]; N = $n }
            }
        }
    }
    $ordenados = @($itens | Sort-Object @{ Expression = { $_.Data } }, @{ Expression = { $_.N } })
    $nomes = @()
    foreach ($o in $ordenados) { $nomes += $o.Nome }
    return $nomes
}

# O que há na pasta e NÃO é peça de backup (backup, -storage, -versao.txt, trabalho parcial, a trava).
function Estranhos-NaPasta([string]$dir) {
    $estranhos = @()
    if (-not (Test-Path -LiteralPath $dir)) { return $estranhos }
    foreach ($item in (Get-ChildItem -LiteralPath $dir -Force)) {
        if ($item.Name -match '^(desktop\.ini|\.ds_store|thumbs\.db|lost\+found)$') { continue }
        if ($item.Name -notmatch '^(\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?(\.sql\.gz|-storage|-versao\.txt)|\.parcial-.*|\.restaurando-.*|\.trava-backup.*)$') {
            $estranhos += $item.Name
        }
    }
    return $estranhos
}

# Cria (se faltar) a pasta e a restringe ao dono; a ACL herdável protege o que nascer dentro. A ACL é TROCADA
# (só o dono, e os arquivos de dentro herdam isso), então a pasta tem de ser só dos backups. Pasta escolhida em
# CRM_ALQUIMIA_BACKUP_DIR (pode ser uma pasta do usuário, compartilhada) com outros arquivos: recusa sem mexer
# nela. Na pasta padrão (backups\, dentro do próprio CRM): avisa e segue.
function Preparar-PastaDeBackups([string]$dir) {
    $estranhos = @(Estranhos-NaPasta $dir)
    if ($estranhos.Count -gt 0) {
        $exemplos = (($estranhos | Select-Object -First 3) -join " ")
        if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_BACKUP_DIR"))) {
            Backup-Erro ("A pasta de backups " + $dir + " (CRM_ALQUIMIA_BACKUP_DIR) já tem outros arquivos (por exemplo: " + $exemplos + ").")
            Backup-Erro "Ela precisa ser só dos backups: eu deixo a pasta acessível apenas ao seu usuário, e isso mudaria as permissões desses arquivos. Nada foi alterado. Escolha uma pasta vazia (ou nova) em CRM_ALQUIMIA_BACKUP_DIR."
            return $false
        }
        Escrever-Aviso ("a pasta " + $dir + " tem arquivos que não são backups (por exemplo: " + $exemplos + "). Ela fica acessível só ao seu usuário; guarde outras coisas em outro lugar.")
    } elseif ((-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_BACKUP_DIR"))) -and (Test-Path -LiteralPath $dir)) {
        $conteudo = @(Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.Name -notmatch '^(desktop\.ini|\.ds_store|thumbs\.db|lost\+found)$' })
        if ($conteudo.Count -eq 0) {
            Escrever-Aviso ("a pasta " + $dir + " já existia; daqui em diante ela fica acessível só ao seu usuário e deve guardar só os backups.")
        }
    }
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    Restringir-PastaAoDono $dir
    return $true
}

# Um backup por vez na mesma pasta (o de segurança da restauração também): a trava é uma pasta (a mesma do
# .sh). Trava com mais de 2 h é de um backup que morreu no meio: é quebrada.
function Trava-Velha([string]$caminho) {
    $item = Get-Item -LiteralPath $caminho -Force -ErrorAction SilentlyContinue
    return (($null -ne $item) -and ($item.LastWriteTime -lt (Get-Date).AddHours(-2)))
}
function Pegar-TravaDeBackup([string]$dir) {
    $trava = Join-Path $dir ".trava-backup"
    $marca = Join-Path $dir ".trava-backup.quebrando"
    if (-not (Test-Path -LiteralPath $trava)) {
        try {
            New-Item -ItemType Directory -Path $trava -ErrorAction Stop | Out-Null
            return $true
        } catch { }
    }
    if (Trava-Velha $trava) {
        # Só um processo por vez quebra a trava: a marca nasce com CreateNew, que é atômico (o mesmo nome que o
        # .sh usa). Quem a criou confere a idade de novo (outro pode ter acabado de quebrar e tomar uma trava
        # nova) e só então apaga. Marca abandonada com mais de 10 min sai do caminho.
        $m = Get-Item -LiteralPath $marca -Force -ErrorAction SilentlyContinue
        if (($null -ne $m) -and ($m.LastWriteTime -lt (Get-Date).AddMinutes(-10))) {
            Remove-Item -Force -LiteralPath $marca -ErrorAction SilentlyContinue
        }
        $temMarca = $true
        try { ([System.IO.File]::Open($marca, [System.IO.FileMode]::CreateNew)).Dispose() } catch { $temMarca = $false }
        if ($temMarca) {
            try {
                if (Trava-Velha $trava) {
                    Remove-Item -Recurse -Force -LiteralPath $trava -ErrorAction SilentlyContinue
                    Backup-Log "Achei uma trava de backup com mais de 2 horas (de um backup que não terminou); vou ignorá-la"
                    try {
                        New-Item -ItemType Directory -Path $trava -ErrorAction Stop | Out-Null
                        return $true
                    } catch { }
                }
            } finally {
                Remove-Item -Force -LiteralPath $marca -ErrorAction SilentlyContinue
            }
        }
    }
    Backup-Erro ("Outro backup (ou uma restauração) está rodando agora nesta pasta (" + $dir + "). Espere ele terminar e rode de novo. Nada foi alterado.")
    Backup-Erro ("Se tem certeza de que nenhum backup ou restauração está rodando (por exemplo, o computador desligou no meio de um), apague a pasta " + $trava + " e rode de novo. Depois de 2 horas ela é ignorada sozinha.")
    return $false
}
# Marca que o backup segue vivo (um backup longo não pode ter a trava tida como velha).
function Renovar-Trava([string]$dir) {
    $trava = Join-Path $dir ".trava-backup"
    try { (Get-Item -LiteralPath $trava -Force).LastWriteTime = Get-Date } catch { }
}
function Soltar-TravaDeBackup([string]$dir) {
    $trava = Join-Path $dir ".trava-backup"
    if (Test-Path -LiteralPath $trava) { Remove-Item -Recurse -Force -LiteralPath $trava -ErrorAction SilentlyContinue }
}

function Comprimir-Arquivo([string]$origem, [string]$destino) {
    $entrada = [System.IO.File]::OpenRead($origem)
    $saida = [System.IO.File]::Create($destino)
    $gz = New-Object System.IO.Compression.GZipStream($saida, [System.IO.Compression.CompressionMode]::Compress)
    try { $entrada.CopyTo($gz) } finally { $gz.Dispose(); $saida.Dispose(); $entrada.Dispose() }
}

function Descomprimir-Arquivo([string]$origem, [string]$destino) {
    $entrada = [System.IO.File]::OpenRead($origem)
    $gz = New-Object System.IO.Compression.GZipStream($entrada, [System.IO.Compression.CompressionMode]::Decompress)
    $saida = [System.IO.File]::Create($destino)
    try { $gz.CopyTo($saida) } finally { $saida.Dispose(); $gz.Dispose(); $entrada.Dispose() }
}

# O .sql.gz existe e é um gzip íntegro.
function Backup-Integro([string]$dir, [string]$nome) {
    $arquivo = Join-Path $dir ($nome + ".sql.gz")
    if (-not (Test-Path -LiteralPath $arquivo)) { return $false }
    try {
        $entrada = [System.IO.File]::OpenRead($arquivo)
        $gz = New-Object System.IO.Compression.GZipStream($entrada, [System.IO.Compression.CompressionMode]::Decompress)
        try { $gz.CopyTo([System.IO.Stream]::Null) } finally { $gz.Dispose(); $entrada.Dispose() }
        return $true
    } catch {
        return $false
    }
}

# Grava DIR\AAAA-MM-DD-HHMM.sql.gz, DIR\AAAA-MM-DD-HHMM-storage\ e DIR\AAAA-MM-DD-HHMM-versao.txt (sha256 do
# schema e versão instalada). O nome fica em $script:BackupCriado, e SÓ depois de conferir que as três peças
# existem no lugar final (o .sql.gz é o último a ser movido). NÃO aplica retenção.
function Criar-Backup([string]$dir, [string]$raiz) {
    $script:BackupCriado = ""
    if (-not (Preparar-PastaDeBackups $dir)) { return $false }
    if (-not (Pegar-TravaDeBackup $dir)) { return $false }
    $script:BackupParcial = ""
    try {
        return (Criar-BackupComTrava $dir $raiz)
    } finally {
        # Também num Ctrl+C ou erro que escapa: o trabalho parcial (tem o dump do banco) não fica para trás.
        if (($script:BackupParcial -ne "") -and (Test-Path -LiteralPath $script:BackupParcial)) {
            Remove-Item -Recurse -Force -LiteralPath $script:BackupParcial -ErrorAction SilentlyContinue
        }
        $script:BackupParcial = ""
        Soltar-TravaDeBackup $dir
    }
}

# O trabalho do Criar-Backup, com a pasta pronta e a trava já tomada.
function Criar-BackupComTrava([string]$dir, [string]$raiz) {
    $base = Get-Date -Format "yyyy-MM-dd-HHmm"
    $nome = $base
    $n = 1
    while ((Test-Path -LiteralPath (Join-Path $dir ($nome + ".sql.gz"))) -or (Test-Path -LiteralPath (Join-Path $dir ($nome + "-storage"))) -or (Test-Path -LiteralPath (Join-Path $dir ($nome + "-versao.txt")))) {
        $n++; $nome = "$base-$n"
    }
    $tmp = Join-Path $dir (".parcial-" + $nome)
    $script:BackupParcial = $tmp
    if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp }
    New-Item -ItemType Directory -Force (Join-Path $tmp "storage") | Out-Null
    $banco = Join-Path $tmp "banco.sql"
    # nome único no contêiner: dois backups ao mesmo tempo não se pisam
    $dump = "/tmp/crm-backup-" + $nome + ".sql"

    Backup-Log "Copiando o banco de dados"
    $logBackup = Join-Path $raiz "logs\backup.log"
    $rcDump = Rodar-ComLog $logBackup ("pg_dump " + $nome) {
        docker exec $script:BackupDb pg_dump -U postgres -d postgres --data-only --no-owner --no-privileges --schema=public --schema=auth --schema=storage --exclude-table-data=auth.schema_migrations --exclude-table-data=storage.migrations -f $dump
    }
    if ($rcDump -ne 0) {
        Backup-Erro "O pg_dump falhou (veja o erro acima; o registro completo está em logs\backup.log). Nenhum backup foi criado."
        Remove-Item -Recurse -Force -LiteralPath $tmp
        return $false
    }
    if ($script:BackupAvisos -gt 0) {
        Backup-Log ("O pg_dump deixou " + $script:BackupAvisos + " linhas de aviso (normais, não são erro) em logs\backup.log")
    }
    docker cp ($script:BackupDb + ":" + $dump) $banco | Out-Null
    $codigoCp = $LASTEXITCODE
    docker exec $script:BackupDb rm -f $dump *> $null
    if ($codigoCp -ne 0) {
        Backup-Erro "Não consegui tirar a cópia do banco de dentro do Docker. Nenhum backup foi criado."
        Remove-Item -Recurse -Force -LiteralPath $tmp
        return $false
    }
    if ((-not (Test-Path -LiteralPath $banco)) -or ((Get-Item -LiteralPath $banco).Length -eq 0)) {
        Backup-Erro "A cópia do banco saiu vazia. Nenhum backup foi criado."
        Remove-Item -Recurse -Force -LiteralPath $tmp
        return $false
    }

    Renovar-Trava $dir
    Backup-Log "Copiando os arquivos (Storage)"
    docker cp ($script:BackupStorage + ":" + $script:BackupStorageDir + "/.") ((Join-Path $tmp "storage") + "\.") | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Backup-Erro ("Não consegui copiar os arquivos do Storage (" + $script:BackupStorageDir + " no contêiner " + $script:BackupStorage + "). Nenhum backup foi criado.")
        Remove-Item -Recurse -Force -LiteralPath $tmp
        return $false
    }

    $finalGz = Join-Path $dir ($nome + ".sql.gz")
    $finalStorage = Join-Path $dir ($nome + "-storage")
    $finalVersao = Join-Path $dir ($nome + "-versao.txt")
    try {
        Comprimir-Arquivo $banco (Join-Path $tmp "banco.sql.gz")
        $versao = "baseline_sha256=" + (Hash-DoSchema $raiz) + "`ncurrent_version=" + (Versao-Instalada) + "`nchave=" + (Impressao-DaChaveDoBanco) + "`n"
        [System.IO.File]::WriteAllText((Join-Path $tmp "versao.txt"), $versao, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Backup-Erro "Falha ao compactar o banco ou gravar o registro de versão. Nenhum backup foi criado."
        Remove-Item -Recurse -Force -LiteralPath $tmp
        return $false
    }
    Remove-Item -Force -LiteralPath $banco
    $movido = $true
    try {
        Move-Item -LiteralPath (Join-Path $tmp "storage") -Destination $finalStorage -ErrorAction Stop
        Move-Item -LiteralPath (Join-Path $tmp "versao.txt") -Destination $finalVersao -ErrorAction Stop
        Move-Item -LiteralPath (Join-Path $tmp "banco.sql.gz") -Destination $finalGz -ErrorAction Stop
    } catch {
        $movido = $false
        Backup-Erro ("Não consegui pôr o backup no lugar final em " + $dir + " (" + $_.Exception.Message + "). Nenhum backup foi criado.")
    }
    $completo = $movido -and (Test-Path -LiteralPath $finalGz -PathType Leaf) -and (Test-Path -LiteralPath $finalStorage -PathType Container) -and (Test-Path -LiteralPath $finalVersao -PathType Leaf)
    if ($completo) { $completo = ((Get-Item -LiteralPath $finalGz).Length -gt 0) }
    if (-not $completo) {
        if ($movido) { Backup-Erro "O backup não ficou completo (falta o banco, os arquivos ou o registro de versão). Nenhum backup foi criado." }
        foreach ($sobra in @($finalStorage, $finalVersao, $finalGz, $tmp)) {
            if (Test-Path -LiteralPath $sobra) { Remove-Item -Recurse -Force -LiteralPath $sobra -ErrorAction SilentlyContinue }
        }
        return $false
    }
    Remove-Item -Recurse -Force -LiteralPath $tmp
    $script:BackupCriado = $nome
    return $true
}

# Apaga os backups mais velhos, deixando só os $manter mais novos. Nunca apaga $atual (o recém-criado).
function Aplicar-Retencao([string]$dir, [int]$manter, [string]$atual) {
    Limpar-Sobras $dir
    $todos = @(Listar-Backups $dir)
    if ($todos.Count -le $manter) { return }
    $apagar = $todos.Count - $manter
    for ($i = 0; $i -lt $apagar; $i++) {
        $velho = $todos[$i]
        if ($velho -eq $atual) { continue }
        Remove-Item -Force -LiteralPath (Join-Path $dir ($velho + ".sql.gz"))
        $versaoVelha = Join-Path $dir ($velho + "-versao.txt")
        if (Test-Path -LiteralPath $versaoVelha) { Remove-Item -Force -LiteralPath $versaoVelha }
        $pasta = Join-Path $dir ($velho + "-storage")
        if (Test-Path -LiteralPath $pasta) { Remove-Item -Recurse -Force -LiteralPath $pasta }
        Backup-Log "Backup antigo apagado (guardo só os $manter mais novos): $velho"
    }
}

# Carrega o banco (numa transação só: erro = nada muda) e depois os arquivos do Storage. Pré-requisitos
# (Docker de pé, backup íntegro, confirmação, backup do estado atual) são do chamador. Devolve 0 (ok),
# 1 (o banco falhou: nada mudou) ou 2 (o banco foi restaurado mas o Storage não).
function Restaurar-DoBackup([string]$raiz, [string]$dir, [string]$nome) {
    $prelude = Join-Path $raiz "scripts\restaurar-preludio.sql"
    $tmp = Join-Path $dir (".restaurando-" + $PID)
    if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp }
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $dados = Join-Path $tmp "dados.sql"

    Backup-Log "Restaurando o banco de dados"
    try {
        Descomprimir-Arquivo (Join-Path $dir ($nome + ".sql.gz")) $dados
    } catch {
        Backup-Erro "Não consegui descompactar o backup."
        Remove-Item -Recurse -Force -LiteralPath $tmp
        return 1
    }
    docker cp $prelude ($script:BackupDb + ":/tmp/crm-prelude.sql") | Out-Null
    $c1 = $LASTEXITCODE
    docker cp $dados ($script:BackupDb + ":/tmp/crm-restaurar.sql") | Out-Null
    $c2 = $LASTEXITCODE
    Remove-Item -Recurse -Force -LiteralPath $tmp
    if (($c1 -ne 0) -or ($c2 -ne 0)) {
        Backup-Erro "Não consegui enviar o backup para dentro do Docker."
        return 1
    }
    # Como supabase_admin (o dono das tabelas e sequências de auth.* e storage.*): como postgres, o TRUNCATE
    # ... RESTART IDENTITY do prelúdio dá "must be owner of sequence refresh_tokens_id_seq" e a restauração
    # nunca acontece. Pelo socket de dentro do contêiner, sem senha.
    $rc = Rodar-ComLog (Join-Path $raiz "logs\restaurar.log") ("restaurar " + $nome) {
        docker exec $script:BackupDb psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -q -f /tmp/crm-prelude.sql -f /tmp/crm-restaurar.sql
    }
    docker exec $script:BackupDb rm -f /tmp/crm-prelude.sql /tmp/crm-restaurar.sql *> $null
    if ($rc -ne 0) {
        Backup-Erro "A restauração do banco falhou e foi DESFEITA: o banco continua como estava antes. O erro está acima; o registro completo, em logs\restaurar.log."
        return 1
    }
    if ($script:BackupAvisos -gt 0) {
        Backup-Log ("A carga deixou " + $script:BackupAvisos + " linhas de aviso do Postgres (normais, não são erro) em logs\restaurar.log")
    }

    $pastaStorage = Join-Path $dir ($nome + "-storage")
    if (Test-Path -LiteralPath $pastaStorage) {
        Backup-Log "Restaurando os arquivos (Storage): apago os arquivos de agora e copio os do backup"
        if (-not $script:BackupStorageDir.StartsWith("/") -or $script:BackupStorageDir.Length -lt 2) {
            Backup-Erro ("CRM_ALQUIMIA_STORAGE_DIR inválido: " + $script:BackupStorageDir)
            return 2
        }
        $limpar = "rm -rf '" + $script:BackupStorageDir + "'/* '" + $script:BackupStorageDir + "'/.[!.]*"
        docker exec $script:BackupStorage sh -c $limpar *> $null
        docker cp ($pastaStorage + "\.") ($script:BackupStorage + ":" + $script:BackupStorageDir + "/") | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Backup-Erro "O banco foi restaurado, mas não consegui devolver os arquivos do Storage."
            return 2
        }
    } else {
        Backup-Log "Este backup não tem pasta de arquivos (Storage): os arquivos atuais ficam como estão"
    }
    return 0
}
