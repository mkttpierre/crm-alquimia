# Funções do instalador que mexem no .env.local e no supabase\config.toml, separadas do
# `scripts\instalar.ps1` para poderem ser EXECUTADAS por teste num diretório temporário, sem Docker.
# Só define funções: carregar (dot-source) não faz nada. Windows PowerShell 5.1: sem encadeamento
# de comandos, sem ternário, sem coalescência nula.

$script:Utf8SemBomEnv = New-Object System.Text.UTF8Encoding($false)

function Ler-LinhasDoEnv([string]$arquivo) {
    if (-not (Test-Path $arquivo)) { return @() }
    return [System.IO.File]::ReadAllLines($arquivo, $script:Utf8SemBomEnv)
}

# Imprime o valor de CHAVE no arquivo (vazio se não houver), sem os espaços das pontas e sem um par de aspas
# em volta (igual ao valor_do_env do .sh; o \r de um CRLF o ReadAllLines já tira).
function Valor-DoEnv([string]$arquivo, [string]$chave) {
    foreach ($l in (Ler-LinhasDoEnv $arquivo)) {
        if ($l.StartsWith($chave + "=")) {
            $v = $l.Substring($chave.Length + 1).Trim()
            if (($v.Length -ge 2) -and ((($v[0] -eq '"') -and ($v[$v.Length - 1] -eq '"')) -or (($v[0] -eq "'") -and ($v[$v.Length - 1] -eq "'")))) {
                $v = $v.Substring(1, $v.Length - 2)
            }
            return $v
        }
    }
    return ""
}

# Escreve um aviso visível (stdout), sem derrubar o script.
function Escrever-Aviso([string]$mensagem) {
    Write-Host "AVISO: $mensagem" -ForegroundColor Yellow
}

# Só o dono lê: remove a herança de permissões e concede ao usuário atual a permissão pedida
# (padrão leitura, escrita e APAGAR; para pasta use "(OI)(CI)F"). Sem o D, numa pasta em que o usuário não
# tem "apagar filhos" (uma pasta criada em C:\, por exemplo), nem o dono conseguia apagar o .env.local pelo
# Explorer ou com Remove-Item. O D não abre o arquivo a mais ninguém. Se o icacls falhar (volume sem ACL, por exemplo),
# o script segue, mas AVISA: um arquivo de segredos legível por outros usuários não pode passar em silêncio.
function Restringir-ArquivoAoDono([string]$arquivo, [string]$permissao = "(R,W,D)") {
    $falhou = $false
    try {
        $usuario = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        # /reset primeiro: tira as ACEs EXPLÍCITAS que já existiam (ex.: "Todos" dado à mão), que o
        # /inheritance:r sozinho não remove; depois corta a herança e deixa só o dono.
        icacls $arquivo /reset *> $null
        if ($LASTEXITCODE -ne 0) { $falhou = $true }
        icacls $arquivo /inheritance:r /grant:r ($usuario + ":" + $permissao) *> $null
        if ($LASTEXITCODE -ne 0) { $falhou = $true }
    } catch { $falhou = $true }
    if ($falhou) {
        Escrever-Aviso "não consegui restringir as permissões de $arquivo com o icacls; confira que só o seu usuário do Windows acessa esse arquivo."
    }
}

# Pasta só do dono, com herança para tudo que nascer dentro dela (inclusive o que o docker cp gravar).
function Restringir-PastaAoDono([string]$pasta) {
    Restringir-ArquivoAoDono $pasta "(OI)(CI)F"
}

# Definir-NoEnv ARQUIVO CHAVE VALOR sempre|se_vazio
#   sempre   : atualiza (ou acrescenta) a chave; para o que é derivado (URLs, portas, chaves do Supabase).
#   se_vazio : só grava se ainda não houver valor; para segredos, que não mudam na reinstalação.
function Definir-NoEnv([string]$arquivo, [string]$chave, [string]$valor, [string]$modo) {
    $linhas = New-Object System.Collections.Generic.List[string]
    foreach ($l in (Ler-LinhasDoEnv $arquivo)) { $linhas.Add($l) }
    $achou = $false
    for ($i = 0; $i -lt $linhas.Count; $i++) {
        if ($linhas[$i].StartsWith($chave + "=")) {
            $achou = $true
            $atual = $linhas[$i].Substring($chave.Length + 1)
            if ($atual -ne "" -and $modo -eq "se_vazio") { return }
            $linhas[$i] = "$chave=$valor"
            break
        }
    }
    if (-not $achou) { $linhas.Add("$chave=$valor") }
    $novo = !(Test-Path $arquivo)
    [System.IO.File]::WriteAllText($arquivo, (($linhas -join "`n") + "`n"), $script:Utf8SemBomEnv)
    if ($novo) { Restringir-ArquivoAoDono $arquivo }
}

# Porta-Resolvida ARQUIVO NOME_DA_VARIAVEL PADRAO. Precedência: variável do ambiente, depois o que já
# está gravado no .env.local, depois o padrão. É isso que mantém a porta escolhida na primeira vez
# quando o instalador roda de novo SEM a variável. Valor que não for porta (1 a 65535) lança erro.
function Porta-Resolvida([string]$arquivo, [string]$nome, [string]$padrao) {
    $valor = [Environment]::GetEnvironmentVariable($nome)
    if ([string]::IsNullOrWhiteSpace($valor)) { $valor = Valor-DoEnv $arquivo $nome }
    if ([string]::IsNullOrWhiteSpace($valor)) { $valor = $padrao }
    $valor = $valor.Trim()
    $numero = 0
    if (-not [int]::TryParse($valor, [ref]$numero) -or $numero -lt 1 -or $numero -gt 65535) {
        throw "ERRO: $nome=$valor não é um número de porta (1 a 65535)."
    }
    return [string]$numero
}

# --- Rodar ao lado de outro sistema ----------------------------------------------------------------
# Versão da CLI do Supabase testada com este CRM (nunca "a mais nova": outra versão baixa outras imagens,
# de GBs, e pode ligar serviços que esta não liga). E o que o `start` não sobe porque o CRM não usa.
$script:SupabaseCliVersao = "2.120.0"
$script:SupabaseServicosFora = "imgproxy,studio,postgres-meta,mailpit"
$script:ProjetoPadrao = "crm-alquimia"
# A pasta desta lib (o portas-em-uso.mjs mora ao lado).
$script:LibInstalar = $PSScriptRoot

# Programa-Nativo NOME: o executável de verdade (.cmd, .exe) por trás de um nome sem caminho nem extensão.
# No Windows o Node instala npx.ps1 ao lado do npx.cmd, e o PowerShell prefere o .ps1. Chamado de dentro de
# uma função, o npx.ps1 remonta a linha a partir do TEXTO da chamada e perde os argumentos que vieram por
# splatting: `supabase status` virava `supabase` (ajuda, código 0) e o instalador dizia "Supabase já está
# rodando" numa máquina limpa. -CommandType Application não devolve scripts .ps1.
# Escolhe pela EXTENSÃO, nunca pela ordem do Get-Command: o Node também instala um `npx` sem extensão (script
# de shell), que o Get-Command lista como aplicativo e que o Windows não executa. Achou só o .ps1: falha alto,
# porque voltar a ele traria o B1 de volta calado.
$script:ExtensoesNativas = @(".exe", ".cmd", ".bat", ".com")
function Programa-Nativo([string]$nome) {
    if (($nome -match '[\\/]') -or ([System.IO.Path]::GetExtension($nome) -ne "")) { return $nome }
    foreach ($app in @(Get-Command $nome -CommandType Application -All -ErrorAction SilentlyContinue)) {
        if ($script:ExtensoesNativas -contains ([System.IO.Path]::GetExtension($app.Source).ToLowerInvariant())) { return $app.Source }
    }
    $script1 = @(Get-Command $nome -CommandType ExternalScript -All -ErrorAction SilentlyContinue) | Select-Object -First 1
    if ($null -ne $script1) {
        throw ("Só achei o " + $script1.Source + " (um script do PowerShell). Chamado pelo instalador, ele perde os argumentos e o 'supabase status' viraria sempre sucesso. Reinstale o Node pelo instalador oficial (ele traz o " + $nome + ".cmd) ou defina CRM_ALQUIMIA_SUPABASE_CLI com o caminho de um " + $nome + ".cmd ou .exe.")
    }
    return $nome
}

# Supabase-Cli: @(programa, argumentos fixos...) da CLI do Supabase (CRM_ALQUIMIA_SUPABASE_CLI, ou o npx
# na versão testada). O programa já vem resolvido para o executável (npx.cmd, nunca o npx.ps1).
function Supabase-Cli {
    $custom = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_SUPABASE_CLI")
    if (-not [string]::IsNullOrWhiteSpace($custom)) {
        $partes = @($custom.Split(" ", [StringSplitOptions]::RemoveEmptyEntries))
        $partes[0] = Programa-Nativo $partes[0]
        return ,$partes
    }
    return ,@((Programa-Nativo "npx"), "--yes", ("supabase@" + $script:SupabaseCliVersao))
}

function Projeto-Valido([string]$nome) {
    return ($nome -cmatch '^[a-z0-9][a-z0-9_-]{0,39}$')
}

# Projeto-Resolvido ARQUIVO: nome do projeto para o INSTALADOR. CRM_ALQUIMIA_PROJETO, depois o .env.local,
# depois o padrão. É o -p do compose, o project_id do Supabase e o sufixo dos contêineres dele. Lança erro
# se o nome não for válido.
function Projeto-Resolvido([string]$arquivo) {
    $valor = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_PROJETO")
    if ([string]::IsNullOrWhiteSpace($valor)) { $valor = Valor-DoEnv $arquivo "CRM_ALQUIMIA_PROJETO" }
    if ([string]::IsNullOrWhiteSpace($valor)) { $valor = $script:ProjetoPadrao }
    if (-not (Projeto-Valido $valor)) {
        throw "CRM_ALQUIMIA_PROJETO=$valor não é um nome de projeto válido (use letras minúsculas, números, - e _; até 40)."
    }
    return $valor
}

# Projeto-DaInstalacao ARQUIVO: nome do projeto para parar, backup e restaurar. Vem SÓ do .env.local desta
# pasta (padrão se não houver): uma variável esquecida na sessão não pode redirecioná-los.
function Projeto-DaInstalacao([string]$arquivo) {
    $valor = Valor-DoEnv $arquivo "CRM_ALQUIMIA_PROJETO"
    if ((-not [string]::IsNullOrWhiteSpace($valor)) -and (Projeto-Valido $valor)) { return $valor }
    return $script:ProjetoPadrao
}

# Compose-Crm PROJETO ARGS...: o `docker compose` DESTE CRM, sempre com o projeto e o arquivo explícitos.
# Sem -p/-f, um COMPOSE_PROJECT_NAME ou COMPOSE_FILE esquecido na sessão faria down/stop em OUTRO projeto
# da máquina. Roda na raiz do CRM (todos os scripts fazem Set-Location para lá).
function Compose-Crm {
    $projeto = $args[0]
    $resto = @()
    if ($args.Count -gt 1) { $resto = $args[1..($args.Count - 1)] }
    docker compose -p $projeto -f docker-compose.yml --env-file .env.local @resto
}

# Portas-ExtrasDoConfig ARQUIVO PORTA_DB: portas de serviço do Supabase LIGADO no config.toml além da API e
# do banco (Studio, e-mail de teste, pooler, analytics), como "[secao]=porta". O pooler segue o banco (+7).
function Portas-ExtrasDoConfig([string]$arquivo, [string]$db) {
    $saida = @()
    $secao = ""; $ligado = $false; $porta = ""; $interessa = $false
    $linhas = @([System.IO.File]::ReadAllLines($arquivo, $script:Utf8SemBomEnv)) + @("[fim]")
    foreach ($linha in $linhas) {
        if ($linha -match '^\[') {
            if ($interessa -and $ligado -and $porta -ne "") { $saida += ($secao + "=" + $porta) }
            $secao = $linha.Trim(); $ligado = $false; $porta = ""
            $interessa = @("[studio]", "[inbucket]", "[db.pooler]", "[analytics]") -contains $secao
            continue
        }
        if ($interessa -and $linha -match '^enabled\s*=\s*true') { $ligado = $true }
        if ($interessa -and $linha -match '^port\s*=\s*(\d+)') {
            $porta = $Matches[1]
            if ($secao -eq "[db.pooler]") { $porta = [string]([int]$db + 7) }
        }
    }
    return $saida
}

# Porta-DoProjeto PROJETO NOMES: os contêineres que publicam a porta são DESTE projeto? Compose:
# PROJETO-<serviço>-N; CLI do Supabase: supabase_<serviço>_PROJETO. Nome exato (o projeto "crm" não é
# dono do contêiner do app de "crm-alquimia").
# Ser do mesmo NOME de projeto não basta: um segundo clone com o nome padrão, noutra pasta, usaria (e
# estragaria) os contêineres e volumes da primeira instalação. Dono é: contêiner do compose
# PROJETO-<serviço>-N cujo label com.docker.compose.project.working_dir é ESTA pasta; ou contêiner da CLI do
# Supabase supabase_<serviço>_PROJETO, se ESTA pasta já tem um .env.local desse projeto e não há contêiner do
# compose desse projeto vindo de outra pasta (a CLI não grava a pasta).
$script:ServicosDoCompose = "app|worker|scheduler|evolution|evolution-db|redis|srh"
$script:ServicosDoSupabase = "db|kong|auth|rest|realtime|storage|imgproxy|pg_meta|studio|inbucket|mailpit|analytics|vector|pooler|edge_runtime"

# Barras para a frente, sem barra no fim, minúsculas (o Windows não distingue).
function Pasta-Normalizada([string]$caminho) {
    return ($caminho -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
}
# A mesma pasta escrita de um jeito só (entrar nela troca nomes curtos do Windows, como CLARAS~1, pelo nome
# longo). Pasta que não existe aqui fica como veio, só normalizada.
function Pasta-Canonica([string]$caminho) {
    try {
        Push-Location -LiteralPath $caminho -ErrorAction Stop
        $c = (Get-Location).Path
        Pop-Location
        return (Pasta-Normalizada $c)
    } catch {
        return (Pasta-Normalizada $caminho)
    }
}
function E-DoComposeDoProjeto([string]$projeto, [string]$nome) {
    return ($nome -cmatch ('^' + $projeto + '-(' + $script:ServicosDoCompose + ')-[0-9]+$'))
}
function E-DoSupabaseDoProjeto([string]$projeto, [string]$nome) {
    return ($nome -cmatch ('^supabase_(' + $script:ServicosDoSupabase + ')_' + $projeto + '$'))
}
function E-VolumeDoSupabaseDoProjeto([string]$projeto, [string]$nome) {
    return ($nome -cmatch ('^supabase_(' + $script:ServicosDoSupabase + '|config)_' + $projeto + '$'))
}
# O --format vai SEM aspas duplas dentro: o Windows PowerShell 5.1 as tira ao chamar um programa, o docker
# recebia {{.Label com.docker...}}, respondia 'function "com" not defined' (código 1) e, com o stderr
# descartado, a lista voltava vazia e as conferências de outra pasta e de volume órfão nunca disparavam
#. A string crua do Go (entre crases) dispensa as aspas e chega igual pelo bash, pelo 5.1 e pelo
# PowerShell 7. O erro do docker não é mais escondido: falhou, quem chama recusa.
$script:FormatoConteiner = '{{.Names}}|{{.Label `com.docker.compose.project.working_dir`}}'
$script:FormatoVolume = '{{.Name}}|{{.Label `com.docker.compose.project`}}|{{.Label `com.docker.compose.project.working_dir`}}'

# @{ nome = pasta } dos contêineres do compose desse projeto (parados também). Lança erro se o docker falhar.
function Conteineres-DoProjeto([string]$projeto) {
    $mapa = @{}
    $linhas = @(docker ps -a --filter "label=com.docker.compose.project=$projeto" --format $script:FormatoConteiner)
    if ($LASTEXITCODE -ne 0) { throw "docker ps falhou" }
    foreach ($l in $linhas) {
        if ([string]::IsNullOrWhiteSpace($l)) { continue }
        $i = $l.IndexOf("|")
        if ($i -lt 1) { continue }
        $mapa[$l.Substring(0, $i)] = $l.Substring($i + 1).Trim()
    }
    return $mapa
}

# Conferir-PortasLivres PROJETO ITENS: confere ANTES de tocar em qualquer coisa que cada porta está livre
# (ou é do próprio CRM, numa reinstalação) e que nenhuma se repete. ITENS = "ROTULO=PORTA", onde ROTULO é a
# variável que a escolhe (CRM_ALQUIMIA_PORTA_*) ou a seção do config.toml. Explica cada problema e devolve
# $false se houver algum.
# $script:RecusaPorPorta diz ao instalador se a recusa (também) foi por porta, para a última linha não mandar
# "escolher portas" quando o problema é só o nome do projeto.
$script:RecusaPorPorta = $false
# $script:RecusaPorDocker: a recusa foi porque o Docker não respondeu a uma listagem.
$script:RecusaPorDocker = $false
function Conferir-PortasLivres([string]$projeto, [string[]]$itens) {
    $ok = $true
    $script:RecusaPorPorta = $false
    $script:RecusaPorDocker = $false
    $aqui = Pasta-Canonica (Get-Location).Path
    try { $lista = Conteineres-DoProjeto $projeto } catch {
        Write-Host ("ERRO: Não consegui listar os contêineres do Docker (o 'docker ps' falhou; a mensagem dele está acima). Sem isso eu não sei se outra instalação já usa o nome de projeto """ + $projeto + """, então paro aqui.") -ForegroundColor Red
        $script:RecusaPorDocker = $true
        return $false
    }
    $outra = ""
    foreach ($nome in $lista.Keys) {
        $pasta = [string]$lista[$nome]
        if (($pasta -ne "") -and ((Pasta-Canonica $pasta) -ne $aqui)) { $outra = $pasta }
    }
    if ($outra -ne "") {
        Write-Host ("ERRO: O nome de projeto """ + $projeto + """ já é usado por outra instalação deste CRM, na pasta " + $outra + ".") -ForegroundColor Red
        Write-Host ("      Duas instalações não podem ter o mesmo nome: rode de novo com outro, por exemplo CRM_ALQUIMIA_PROJETO=" + $projeto + "-2 (ou pare a outra com o parar da pasta dela).")
        $ok = $false
    }
    $registrado = ""
    if (Test-Path -LiteralPath (Join-Path (Get-Location).Path ".env.local")) { $registrado = Projeto-DaInstalacao (Join-Path (Get-Location).Path ".env.local") }
    # Instalação PARADA (o parar remove os contêineres) deixa os volumes: os dados dela não podem ser
    # reaproveitados por um clone novo, com segredos novos. Os da CLI do Supabase vêm sem os labels do compose.
    $volOutra = ""
    $volOrfao = ""
    $vols = @(docker volume ls --format $script:FormatoVolume)
    if ($LASTEXITCODE -ne 0) {
        Write-Host ("ERRO: Não consegui listar os volumes do Docker (o 'docker volume ls' falhou; a mensagem dele está acima). Sem isso eu não sei se já existem dados de outra instalação com o nome de projeto """ + $projeto + """, então paro aqui.") -ForegroundColor Red
        $script:RecusaPorDocker = $true
        return $false
    }
    foreach ($v in $vols) {
        if ([string]::IsNullOrWhiteSpace($v)) { continue }
        $partes = $v.Split("|")
        $vnome = $partes[0].Trim()
        $vproj = ""
        $vpasta = ""
        if ($partes.Length -gt 1) { $vproj = $partes[1].Trim() }
        if ($partes.Length -gt 2) { $vpasta = $partes[2].Trim() }
        if ($vproj -eq $projeto) {
            if (($vpasta -ne "") -and ((Pasta-Canonica $vpasta) -ne $aqui)) { $volOutra = "$vnome (pasta $vpasta)" }
            elseif ($registrado -ne $projeto) { $volOrfao = $vnome }
        } elseif (E-VolumeDoSupabaseDoProjeto $projeto $vnome) {
            if ($registrado -ne $projeto) { $volOrfao = $vnome }
        }
    }
    if ($volOutra -ne "") {
        Write-Host ("ERRO: Já existe o volume " + $volOutra + ", com os dados de OUTRA instalação deste CRM com o nome de projeto """ + $projeto + """.") -ForegroundColor Red
        Write-Host ("      Para instalar ao lado dela, rode de novo com outro nome, por exemplo CRM_ALQUIMIA_PROJETO=" + $projeto + "-2.")
        $ok = $false
    } elseif (($volOrfao -ne "") -and ($outra -eq "")) {
        Write-Host ("ERRO: Já existem dados (o volume " + $volOrfao + ") de uma instalação com o nome de projeto """ + $projeto + """, e esta pasta não tem o .env.local dela.") -ForegroundColor Red
        Write-Host ("      Se é outra instalação, rode com outro nome, por exemplo CRM_ALQUIMIA_PROJETO=" + $projeto + "-2. Se é esta mesma e o .env.local se perdeu, ponha de volta a sua cópia antes (sem as mesmas chaves os dados cifrados não abrem).")
        Write-Host "      Se quer recomeçar do zero e APAGAR esses dados, siga ""Quero recomeçar do zero"" no README."
        $ok = $false
    }
    $portas = @()
    foreach ($item in $itens) { $portas += $item.Substring($item.LastIndexOf("=") + 1) }
    $saidaNode = (node (Join-Path $script:LibInstalar "portas-em-uso.mjs") @portas) | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERRO: Não consegui conferir se as portas estão livres (scripts\lib\portas-em-uso.mjs falhou)." -ForegroundColor Red
        return $false
    }
    $ocupadas = @($saidaNode -split "\s+" | Where-Object { $_ -ne "" })
    $vistas = @()
    foreach ($item in $itens) {
        $i = $item.LastIndexOf("=")
        $rotulo = $item.Substring(0, $i)
        $porta = $item.Substring($i + 1)
        if ($vistas -contains $porta) {
            Write-Host "ERRO: A porta $porta foi escolhida para mais de um serviço ($rotulo e outro). Cada serviço precisa de uma porta só dele." -ForegroundColor Red
            $ok = $false
            $script:RecusaPorPorta = $true
            continue
        }
        $vistas += $porta
        if ($ocupadas -notcontains $porta) { continue }
        $nomes = @((docker ps --filter "publish=$porta" --format "{{.Names}}") | Where-Object { $_ -ne "" })
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERRO: Não consegui perguntar ao Docker quem usa a porta $porta ($rotulo) (o 'docker ps' falhou; a mensagem dele está acima)." -ForegroundColor Red
            $ok = $false
            $script:RecusaPorDocker = $true
            continue
        }
        $dono = $false
        $estranhoDoProjeto = ""
        foreach ($nome in $nomes) {
            if (E-DoComposeDoProjeto $projeto $nome) {
                $pasta = ""
                if ($lista.ContainsKey($nome)) { $pasta = [string]$lista[$nome] }
                if (($pasta -ne "") -and ((Pasta-Canonica $pasta) -eq $aqui)) { $dono = $true }
                else {
                    $mostrar = $pasta
                    if ($mostrar -eq "") { $mostrar = "desconhecida" }
                    $estranhoDoProjeto = "$nome (pasta $mostrar)"
                }
            } elseif (E-DoSupabaseDoProjeto $projeto $nome) {
                if (($registrado -eq $projeto) -and ($outra -eq "")) { $dono = $true } else { $estranhoDoProjeto = $nome }
            }
        }
        if ($dono) { continue }
        if ($estranhoDoProjeto -ne "") {
            Write-Host ("ERRO: A porta $porta ($rotulo) está com o contêiner $estranhoDoProjeto, de OUTRA instalação com o mesmo nome de projeto (""" + $projeto + """), não desta pasta.") -ForegroundColor Red
            Write-Host "      Para ter as duas lado a lado, rode com outro nome em CRM_ALQUIMIA_PROJETO (e outras portas)."
            $ok = $false
            continue
        }
        if ($nomes.Count -gt 0) {
            Write-Host ("ERRO: A porta $porta ($rotulo) já está em uso nesta máquina pelo contêiner " + ($nomes -join " ") + ", que não é deste CRM.") -ForegroundColor Red
        } else {
            Write-Host "ERRO: A porta $porta ($rotulo) já está em uso nesta máquina por outro programa." -ForegroundColor Red
        }
        if ($rotulo.StartsWith("CRM_ALQUIMIA_PORTA_")) {
            Write-Host ("      Escolha outra porta livre em $rotulo (por exemplo, " + ([int]$porta + 100) + ").")
        } else {
            Write-Host "      Troque a porta da seção $rotulo no supabase\config.toml ou desligue a seção (enabled = false)."
        }
        $ok = $false
        $script:RecusaPorPorta = $true
    }
    return $ok
}

# Heap-DoBuild [ARQUIVO]: CRM_ALQUIMIA_HEAP_BUILD_MB (memória do Node ao compilar o app): a variável, depois o
# .env.local, depois o padrão 4096. Lança erro se
# não for um número de 1024 a 65536.
function Heap-DoBuild([string]$arquivo = "") {
    $valor = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_HEAP_BUILD_MB")
    if ([string]::IsNullOrWhiteSpace($valor) -and ($arquivo -ne "")) { $valor = Valor-DoEnv $arquivo "CRM_ALQUIMIA_HEAP_BUILD_MB" }
    if ([string]::IsNullOrWhiteSpace($valor)) { return "4096" }
    $numero = 0
    if (-not [int]::TryParse($valor.Trim(), [ref]$numero) -or $numero -lt 1024 -or $numero -gt 65536) {
        throw "CRM_ALQUIMIA_HEAP_BUILD_MB=$valor não é um número de megabytes de 1024 a 65536 (ex.: 2048)."
    }
    return [string]$numero
}

# Modo-PararBanco [ARQUIVO]: CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD (auto | sempre | nunca), igual ao
# modo_parar_banco do .sh: a variável, depois o .env.local, depois `auto`. Lança erro se inválido.
function Modo-PararBanco([string]$arquivo = "") {
    $valor = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD")
    if ([string]::IsNullOrWhiteSpace($valor) -and ($arquivo -ne "")) { $valor = Valor-DoEnv $arquivo "CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD" }
    if ([string]::IsNullOrWhiteSpace($valor)) { return "auto" }
    $valor = $valor.Trim()
    if (@("auto", "sempre", "nunca") -cnotcontains $valor) {
        throw "CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=$valor não vale: use auto, sempre ou nunca."
    }
    return $valor
}

# Limiar-PararBancoMb [ARQUIVO]: CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB, a memória livre abaixo da qual o modo
# `auto` para o Supabase durante o build. Padrão 6144.
function Limiar-PararBancoMb([string]$arquivo = "") {
    $valor = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB")
    if ([string]::IsNullOrWhiteSpace($valor) -and ($arquivo -ne "")) { $valor = Valor-DoEnv $arquivo "CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB" }
    if ([string]::IsNullOrWhiteSpace($valor)) { return "6144" }
    $numero = 0
    if (-not [int]::TryParse($valor.Trim(), [ref]$numero) -or $numero -lt 0) {
        throw "CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB=$valor não é um número de megabytes (ex.: 6144)."
    }
    return [string]$numero
}

# Memoria-LivreMb: a memória física livre do Windows em MB, ou "" se não der para medir.
# CRM_ALQUIMIA_MEMORIA_LIVRE_MB substitui a medida do computador (testes, ou quando a medida do sistema
# engana). A medida que decide o modo `auto` é a de Memoria-ParaBuildMb, abaixo.
function Memoria-LivreMb {
    $forcado = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_MEMORIA_LIVRE_MB")
    $numero = 0
    if (-not [string]::IsNullOrWhiteSpace($forcado) -and [int]::TryParse($forcado.Trim(), [ref]$numero)) { return [string]$numero }
    try {
        $so = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        return [string][math]::Floor([double]$so.FreePhysicalMemory / 1024)
    } catch { return "" }
}

# Memoria-DaVmDockerMb: a memória total que o Docker enxerga, em MB (`docker info`), ou "" se não der para
# medir. No Windows e no Mac é a VM do Docker Desktop, que tem teto próprio: o build roda dentro dela.
function Memoria-DaVmDockerMb {
    try {
        $saida = (docker info --format "{{.MemTotal}}" 2>$null | Out-String).Trim()
    } catch { return "" }
    $bytes = [long]0
    if ([string]::IsNullOrWhiteSpace($saida) -or -not [long]::TryParse($saida, [ref]$bytes)) { return "" }
    return [string][math]::Floor($bytes / 1048576)
}

# Memoria-ParaBuildMb: a menor entre a memória livre do computador e a da VM do Docker (igual ao
# memoria_para_build_mb do .sh). Com só uma das medidas, vale ela; sem nenhuma, "".
function Memoria-ParaBuildMb {
    $livre = Memoria-LivreMb
    $vm = Memoria-DaVmDockerMb
    if ($livre -eq "") { return $vm }
    if ($vm -ne "" -and [long]$vm -lt [long]$livre) { return $vm }
    return $livre
}

# Deve-PararBanco MODO LIVRE LIMIAR: $true se o Supabase deve parar durante o build (igual ao deve_parar_banco
# do .sh). No `auto`, memória que não deu para medir conta como pouca.
function Deve-PararBanco([string]$modo, [string]$livre, [string]$limiar) {
    if ($modo -eq "sempre") { return $true }
    if ($modo -eq "nunca") { return $false }
    if ($livre -eq "") { return $true }
    return ([int]$livre -lt [int]$limiar)
}

# Build-DefinidoPeloUsuario [ARQUIVO]: $true se quem instala escolheu CPUs ou heap do build (na sessão ou no
# .env.local), igual ao build_definido_pelo_usuario do .sh. A escolha do usuário vence a automática.
function Build-DefinidoPeloUsuario([string]$arquivo = "") {
    foreach ($chave in @("CRM_ALQUIMIA_BUILD_CPUS", "CRM_ALQUIMIA_HEAP_BUILD_MB")) {
        if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($chave))) { return $true }
        if (($arquivo -ne "") -and ((Valor-DoEnv $arquivo $chave) -ne "")) { return $true }
    }
    return $false
}

# Os segredos do supabase\config.toml que a CLI lê de `env(...)`: o do JWT e as chaves novas da API.
$script:ChavesDaCli = @("CRM_ALQUIMIA_JWT_SECRET", "CRM_ALQUIMIA_PUBLISHABLE_KEY", "CRM_ALQUIMIA_SECRET_KEY")

# Exportar-SegredosDaCli ARQUIVO: põe no ambiente da CLI do Supabase os segredos que ela lê no
# supabase\config.toml ($script:ChavesDaCli), tirados do .env.local. Sem imprimir. Sem o valor no arquivo, o
# ambiente fica como está. Igual ao exportar_segredos_da_cli do .sh.
function Exportar-SegredosDaCli([string]$arquivo) {
    foreach ($k in $script:ChavesDaCli) {
        $valor = Valor-DoEnv $arquivo $k
        if ($valor -ne "") { Set-Item -Path ("env:" + $k) -Value $valor }
    }
}

# Gravar-EnvDaCli ARQUIVO_ENV DESTINO: grava o supabase\.env, que a CLI do Supabase lê sozinha para os
# `env(...)` do config.toml, com SÓ os segredos dela ($script:ChavesDaCli), tirados do .env.local. Assim quem
# sobe o Supabase à mão, sem o instalador, fica com as chaves desta instalação e não com textos públicos. Só do
# dono, reescrito a cada instalação (o .env.local é a fonte). Igual ao gravar_env_da_cli do .sh.
function Gravar-EnvDaCli([string]$origem, [string]$destino) {
    $linhas = New-Object System.Collections.Generic.List[string]
    $linhas.Add("# Gerado pelo instalador do CRM a partir do .env.local: a CLI do Supabase lê este arquivo. NUNCA commitar.")
    foreach ($k in $script:ChavesDaCli) { $linhas.Add($k + "=" + (Valor-DoEnv $origem $k)) }
    $novo = $destino + ".novo"
    [System.IO.File]::WriteAllText($novo, (($linhas -join "`n") + "`n"), $script:Utf8SemBomEnv)
    Restringir-ArquivoAoDono $novo
    Move-Item -Force -LiteralPath $novo -Destination $destino
    Restringir-ArquivoAoDono $destino
}

# Mascarar-Segredos LINHA: troca por <oculto> tudo o que tem forma de chave ou segredo: JWT, sb_secret_ e
# sb_publishable_, o valor dos campos "d" e "k" de uma JWK (com ou sem as aspas escapadas de um JSON dentro de
# outro) e qualquer trecho de 32 ou mais letras, dígitos, "_" ou "-". Igual ao mascarar_segredos do .sh.
function Mascarar-Segredos([string]$linha) {
    $l = $linha -creplace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', '<oculto>'
    $l = $l -creplace 'sb_(secret|publishable)_[A-Za-z0-9_-]+', '<oculto>'
    $l = $l -creplace '(\\?"(d|k)\\?"\s*:\s*\\?")[^"\\]*', '$1<oculto>'
    return ($l -creplace '[A-Za-z0-9_-]{32,}', '<oculto>')
}

# Linha-DeErroDaCli LINHA: o stdout de um comando da CLI do Supabase traz as chaves quando dá certo e o erro
# (uma linha JSON com "_tag":"Error") quando falha. Devolve a linha só se for de erro, mascarada
# (Mascarar-Segredos); senão, "". Igual ao linhas_de_erro_da_cli do .sh.
function Linha-DeErroDaCli([string]$linha) {
    if (($linha -notmatch '"_tag":"Error"') -and ($linha -notmatch '^[Ee]rror[: ]')) { return "" }
    return (Mascarar-Segredos $linha)
}

# --- Chave que assina as sessões (supabase\signing_keys.json) -----------------------------------------------
# O ajudante em Node que os dois instaladores usam para conferir as chaves sem imprimir nenhuma.
$script:ConferirChaves = Join-Path $PSScriptRoot "conferir-chaves.mjs"

# Node-ConferirChaves ARGS... [-Entrada TEXTO]: roda o ajudante; devolve @{ Codigo; Saida } (a saída é só um nome
# ou um código curto, nunca uma chave).
function Node-ConferirChaves([string[]]$argumentos, [string]$entrada = $null) {
    $saida = ""
    try {
        if ($null -ne $entrada) {
            $saida = ($entrada | & node $script:ConferirChaves @argumentos 2>$null) | Out-String
        } else {
            $saida = (& node $script:ConferirChaves @argumentos 2>$null) | Out-String
        }
        $codigo = $LASTEXITCODE
    } catch { $codigo = 70 }
    return @{ Codigo = $codigo; Saida = $saida.Trim() }
}

# Estado-DaChaveDeAssinatura ARQUIVO: "ausente" (sem arquivo, vazio ou []), "sem-privada" (só chaves públicas, como
# as antigas de uma rotação), "valida" (ao menos uma chave com a parte privada) ou "invalida". Igual ao .sh.
function Estado-DaChaveDeAssinatura([string]$arquivo) {
    $r = Node-ConferirChaves @("estado-chave", $arquivo)
    if (($r.Codigo -ne 0) -or ($r.Saida -eq "")) { return "invalida" }
    return $r.Saida
}

# Chave-DeAssinaturaValida ARQUIVO: $true se há ao menos uma chave com a parte privada. Não imprime nada.
function Chave-DeAssinaturaValida([string]$arquivo) {
    return ((Estado-DaChaveDeAssinatura $arquivo) -eq "valida")
}

# Gerar-ChaveDeAssinatura ARQUIVO CLI_EXE CLI_ARGS RAIZ: a própria CLI gera a chave ES256 direto no arquivo para o
# qual o config.toml aponta (`gen signing-key --append`). Ela exige que o arquivo exista: sem nenhuma chave, ele
# nasce [], já só do dono; com chaves só públicas (rotação), a privada nova entra ao lado delas. Nada da chave passa
# pela tela: do stdout só saem as linhas de erro, e o stderr só aparece se falhar, mascarado. Se falhar, apaga o
# arquivo só se foi esta execução que o criou e devolve $false. Igual ao gerar_chave_de_assinatura do .sh.
function Gerar-ChaveDeAssinatura([string]$arquivo, [string]$cliExe, [string[]]$cliArgs, [string]$raiz) {
    $criei = $false
    if ((Estado-DaChaveDeAssinatura $arquivo) -eq "ausente") {
        [System.IO.File]::WriteAllText($arquivo, "[]`n", $script:Utf8SemBomEnv)
        $criei = $true
    }
    Restringir-ArquivoAoDono $arquivo
    if ($null -eq $cliArgs) { $cliArgs = @() }
    $mensagens = @(& $cliExe @cliArgs gen signing-key --append --yes --workdir $raiz 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { Mascarar-Segredos $_.Exception.Message } else { Linha-DeErroDaCli ([string]$_) }
        } | Where-Object { $_.Trim() -ne "" })
    $codigo = $LASTEXITCODE
    if (($codigo -ne 0) -or (-not (Chave-DeAssinaturaValida $arquivo))) {
        if ($criei -and (Test-Path -LiteralPath $arquivo)) { Remove-Item -Force -LiteralPath $arquivo }
        foreach ($l in ($mensagens | Select-Object -Last 15)) { Write-Host $l }
        if ($mensagens.Count -eq 0) { Write-Host "(a CLI do Supabase não deixou mensagem; confira se ela roda: npx --yes supabase@2.120.0 --version)" }
        return $false
    }
    Restringir-ArquivoAoDono $arquivo
    return $true
}

# Conferir-ConfigDasChaves CONFIG: "" se o [auth] do config.toml aponta para as chaves desta instalação
# (signing_keys_path e os três env(...)); senão, os nomes das linhas que faltam. Igual ao .sh.
function Conferir-ConfigDasChaves([string]$config) {
    $r = Node-ConferirChaves @("config", $config)
    if ($r.Codigo -eq 0) { return "" }
    if ($r.Saida -eq "") { return "signing_keys_path, jwt_secret, publishable_key, secret_key" }
    return $r.Saida
}

# Conferir-SupabaseVivo PORTA_API PROJETO ARQUIVO_DA_CHAVE: o Supabase de pé usa as chaves desta instalação? Confere o
# JWKS do Auth (um GET público) contra a signing_keys.json e, pelo docker inspect (e, no Kong, pelo kong.yml do contêiner), se o Auth e o Kong não receberam o
# texto literal env(...), outro segredo do JWT, outra chave de assinatura ou outra chave da API. 0 = usa; 1 = não usa;
# 2 = o JWKS não respondeu (o resto bateu). Não imprime nada. Igual ao conferir_supabase_vivo do .sh.
function Conferir-SupabaseVivo([string]$portaApi, [string]$projeto, [string]$arquivoDaChave) {
    $tentativas = $env:CRM_ALQUIMIA_JWKS_TENTATIVAS
    if ([string]::IsNullOrEmpty($tentativas)) { $tentativas = "10" }
    $jwks = (Node-ConferirChaves @("jwks", $arquivoDaChave, "http://127.0.0.1:$portaApi/auth/v1/.well-known/jwks.json", $tentativas)).Codigo
    if ($jwks -eq 1) { return 1 }
    foreach ($servico in @("auth", "kong")) {
        $config = ""
        try { $config = (& docker inspect --format "{{json .Config}}" ("supabase_" + $servico + "_" + $projeto) 2>$null) | Out-String } catch { $config = "" }
        if ($null -eq $config) { $config = "" }
        if ($servico -eq "kong") {
            # As chaves sb_ do Kong ficam no kong.yml (o .Config só tem o comando): confere onde estão de fato.
            $kongYml = ""
            try { $kongYml = (& docker exec ("supabase_kong_" + $projeto) cat /home/kong/kong.yml 2>$null) | Out-String } catch { $kongYml = "" }
            if ($null -ne $kongYml) { $config = $config + "`n" + $kongYml }
        }
        if ((Node-ConferirChaves @($servico, $arquivoDaChave) $config).Codigo -ne 0) { return 1 }
    }
    if ($jwks -eq 0) { return 0 }
    return 2
}

# Aviso-DoBuild HEAP CPUS: o aviso de memória antes de compilar (igual ao aviso_do_build do .sh). Só sugere
# baixar o que ainda dá para baixar: 2048 de heap (com 1 CPU, a combinação medida) só se o heap está acima
# disso, 1 CPU só se há mais.
function Aviso-DoBuild([string]$heap, [string]$cpus) {
    $gb = [math]::Floor([int]$heap / 1024) + 2
    $texto = "AVISO: compilar o app usa até $heap MB de memória só para o Node, com $cpus CPU(s) (CRM_ALQUIMIA_BUILD_CPUS=$cpus). Deixe uns $gb GB de RAM livres (feche outros programas)."
    $sugestoes = @()
    if ([int]$cpus -gt 1) { $sugestoes += "CRM_ALQUIMIA_BUILD_CPUS=1" }
    if ([int]$heap -gt 2048) { $sugestoes += "CRM_ALQUIMIA_HEAP_BUILD_MB=2048" }
    if ($sugestoes.Count -gt 0) {
        $texto += " Pouca memória? Rode com " + ($sugestoes -join " e ") + " (mais lento; heap abaixo de 2048 pode fazer o build falhar)."
    } else {
        $texto += " Isto já é o mínimo recomendado: se faltar memória, feche outros programas ou use uma máquina com mais RAM."
    }
    if ([int]$cpus -lt 8) { $texto += " O limite de CPUs deixa o build mais lento; com RAM de sobra (16 GB livres ou mais), CRM_ALQUIMIA_BUILD_CPUS=8 compila mais rápido." }
    return $texto
}

# Cpus-DoBuild: CRM_ALQUIMIA_BUILD_CPUS (threads do Turbopack e workers do Next ao compilar o app), padrão
# 2. Lança erro se não for um número de 1 a 64.
function Cpus-DoBuild([string]$arquivo = "") {
    $valor = [Environment]::GetEnvironmentVariable("CRM_ALQUIMIA_BUILD_CPUS")
    if ([string]::IsNullOrWhiteSpace($valor) -and ($arquivo -ne "")) { $valor = Valor-DoEnv $arquivo "CRM_ALQUIMIA_BUILD_CPUS" }
    if ([string]::IsNullOrWhiteSpace($valor)) { return "2" }
    $numero = 0
    if (-not [int]::TryParse($valor.Trim(), [ref]$numero) -or $numero -lt 1 -or $numero -gt 64) {
        throw "CRM_ALQUIMIA_BUILD_CPUS=$valor não é um número de CPUs de 1 a 64 (ex.: 1)."
    }
    return [string]$numero
}

# Ajustar-ConfigToml ARQUIVO PORTA_API PORTA_DB PORTA_APP [PROJETO]: reescreve as portas do Supabase local,
# as URLs de retorno do login e (se dado) o project_id. Idempotente (com os padrões o conteúdo não muda).
function Ajustar-ConfigToml([string]$arquivo, [string]$api, [string]$db, [string]$app, [string]$projeto = "") {
    $linhas = [System.IO.File]::ReadAllLines($arquivo, $script:Utf8SemBomEnv)
    $saida = New-Object System.Collections.Generic.List[string]
    $secao = ""
    foreach ($linha in $linhas) {
        if ($linha -match '^\[') { $secao = $linha.Trim() }
        if ($secao -eq "" -and $projeto -ne "" -and $linha -match '^project_id\s*=') { $saida.Add('project_id = "' + $projeto + '"'); continue }
        if ($secao -eq "[api]" -and $linha -match '^port\s*=') { $saida.Add("port = $api"); continue }
        if ($secao -eq "[db]" -and $linha -match '^port\s*=') { $saida.Add("port = $db"); continue }
        if ($secao -eq "[db]" -and $linha -match '^shadow_port\s*=') { $saida.Add("shadow_port = " + ([int]$db - 2)); continue }
        if ($secao -eq "[db.pooler]" -and $linha -match '^port\s*=') { $saida.Add("port = " + ([int]$db + 7)); continue }
        if ($secao -eq "[studio]" -and $linha -match '^api_url\s*=') { $saida.Add('api_url = "http://127.0.0.1:' + $api + '"'); continue }
        if ($secao -eq "[auth]" -and $linha -match '^site_url\s*=') { $saida.Add('site_url = "http://localhost:' + $app + '"'); continue }
        if ($secao -eq "[auth]" -and $linha -match '"http://localhost:\d+/auth/') {
            $saida.Add(($linha -replace 'localhost:\d+', "localhost:$app"))
            continue
        }
        $saida.Add($linha)
    }
    $novo = (($saida -join "`n") + "`n")
    $atual = [System.IO.File]::ReadAllText($arquivo, $script:Utf8SemBomEnv)
    if ($novo -ne ($atual -replace "`r`n", "`n")) {
        [System.IO.File]::WriteAllText($arquivo, $novo, $script:Utf8SemBomEnv)
    }
}

# Ativar-ChaveDeCifra ARQUIVO_ENV CONTEINER_DO_BANCO
# A chave que cifra segredo de webhook, token de canal oficial e credencial do Google no banco
# (`private.fn_oauth_key()`: GUC `app.nuvemshop_oauth_key` ou a linha `nuvemshop_oauth_key` de
# `private.app_secrets`). Chamar DEPOIS do baseline (que cria `private.app_secrets`).
#   - O banco manda: se ele já tem chave, ela NUNCA é trocada (trocar tornaria ilegível o que já foi
#     cifrado) e o .env.local passa a guardar a mesma (NUVEMSHOP_OAUTH_ENCRYPTION_KEY), que é a cópia
#     que o dono guarda junto com o backup (o backup do banco não leva o schema `private`).
#     Se o .env.local tinha OUTRA chave, avisa (sem imprimir nenhuma das duas): era a única cópia dela.
#   - Banco sem chave (ou com uma curta demais, posta à mão, que o banco recusaria ao cifrar): usa a do
#     .env.local (máquina nova com o .env.local copiado) ou gera uma forte (32 bytes, hex), e grava no banco.
# A chave nunca é impressa nem vai no argv de um processo: chega ao psql pela entrada padrão.
function Ativar-ChaveDeCifra([string]$arquivo, [string]$conteiner) {
    $noBanco = (docker exec $conteiner psql -U postgres -d postgres -At -c "select exists(select 1 from private.app_secrets where name = 'nuvemshop_oauth_key' and length(value) >= 32)") | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Não consegui ler a chave de cifra do banco ($conteiner)." }
    if ($noBanco.Trim() -eq "t") {
        $chave = ((docker exec $conteiner psql -U postgres -d postgres -At -c "select value from private.app_secrets where name = 'nuvemshop_oauth_key'") | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $chave.Length -lt 32) { throw "Não consegui ler a chave de cifra do banco ($conteiner)." }
        $doEnv = Valor-DoEnv $arquivo "NUVEMSHOP_OAUTH_ENCRYPTION_KEY"
        if ($doEnv -and ($doEnv -cne $chave)) {
            [Console]::Error.WriteLine("AVISO: o .env.local tinha OUTRA chave de cifra (NUVEMSHOP_OAUTH_ENCRYPTION_KEY) e ela foi trocada pela que este banco já usa (o banco manda: trocar a dele tornaria ilegível o que já foi cifrado). Se a outra chave era a de um backup de outra instalação, os segredos cifrados daquele backup não abrem nesta. Para restaurá-lo numa máquina nova, o .env.local antigo tem de estar na pasta ANTES de instalar.")
        }
        $doEnv = $null
        Definir-NoEnv $arquivo "NUVEMSHOP_OAUTH_ENCRYPTION_KEY" $chave "sempre"
        $chave = $null
        return
    }
    $chave = Valor-DoEnv $arquivo "NUVEMSHOP_OAUTH_ENCRYPTION_KEY"
    if ($chave.Length -lt 32) {
        $chave = [string](node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
        Definir-NoEnv $arquivo "NUVEMSHOP_OAUTH_ENCRYPTION_KEY" $chave "sempre"
    }
    # Aspas simples dobradas: o valor entra como literal SQL (a chave gerada é hex; a copiada pode não ser).
    $sql = "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '" + $chave.Replace("'", "''") + "') on conflict (name) do update set value = excluded.value, updated_at = now() where length(private.app_secrets.value) < 32;"
    $chave = $null
    $OutputEncoding = $script:Utf8SemBomEnv
    $sql | docker exec -i $conteiner psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q | Out-Null
    $codigo = $LASTEXITCODE
    $sql = $null
    if ($codigo -ne 0) { throw "Não consegui gravar a chave de cifra no banco ($conteiner). Rode o instalador de novo; se repetir, abra uma issue com a mensagem acima." }
}
