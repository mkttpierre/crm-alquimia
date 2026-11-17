#!/usr/bin/env bash
# Funções do instalador que mexem no .env.local e no supabase/config.toml, separadas do
# `scripts/instalar.sh` para poderem ser EXECUTADAS por teste (tests/unit/instalador-*-executavel.test.ts)
# num diretório temporário, sem Docker. Só define funções: `source` não faz nada.

# valor_do_env ARQUIVO CHAVE: imprime o valor de CHAVE (vazio se não houver arquivo ou chave), sem o \r de um
# arquivo salvo com CRLF (Bloco de Notas), sem os espaços das pontas e sem um par de aspas em volta.
# Como o Valor-DoEnv do .ps1.
valor_do_env() {
  local arquivo="$1" chave="$2" v
  [ -f "$arquivo" ] || return 0
  grep -qE "^${chave}=" "$arquivo" || return 0
  v="$(grep -E "^${chave}=" "$arquivo" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s\n' "$v"
}

# definir_env ARQUIVO CHAVE VALOR sempre|se_vazio
#   sempre   : atualiza (ou acrescenta) a chave — para o que é derivado (URLs, portas, chaves do Supabase);
#   se_vazio : só grava se ainda não houver valor — para segredos, que não mudam na reinstalação.
# O valor vai ao awk pelo AMBIENTE (ENVIRON), nunca por `-v`: argumento de processo aparece em `ps`.
# O arquivo temporário nasce sob o umask do chamador (077 no instalador) e o resultado fica 600.
definir_env() {
  local arquivo="$1" chave="$2" valor="$3" modo="$4" atual
  atual="$(valor_do_env "$arquivo" "$chave")"
  if [ -n "$atual" ] && [ "$modo" = "se_vazio" ]; then return 0; fi
  if grep -qE "^${chave}=" "$arquivo" 2>/dev/null; then
    CRM_VALOR_DO_ENV="$valor" awk -v k="$chave" \
      'BEGIN { FS = OFS = "=" } $1 == k { print k "=" ENVIRON["CRM_VALOR_DO_ENV"]; next } { print }' \
      "$arquivo" > "$arquivo.novo"
    mv "$arquivo.novo" "$arquivo"
  else
    printf '%s=%s\n' "$chave" "$valor" >> "$arquivo"
  fi
  chmod 600 "$arquivo" 2>/dev/null || true
}

# porta_resolvida ARQUIVO NOME_DA_VARIAVEL PADRAO
# Precedência: variável do ambiente > valor já gravado no .env.local > padrão. É isso que faz
# rodar o instalador de novo, SEM a variável, manter a porta escolhida na primeira vez.
# Valor que não for número de 1 a 65535 sai com código 1 e a mensagem no stderr.
porta_resolvida() {
  local arquivo="$1" nome="$2" padrao="$3" valor
  valor="${!nome:-}"
  [ -n "$valor" ] || valor="$(valor_do_env "$arquivo" "$nome")"
  [ -n "$valor" ] || valor="$padrao"
  case "$valor" in
    ''|*[!0-9]*) printf 'ERRO: %s=%s não é um número de porta.\n' "$nome" "$valor" >&2; return 1 ;;
  esac
  if [ "$valor" -lt 1 ] || [ "$valor" -gt 65535 ]; then
    printf 'ERRO: %s=%s fora de 1 a 65535.\n' "$nome" "$valor" >&2
    return 1
  fi
  printf '%s' "$valor"
}

# --- Rodar ao lado de outro sistema ----------------------------------------------------------------
# Versão da CLI do Supabase testada com este CRM (nunca "a mais nova": outra versão baixa outras imagens,
# de GBs, e pode ligar serviços que esta não liga). E o que o `start` não sobe porque o CRM não usa.
SUPABASE_CLI_VERSAO="2.120.0"
SUPABASE_SERVICOS_FORA="imgproxy,studio,postgres-meta,mailpit"
PROJETO_PADRAO="crm-alquimia"

# supabase_cli: o comando da CLI do Supabase (CRM_ALQUIMIA_SUPABASE_CLI, ou o npx na versão testada).
supabase_cli() {
  if [ -n "${CRM_ALQUIMIA_SUPABASE_CLI:-}" ]; then
    printf '%s' "$CRM_ALQUIMIA_SUPABASE_CLI"
  else
    printf 'npx --yes supabase@%s' "$SUPABASE_CLI_VERSAO"
  fi
}

# projeto_valido NOME: letras minúsculas, números, - e _ (o Docker e a CLI do Supabase aceitam).
projeto_valido() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,39}$'
}

# projeto_resolvido ARQUIVO: nome do projeto para o INSTALADOR. CRM_ALQUIMIA_PROJETO > .env.local > padrão.
# É o nome do projeto do compose (-p), o project_id do Supabase e o sufixo dos contêineres dele.
projeto_resolvido() {
  local valor="${CRM_ALQUIMIA_PROJETO:-}"
  [ -n "$valor" ] || valor="$(valor_do_env "$1" CRM_ALQUIMIA_PROJETO)"
  [ -n "$valor" ] || valor="$PROJETO_PADRAO"
  if ! projeto_valido "$valor"; then
    printf 'ERRO: CRM_ALQUIMIA_PROJETO=%s não é um nome de projeto válido (use letras minúsculas, números, - e _; até 40).\n' "$valor" >&2
    return 1
  fi
  printf '%s' "$valor"
}

# projeto_da_instalacao ARQUIVO: nome do projeto para parar, backup e restaurar. Vem SÓ do .env.local
# desta pasta (padrão se não houver): uma variável esquecida na sessão não pode redirecioná-los.
projeto_da_instalacao() {
  local valor
  valor="$(valor_do_env "$1" CRM_ALQUIMIA_PROJETO)"
  if [ -n "$valor" ] && projeto_valido "$valor"; then printf '%s' "$valor"; else printf '%s' "$PROJETO_PADRAO"; fi
}

# compose_crm PROJETO ARGS...: o `docker compose` DESTE CRM, sempre com o projeto e o arquivo explícitos.
# Sem `-p`/`-f`, um COMPOSE_PROJECT_NAME ou COMPOSE_FILE esquecido na sessão faria `down`/`stop` em OUTRO
# projeto da máquina. Roda na raiz do CRM (todos os scripts fazem `cd` para lá).
compose_crm() {
  local projeto="$1"; shift
  docker compose -p "$projeto" -f docker-compose.yml --env-file .env.local "$@"
}

# portas_extras_do_config ARQUIVO PORTA_DB: as portas de serviço do Supabase LIGADO no config.toml além da
# API e do banco (Studio, e-mail de teste, pooler, analytics), como "[secao]=porta". O pooler segue o
# banco (db + 7), como o ajustar_config_toml grava.
portas_extras_do_config() {
  awk -v pooler="$(($2 + 7))" '
    function fecha() { if (interessa && ligado && porta != "") print secao "=" porta }
    /^\[/ {
      fecha(); secao = $0; gsub(/[ \t\r]/, "", secao); ligado = 0; porta = ""
      interessa = (secao == "[studio]" || secao == "[inbucket]" || secao == "[db.pooler]" || secao == "[analytics]")
      next
    }
    interessa && /^enabled *= *true/ { ligado = 1 }
    interessa && /^port *=/ { porta = $0; sub(/^port *= */, "", porta); gsub(/[^0-9]/, "", porta); if (secao == "[db.pooler]") porta = pooler }
    END { fecha() }
  ' "$1"
}

# --- Dono de uma porta ocupada ----------------------------------------------------------------------
# Ser do mesmo NOME de projeto não basta: um segundo clone com o nome padrão, noutra pasta, usaria (e
# estragaria) os contêineres e volumes da primeira instalação. Dono é:
#   - contêiner do compose PROJETO-<serviço>-N cujo label com.docker.compose.project.working_dir é ESTA pasta;
#   - contêiner da CLI do Supabase supabase_<serviço>_PROJETO, se ESTA pasta já tem um .env.local desse
#     projeto e não há contêiner do compose desse projeto vindo de outra pasta (a CLI não grava a pasta).
SERVICOS_DO_COMPOSE="app|worker|scheduler|evolution|evolution-db|redis|srh"
SERVICOS_DO_SUPABASE="db|kong|auth|rest|realtime|storage|imgproxy|pg_meta|studio|inbucket|mailpit|analytics|vector|pooler|edge_runtime"

# pasta_normalizada CAMINHO: barras para a frente, sem barra no fim, minúsculas (o Windows não distingue).
pasta_normalizada() { printf '%s' "$1" | tr '\\' '/' | sed -e 's#/*$##' | tr '[:upper:]' '[:lower:]'; }
# pasta_do_crm: a pasta atual como o Docker a vê (C:/... no Git Bash; o caminho Unix de sempre fora do Windows).
pasta_do_crm() { pwd -W 2>/dev/null || pwd; }
# pasta_canonica CAMINHO: a mesma pasta escrita de um jeito só (entrar nela troca nomes curtos do Windows,
# como CLARAS~1, pelo nome longo). Pasta que não existe aqui fica como veio, só normalizada.
pasta_canonica() {
  local c
  if c="$(cd "$1" 2>/dev/null && pasta_do_crm)"; then pasta_normalizada "$c"; else pasta_normalizada "$1"; fi
}

e_do_compose_do_projeto() { printf '%s' "$2" | grep -Eq "^${1}-(${SERVICOS_DO_COMPOSE})-[0-9]+$"; }
e_do_supabase_do_projeto() { printf '%s' "$2" | grep -Eq "^supabase_(${SERVICOS_DO_SUPABASE})_${1}$"; }
e_volume_do_supabase_do_projeto() { printf '%s' "$2" | grep -Eq "^supabase_(${SERVICOS_DO_SUPABASE}|config)_${1}$"; }

# volumes_do_docker: "nome|projeto do compose|pasta do compose" de cada volume (os da CLI do Supabase vêm sem
# os labels do compose).
# O --format vai sem aspas duplas dentro (string crua do Go, entre crases): é o mesmo texto do .ps1, onde o
# Windows PowerShell 5.1 tirava as aspas e o docker devolvia 'function "com" not defined'. O erro
# do docker não é mais escondido: falhou, a função devolve 1 e quem chama recusa.
# shellcheck disable=SC2016
FORMATO_VOLUME='{{.Name}}|{{.Label `com.docker.compose.project`}}|{{.Label `com.docker.compose.project.working_dir`}}'
# shellcheck disable=SC2016
FORMATO_CONTEINER='{{.Names}}|{{.Label `com.docker.compose.project.working_dir`}}'
volumes_do_docker() {
  local saida
  saida="$(docker volume ls --format "$FORMATO_VOLUME")" || return 1
  printf '%s\n' "$saida" | tr -d '\r'
}

# conteineres_do_projeto PROJETO: "nome|pasta" de cada contêiner do compose desse projeto (parados também).
conteineres_do_projeto() {
  local saida
  saida="$(docker ps -a --filter "label=com.docker.compose.project=$1" --format "$FORMATO_CONTEINER")" || return 1
  printf '%s\n' "$saida" | tr -d '\r'
}

# conferir_portas_livres PROJETO "ROTULO=PORTA"...: confere ANTES de tocar em qualquer coisa que cada
# porta está livre (ou é do próprio CRM, numa reinstalação) e que nenhuma se repete. ROTULO é a variável
# que a escolhe (CRM_ALQUIMIA_PORTA_*) ou a seção do config.toml. Explica cada problema no stderr e
# devolve 1 se houver algum.
conferir_portas_livres() {
  local projeto="$1"; shift
  local item rotulo porta ocupadas nomes nome vistas=" " erros=0
  local portas="" aqui lista outra="" pasta registrado="" dono estranho_do_projeto vnome vproj vpasta vol_outra="" vol_orfao="" vols
  RECUSA_POR_PORTA=0
  # RECUSA_POR_DOCKER: a recusa foi porque o Docker não respondeu a uma listagem.
  RECUSA_POR_DOCKER=0
  aqui="$(pasta_canonica .)"
  if ! lista="$(conteineres_do_projeto "$projeto")"; then
    printf 'ERRO: Não consegui listar os contêineres do Docker (o "docker ps" falhou; a mensagem dele está acima). Sem isso eu não sei se outra instalação já usa o nome de projeto "%s", então paro aqui.\n' "$projeto" >&2
    RECUSA_POR_DOCKER=1
    return 1
  fi
  if ! vols="$(volumes_do_docker)"; then
    printf 'ERRO: Não consegui listar os volumes do Docker (o "docker volume ls" falhou; a mensagem dele está acima). Sem isso eu não sei se já existem dados de outra instalação com o nome de projeto "%s", então paro aqui.\n' "$projeto" >&2
    RECUSA_POR_DOCKER=1
    return 1
  fi
  while IFS='|' read -r nome pasta; do
    [ -n "$nome" ] || continue
    if [ -n "$pasta" ] && [ "$(pasta_canonica "$pasta")" != "$aqui" ]; then outra="$pasta"; fi
  done <<< "$lista"
  if [ -n "$outra" ]; then
    printf 'ERRO: O nome de projeto "%s" já é usado por outra instalação deste CRM, na pasta %s.\n' "$projeto" "$outra" >&2
    printf '      Duas instalações não podem ter o mesmo nome: rode de novo com outro, por exemplo CRM_ALQUIMIA_PROJETO=%s-2 (ou pare a outra com o parar da pasta dela).\n' "$projeto" >&2
    erros=1
  fi
  if [ -f .env.local ]; then registrado="$(projeto_da_instalacao .env.local)"; fi
  # Instalação PARADA (o parar remove os contêineres) deixa os volumes: os dados dela não podem ser
  # reaproveitados por um clone novo, com segredos novos.
  while IFS='|' read -r vnome vproj vpasta; do
    [ -n "$vnome" ] || continue
    if [ "$vproj" = "$projeto" ]; then
      if [ -n "$vpasta" ] && [ "$(pasta_canonica "$vpasta")" != "$aqui" ]; then vol_outra="$vnome (pasta $vpasta)"
      elif [ "$registrado" != "$projeto" ]; then vol_orfao="$vnome"; fi
    elif e_volume_do_supabase_do_projeto "$projeto" "$vnome"; then
      if [ "$registrado" != "$projeto" ]; then vol_orfao="$vnome"; fi
    fi
  done <<< "$vols"
  if [ -n "$vol_outra" ]; then
    printf 'ERRO: Já existe o volume %s, com os dados de OUTRA instalação deste CRM com o nome de projeto "%s".\n' "$vol_outra" "$projeto" >&2
    printf '      Para instalar ao lado dela, rode de novo com outro nome, por exemplo CRM_ALQUIMIA_PROJETO=%s-2.\n' "$projeto" >&2
    erros=1
  elif [ -n "$vol_orfao" ] && [ -z "$outra" ]; then
    printf 'ERRO: Já existem dados (o volume %s) de uma instalação com o nome de projeto "%s", e esta pasta não tem o .env.local dela.\n' "$vol_orfao" "$projeto" >&2
    printf '      Se é outra instalação, rode com outro nome, por exemplo CRM_ALQUIMIA_PROJETO=%s-2. Se é esta mesma e o .env.local se perdeu, ponha de volta a sua cópia antes (sem as mesmas chaves os dados cifrados não abrem).\n' "$projeto" >&2
    printf '      Se quer recomeçar do zero e APAGAR esses dados, siga "Quero recomeçar do zero" no README.\n' >&2
    erros=1
  fi
  for item in "$@"; do portas="$portas ${item##*=}"; done
  # shellcheck disable=SC2086
  if ! ocupadas="$(node scripts/lib/portas-em-uso.mjs $portas)"; then
    printf 'ERRO: Não consegui conferir se as portas estão livres (scripts/lib/portas-em-uso.mjs falhou).\n' >&2
    return 1
  fi
  ocupadas=" $(printf '%s' "$ocupadas" | tr '\r\n' '  ') "
  for item in "$@"; do
    rotulo="${item%=*}"
    porta="${item##*=}"
    case "$vistas" in
      *" $porta "*)
        printf 'ERRO: A porta %s foi escolhida para mais de um serviço (%s e outro). Cada serviço precisa de uma porta só dele.\n' "$porta" "$rotulo" >&2
        erros=1; RECUSA_POR_PORTA=1; continue ;;
    esac
    vistas="$vistas$porta "
    case "$ocupadas" in *" $porta "*) ;; *) continue ;; esac
    if ! nomes="$(docker ps --filter "publish=$porta" --format '{{.Names}}')"; then
      printf 'ERRO: Não consegui perguntar ao Docker quem usa a porta %s (%s) (o "docker ps" falhou; a mensagem dele está acima).\n' "$porta" "$rotulo" >&2
      erros=1; RECUSA_POR_DOCKER=1; continue
    fi
    nomes="$(printf '%s' "$nomes" | tr -d '\r')"
    dono=0
    estranho_do_projeto=""
    while IFS= read -r nome; do
      [ -n "$nome" ] || continue
      if e_do_compose_do_projeto "$projeto" "$nome"; then
        pasta="$(printf '%s\n' "$lista" | awk -F'|' -v n="$nome" '$1 == n { print $2; exit }')"
        if [ -n "$pasta" ] && [ "$(pasta_canonica "$pasta")" = "$aqui" ]; then dono=1; else estranho_do_projeto="$nome (pasta ${pasta:-desconhecida})"; fi
      elif e_do_supabase_do_projeto "$projeto" "$nome"; then
        if [ "$registrado" = "$projeto" ] && [ -z "$outra" ]; then dono=1; else estranho_do_projeto="$nome"; fi
      fi
    done <<< "$nomes"
    if [ "$dono" -eq 1 ]; then continue; fi
    if [ -n "$estranho_do_projeto" ]; then
      printf 'ERRO: A porta %s (%s) está com o contêiner %s, de OUTRA instalação com o mesmo nome de projeto ("%s"), não desta pasta.\n' "$porta" "$rotulo" "$estranho_do_projeto" "$projeto" >&2
      printf '      Para ter as duas lado a lado, rode com outro nome em CRM_ALQUIMIA_PROJETO (e outras portas).\n' >&2
      erros=1
      continue
    fi
    if [ -n "$nomes" ]; then
      printf 'ERRO: A porta %s (%s) já está em uso nesta máquina pelo contêiner %s, que não é deste CRM.\n' "$porta" "$rotulo" "$(printf '%s' "$nomes" | tr '\n' ' ')" >&2
    else
      printf 'ERRO: A porta %s (%s) já está em uso nesta máquina por outro programa.\n' "$porta" "$rotulo" >&2
    fi
    case "$rotulo" in
      CRM_ALQUIMIA_PORTA_*) printf '      Escolha outra porta livre em %s (por exemplo, %s).\n' "$rotulo" "$((porta + 100))" >&2 ;;
      *) printf '      Troque a porta da seção %s no supabase/config.toml ou desligue a seção (enabled = false).\n' "$rotulo" >&2 ;;
    esac
    erros=1
    RECUSA_POR_PORTA=1
  done
  return "$erros"
}

# cpus_do_build [ARQUIVO]: CRM_ALQUIMIA_BUILD_CPUS (threads do Turbopack e workers do Next ao compilar o app):
# a variável, depois o .env.local, depois o padrão 2.
cpus_do_build() {
  local valor="${CRM_ALQUIMIA_BUILD_CPUS:-}"
  [ -n "$valor" ] || [ -z "${1:-}" ] || valor="$(valor_do_env "$1" CRM_ALQUIMIA_BUILD_CPUS)"
  [ -n "$valor" ] || valor=2
  case "$valor" in
    ''|*[!0-9]*) printf 'ERRO: CRM_ALQUIMIA_BUILD_CPUS=%s não é um número de CPUs (ex.: 1).\n' "$valor" >&2; return 1 ;;
  esac
  if [ "$valor" -lt 1 ] || [ "$valor" -gt 64 ]; then
    printf 'ERRO: CRM_ALQUIMIA_BUILD_CPUS=%s fora de 1 a 64.\n' "$valor" >&2
    return 1
  fi
  printf '%s' "$valor"
}

# build_definido_pelo_usuario [ARQUIVO]: 0 se quem instala escolheu CPUs ou heap do build (na sessão ou no
# .env.local). Escolha do usuário sempre vence a escolha automática por pouca memória.
build_definido_pelo_usuario() {
  [ -n "${CRM_ALQUIMIA_BUILD_CPUS:-}" ] && return 0
  [ -n "${CRM_ALQUIMIA_HEAP_BUILD_MB:-}" ] && return 0
  [ -n "${1:-}" ] || return 1
  [ -n "$(valor_do_env "$1" CRM_ALQUIMIA_BUILD_CPUS)" ] && return 0
  [ -n "$(valor_do_env "$1" CRM_ALQUIMIA_HEAP_BUILD_MB)" ] && return 0
  return 1
}

# Os segredos do supabase/config.toml que a CLI lê de `env(...)`: o do JWT e as chaves novas da API.
CHAVES_DA_CLI="CRM_ALQUIMIA_JWT_SECRET CRM_ALQUIMIA_PUBLISHABLE_KEY CRM_ALQUIMIA_SECRET_KEY"

# exportar_segredos_da_cli ARQUIVO: exporta do .env.local para a CLI do Supabase os segredos que ela lê no
# supabase/config.toml (CHAVES_DA_CLI). Sem imprimir. Sem o valor no arquivo, o ambiente fica como está.
exportar_segredos_da_cli() {
  local valor k
  for k in $CHAVES_DA_CLI; do
    valor="$(valor_do_env "$1" "$k")"
    if [ -n "$valor" ]; then export "$k=$valor"; fi
  done
}

# gravar_env_da_cli ARQUIVO_ENV DESTINO: grava o supabase/.env, que a CLI do Supabase lê sozinha para os
# `env(...)` do config.toml, com SÓ os segredos dela (CHAVES_DA_CLI), tirados do .env.local. Assim quem sobe o
# Supabase à mão, sem o instalador, fica com as chaves desta instalação e não com textos públicos. Nasce só
# do dono e é reescrito a cada instalação (o .env.local é a fonte).
gravar_env_da_cli() {
  local origem="$1" destino="$2" k
  (
    umask 077
    {
      printf '# Gerado pelo instalador do CRM a partir do .env.local: a CLI do Supabase lê este arquivo. NUNCA commitar.\n'
      for k in $CHAVES_DA_CLI; do printf '%s=%s\n' "$k" "$(valor_do_env "$origem" "$k")"; done
    } > "$destino.novo"
  )
  mv "$destino.novo" "$destino"
  restringir_ao_dono "$destino"
}

# mascarar_segredos: filtro que troca por <oculto> tudo o que tem forma de chave ou segredo: JWT, sb_secret_ e
# sb_publishable_, o valor dos campos "d" e "k" de uma JWK (com ou sem as aspas escapadas de um JSON dentro de
# outro) e qualquer trecho de 32 ou mais letras, dígitos, "_" ou "-" (o segredo do JWT em hex, a parte privada de
# uma chave em base64url). Sai sempre com 0.
mascarar_segredos() {
  sed -E \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/<oculto>/g' \
    -e 's/sb_(secret|publishable)_[A-Za-z0-9_-]+/<oculto>/g' \
    -e 's/(\\?"(d|k)\\?"[[:space:]]*:[[:space:]]*\\?")[^"\\]*/\1<oculto>/g' \
    -e 's/[A-Za-z0-9_-]{32,}/<oculto>/g'
}

# linhas_de_erro_da_cli: filtro para o stdout de um comando da CLI do Supabase, que traz as chaves quando dá
# certo e o erro (uma linha JSON com "_tag":"Error") quando falha. Passa só as linhas de erro, mascaradas
# (mascarar_segredos). Sai sempre com 0.
linhas_de_erro_da_cli() {
  sed -n -E '/"_tag":"Error"|^[Ee]rror[: ]/p' | mascarar_segredos
}

# --- Chave que assina as sessões (supabase/signing_keys.json) ------------------------------------------------
# O ajudante em Node que os dois instaladores usam para conferir as chaves sem imprimir nenhuma.
CONFERIR_CHAVES="scripts/lib/conferir-chaves.mjs"

# estado_da_chave_de_assinatura ARQUIVO: imprime "ausente" (sem arquivo, vazio ou []), "sem-privada" (só chaves
# públicas, como as antigas de uma rotação), "valida" (ao menos uma chave com a parte privada) ou "invalida"
# (não é uma lista de chaves). Não imprime nada da chave.
estado_da_chave_de_assinatura() {
  node "$CONFERIR_CHAVES" estado-chave "$1" 2>/dev/null || printf 'invalida\n'
}

# chave_de_assinatura_valida ARQUIVO: 0 se há ao menos uma chave com a parte privada. Não imprime nada.
chave_de_assinatura_valida() {
  [ "$(estado_da_chave_de_assinatura "$1")" = "valida" ]
}

# gerar_chave_de_assinatura ARQUIVO COMANDO_DA_CLI...: a própria CLI gera a chave ES256 direto no arquivo para o
# qual o config.toml aponta (`gen signing-key --append`). Ela exige que o arquivo exista: sem nenhuma chave, ele
# nasce `[]`, já só do dono; com chaves só públicas (rotação), a privada nova entra ao lado delas. Nada da chave
# passa pela tela: do stdout só saem as linhas de erro (com o config certo ele vem vazio; sem ele, a chave sairia ali
# e é descartada), e o stderr só aparece se falhar, mascarado. Se falhar, apaga o arquivo só se foi esta execução
# que o criou (uma chave que o usuário já tinha nunca é apagada) e devolve 1.
gerar_chave_de_assinatura() {
  local arquivo="$1" saida erro_cli codigo=0 criei=0 estado
  shift
  estado="$(estado_da_chave_de_assinatura "$arquivo")"
  if [ "$estado" = "ausente" ]; then
    ( umask 077; printf '[]\n' > "$arquivo" )
    criei=1
  fi
  restringir_ao_dono "$arquivo"
  erro_cli="$(mktemp)"
  saida="$("$@" gen signing-key --append --yes </dev/null 2>"$erro_cli" | linhas_de_erro_da_cli; exit "${PIPESTATUS[0]}")" || codigo=$?
  if [ "$codigo" -ne 0 ] || ! chave_de_assinatura_valida "$arquivo"; then
    if [ "$criei" = "1" ]; then rm -f "$arquivo"; fi
    if [ -n "$saida" ]; then printf '%s\n' "$saida" >&2; fi
    if [ -s "$erro_cli" ]; then tr '\r' '\n' < "$erro_cli" | sed -e '/^[[:space:]]*$/d' | mascarar_segredos | tail -n 15 >&2; fi
    if [ -z "$saida" ] && [ ! -s "$erro_cli" ]; then
      printf '%s\n' "(a CLI do Supabase não deixou mensagem; confira se ela roda: npx --yes supabase@2.120.0 --version)" >&2
    fi
    rm -f "$erro_cli"
    return 1
  fi
  rm -f "$erro_cli"
  restringir_ao_dono "$arquivo"
}

# conferir_config_das_chaves CONFIG: 0 se o [auth] do config.toml aponta para as chaves desta instalação
# (signing_keys_path e os três env(...)); senão imprime os nomes das linhas que faltam e devolve 1.
conferir_config_das_chaves() {
  node "$CONFERIR_CHAVES" config "$1"
}

# conferir_supabase_vivo PORTA_API PROJETO: o Supabase de pé usa as chaves desta instalação? Confere o JWKS do Auth
# (um GET público) contra a supabase/signing_keys.json e, pelo `docker inspect`, se o Auth e o Kong não receberam
# o texto literal env(...), outro segredo do JWT, outra chave de assinatura ou outra chave da API. 0 = usa;
# 1 = não usa; 2 = o JWKS não respondeu (o resto bateu). Não imprime nada.
conferir_supabase_vivo() {
  local codigo=0 servico config
  node "$CONFERIR_CHAVES" jwks supabase/signing_keys.json "http://127.0.0.1:$1/auth/v1/.well-known/jwks.json" \
    "${CRM_ALQUIMIA_JWKS_TENTATIVAS:-10}" >/dev/null 2>&1 || codigo=$?
  if [ "$codigo" = "1" ]; then return 1; fi
  for servico in auth kong; do
    config="$(docker inspect --format '{{json .Config}}' "supabase_${servico}_$2" 2>/dev/null || true)"
    if [ "$servico" = "kong" ]; then
      # As chaves sb_ do Kong ficam no kong.yml (o .Config só tem o comando): confere onde estão de fato.
      config="$config
$(docker exec "supabase_kong_$2" cat /home/kong/kong.yml 2>/dev/null || true)"
    fi
    if ! printf '%s' "$config" | node "$CONFERIR_CHAVES" "$servico" supabase/signing_keys.json >/dev/null 2>&1; then return 1; fi
  done
  if [ "$codigo" = "0" ]; then return 0; fi
  return 2
}

# aviso_do_build HEAP CPUS: o aviso de memória antes de compilar (igual ao Aviso-DoBuild do .ps1). Só sugere
# baixar o que ainda dá para baixar: 2048 de heap (com 1 CPU, a combinação medida) só se o heap está acima
# disso, 1 CPU só se há mais.
aviso_do_build() {
  local heap="$1" cpus="$2" sugestoes="" texto
  texto="AVISO: compilar o app usa até ${heap} MB de memória só para o Node, com ${cpus} CPU(s) (CRM_ALQUIMIA_BUILD_CPUS=${cpus}). Deixe uns $((heap / 1024 + 2)) GB de RAM livres (feche outros programas)."
  if [ "$cpus" -gt 1 ]; then sugestoes="CRM_ALQUIMIA_BUILD_CPUS=1"; fi
  if [ "$heap" -gt 2048 ]; then sugestoes="${sugestoes:+$sugestoes e }CRM_ALQUIMIA_HEAP_BUILD_MB=2048"; fi
  if [ -n "$sugestoes" ]; then
    texto="$texto Pouca memória? Rode com $sugestoes (mais lento; heap abaixo de 2048 pode fazer o build falhar)."
  else
    texto="$texto Isto já é o mínimo recomendado: se faltar memória, feche outros programas ou use uma máquina com mais RAM."
  fi
  if [ "$cpus" -lt 8 ]; then
    texto="$texto O limite de CPUs deixa o build mais lento; com RAM de sobra (16 GB livres ou mais), CRM_ALQUIMIA_BUILD_CPUS=8 compila mais rápido."
  fi
  printf '%s' "$texto"
}

# modo_parar_banco [ARQUIVO]: CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD (auto | sempre | nunca): numa reinstalação com
# o Supabase deste CRM de pé, se ele para durante o build das imagens. A variável, depois o .env.local,
# depois `auto` (para só com pouca memória livre).
modo_parar_banco() {
  local valor="${CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD:-}"
  [ -n "$valor" ] || [ -z "${1:-}" ] || valor="$(valor_do_env "$1" CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD)"
  [ -n "$valor" ] || valor=auto
  case "$valor" in
    auto|sempre|nunca) printf '%s' "$valor" ;;
    *) printf 'ERRO: CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=%s não vale: use auto, sempre ou nunca.\n' "$valor" >&2; return 1 ;;
  esac
}

# limiar_parar_banco_mb [ARQUIVO]: CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB, a memória livre abaixo da qual o modo
# `auto` para o Supabase durante o build. Padrão 6144 (o build medido pede ~4,1 GB, mais folga para o sistema).
limiar_parar_banco_mb() {
  local valor="${CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB:-}"
  [ -n "$valor" ] || [ -z "${1:-}" ] || valor="$(valor_do_env "$1" CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB)"
  [ -n "$valor" ] || valor=6144
  case "$valor" in
    ''|*[!0-9]*) printf 'ERRO: CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB=%s não é um número de megabytes (ex.: 6144).\n' "$valor" >&2; return 1 ;;
  esac
  printf '%s' "$valor"
}

# memoria_livre_mb: a memória livre do computador em MB, ou vazio se não der para medir. Linux e Git Bash
# leem /proc/meminfo (MemAvailable; o Git Bash só tem MemFree); macOS soma as páginas livres e inativas.
# CRM_ALQUIMIA_MEMORIA_LIVRE_MB substitui a medida do computador (testes, ou quando a medida do sistema
# engana). A medida que decide o modo `auto` é a de memoria_para_build_mb, abaixo.
memoria_livre_mb() {
  case "${CRM_ALQUIMIA_MEMORIA_LIVRE_MB:-}" in
    ''|*[!0-9]*) ;;
    *) printf '%s' "$CRM_ALQUIMIA_MEMORIA_LIVRE_MB"; return 0 ;;
  esac
  local kb=""
  if [ -r /proc/meminfo ]; then
    kb="$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo)"
    [ -n "$kb" ] || kb="$(awk '/^MemFree:/ {print $2; exit}' /proc/meminfo)"
  elif command -v vm_stat >/dev/null 2>&1; then
    kb="$(vm_stat 2>/dev/null | awk '/page size of/ {t=$8} /Pages free/ {f=$3} /Pages inactive/ {i=$3} END {gsub(/\./,"",f); gsub(/\./,"",i); if (t && f != "") print int((f+i)*t/1024)}')"
  fi
  case "$kb" in ''|*[!0-9]*) return 0 ;; esac
  printf '%s' "$((kb / 1024))"
}

# memoria_da_vm_docker_mb: a memória total que o Docker enxerga, em MB (`docker info`), ou vazio se não der
# para medir. No Mac e no Windows é a VM do Docker Desktop, que tem teto próprio: o build roda dentro dela.
memoria_da_vm_docker_mb() {
  local bytes
  bytes="$(docker info --format '{{.MemTotal}}' 2>/dev/null | tr -d '[:space:]')" || bytes=""
  case "$bytes" in ''|*[!0-9]*) return 0 ;; esac
  printf '%s' "$((bytes / 1048576))"
}

# memoria_para_build_mb: a menor entre a memória livre do computador e a da VM do Docker. O build cabe só
# onde as duas deixam; com só uma das medidas, vale ela; sem nenhuma, vazio.
memoria_para_build_mb() {
  local livre vm
  livre="$(memoria_livre_mb)"
  vm="$(memoria_da_vm_docker_mb)"
  if [ -z "$livre" ]; then printf '%s' "$vm"; return 0; fi
  if [ -n "$vm" ] && [ "$vm" -lt "$livre" ]; then printf '%s' "$vm"; return 0; fi
  printf '%s' "$livre"
}

# deve_parar_banco MODO LIVRE_MB LIMIAR_MB: 0 se o Supabase deve parar durante o build. No `auto`, memória
# que não deu para medir conta como pouca (é o caso que já derrubou o build; o Supabase volta de qualquer jeito).
deve_parar_banco() {
  case "$1" in
    sempre) return 0 ;;
    nunca) return 1 ;;
  esac
  [ -z "$2" ] && return 0
  [ "$2" -lt "$3" ]
}

# heap_do_build [ARQUIVO]: CRM_ALQUIMIA_HEAP_BUILD_MB (memória do Node ao compilar o app): a variável, depois
# o .env.local, depois o padrão 4096.
heap_do_build() {
  local valor="${CRM_ALQUIMIA_HEAP_BUILD_MB:-}"
  [ -n "$valor" ] || [ -z "${1:-}" ] || valor="$(valor_do_env "$1" CRM_ALQUIMIA_HEAP_BUILD_MB)"
  [ -n "$valor" ] || valor=4096
  case "$valor" in
    ''|*[!0-9]*) printf 'ERRO: CRM_ALQUIMIA_HEAP_BUILD_MB=%s não é um número de megabytes (ex.: 2048).\n' "$valor" >&2; return 1 ;;
  esac
  if [ "$valor" -lt 1024 ] || [ "$valor" -gt 65536 ]; then
    printf 'ERRO: CRM_ALQUIMIA_HEAP_BUILD_MB=%s fora de 1024 a 65536.\n' "$valor" >&2
    return 1
  fi
  printf '%s' "$valor"
}

# ajustar_config_toml ARQUIVO PORTA_API PORTA_DB PORTA_APP [PROJETO]
# Reescreve as portas do Supabase local, as URLs de retorno do login e (se dado) o project_id. Idempotente:
# com os padrões o arquivo sai igual. (shadow = db - 2 e pooler = db + 7, como nos padrões 54320 e 54329.)
ajustar_config_toml() {
  local arquivo="$1" api="$2" db="$3" app="$4" projeto="${5:-}"
  awk -v api="$api" -v db="$db" -v shadow="$((db - 2))" -v pooler="$((db + 7))" -v app="$app" -v projeto="$projeto" '
    /^\[/ { secao = $0 }
    secao == "" && projeto != "" && /^project_id *=/ { print "project_id = \"" projeto "\""; next }
    secao == "[api]" && /^port *=/ { print "port = " api; next }
    secao == "[db]" && /^port *=/ { print "port = " db; next }
    secao == "[db]" && /^shadow_port *=/ { print "shadow_port = " shadow; next }
    secao == "[db.pooler]" && /^port *=/ { print "port = " pooler; next }
    secao == "[studio]" && /^api_url *=/ { print "api_url = \"http://127.0.0.1:" api "\""; next }
    secao == "[auth]" && /^site_url *=/ { print "site_url = \"http://localhost:" app "\""; next }
    secao == "[auth]" && /"http:\/\/localhost:[0-9]+\/auth\// { sub(/localhost:[0-9]+/, "localhost:" app) }
    { print }
  ' "$arquivo" > "$arquivo.novo"
  if cmp -s "$arquivo" "$arquivo.novo"; then rm -f "$arquivo.novo"; else mv "$arquivo.novo" "$arquivo"; fi
}

# --- Permissões: só o dono -------------------------------------------------------------------------
# Nos Linux e Mac `chmod` basta. No Git Bash do Windows (uname MINGW/MSYS/CYGWIN) o `chmod` NÃO muda a
# ACL do NTFS: o arquivo continua herdando as permissões da pasta (em geral, legível por todos os usuários
# do PC). Por isso, lá, o icacls tira a herança e dá acesso só ao usuário atual.

# restringir_acl_windows CAMINHO [PERMISSAO]: no-op fora do Windows. PERMISSAO padrão (R,W,D) (arquivo; o D
# deixa o próprio dono apagá-lo);
# para pasta use (OI)(CI)(F). Se o icacls falhar, AVISA no stderr (não derruba o script).
restringir_acl_windows() {
  local alvo="$1" perm="${2:-}" usuario caminho
  [ -n "$perm" ] || perm="(R,W,D)"
  case "$(uname -s 2>/dev/null || true)" in MINGW*|MSYS*|CYGWIN*) ;; *) return 0 ;; esac
  usuario="${USERNAME:-$(whoami 2>/dev/null || true)}"
  if [ -n "${USERDOMAIN:-}" ]; then usuario="${USERDOMAIN}\\${usuario}"; fi
  caminho="$(cygpath -w "$alvo" 2>/dev/null || printf '%s' "$alvo")"
  # /reset primeiro: tira as ACEs EXPLÍCITAS que já existiam (ex.: "Todos" dado à mão), que o
  # /inheritance:r sozinho não remove; depois corta a herança e deixa só o dono.
  # Os dois rodam SEMPRE (como no .ps1): se o /reset falhar, o corte da herança ainda tem de acontecer.
  local falhou=0
  MSYS_NO_PATHCONV=1 icacls "$caminho" /reset >/dev/null 2>&1 || falhou=1
  MSYS_NO_PATHCONV=1 icacls "$caminho" /inheritance:r /grant:r "${usuario}:${perm}" >/dev/null 2>&1 || falhou=1
  if [ "$falhou" -ne 0 ]; then
    printf 'AVISO: não consegui restringir as permissões de %s com o icacls; confira que só o seu usuário do Windows acessa esse arquivo.\n' "$alvo" >&2
  fi
}

# restringir_ao_dono ARQUIVO: chmod 600 e, no Windows, ACL só do dono.
restringir_ao_dono() {
  chmod 600 "$1" 2>/dev/null || true
  restringir_acl_windows "$1" "(R,W,D)"
}

# restringir_pasta_ao_dono PASTA: chmod 700 e, no Windows, ACL só do dono com herança para o que nascer
# dentro (é isso que protege os arquivos criados depois, inclusive os que o `docker cp` grava).
restringir_pasta_ao_dono() {
  chmod 700 "$1" 2>/dev/null || true
  restringir_acl_windows "$1" "(OI)(CI)(F)"
}

# ativar_chave_de_cifra ARQUIVO_ENV CONTEINER_DO_BANCO
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
ativar_chave_de_cifra() {
  local arquivo="$1" conteiner="$2" no_banco chave do_env
  no_banco="$(docker exec "$conteiner" psql -U postgres -d postgres -At -c \
    "select exists(select 1 from private.app_secrets where name = 'nuvemshop_oauth_key' and length(value) >= 32)" | tr -d '\r')" || {
    printf 'ERRO: não consegui ler a chave de cifra do banco (%s).\n' "$conteiner" >&2
    return 1
  }
  if [ "$no_banco" = "t" ]; then
    chave="$(docker exec "$conteiner" psql -U postgres -d postgres -At -c \
      "select value from private.app_secrets where name = 'nuvemshop_oauth_key'" | tr -d '\r')" || {
      printf 'ERRO: não consegui ler a chave de cifra do banco (%s).\n' "$conteiner" >&2
      return 1
    }
    if [ "${#chave}" -lt 32 ]; then
      unset chave
      printf 'ERRO: não consegui ler a chave de cifra do banco (%s).\n' "$conteiner" >&2
      return 1
    fi
    do_env="$(valor_do_env "$arquivo" NUVEMSHOP_OAUTH_ENCRYPTION_KEY)"
    if [ -n "$do_env" ] && [ "$do_env" != "$chave" ]; then
      printf '%s\n' 'AVISO: o .env.local tinha OUTRA chave de cifra (NUVEMSHOP_OAUTH_ENCRYPTION_KEY) e ela foi trocada pela que este banco já usa (o banco manda: trocar a dele tornaria ilegível o que já foi cifrado). Se a outra chave era a de um backup de outra instalação, os segredos cifrados daquele backup não abrem nesta. Para restaurá-lo numa máquina nova, o .env.local antigo tem de estar na pasta ANTES de instalar.' >&2
    fi
    unset do_env
    definir_env "$arquivo" NUVEMSHOP_OAUTH_ENCRYPTION_KEY "$chave" sempre
    unset chave
    return 0
  fi
  chave="$(valor_do_env "$arquivo" NUVEMSHOP_OAUTH_ENCRYPTION_KEY)"
  if [ "${#chave}" -lt 32 ]; then
    chave="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
    definir_env "$arquivo" NUVEMSHOP_OAUTH_ENCRYPTION_KEY "$chave" sempre
  fi
  # Aspas simples dobradas: o valor entra como literal SQL (a chave gerada é hex; a copiada pode não ser).
  if ! printf "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '%s') on conflict (name) do update set value = excluded.value, updated_at = now() where length(private.app_secrets.value) < 32;\n" \
    "${chave//\'/\'\'}" | docker exec -i "$conteiner" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q >/dev/null; then
    unset chave
    printf 'ERRO: não consegui gravar a chave de cifra no banco (%s). Rode o instalador de novo; se repetir, abra uma issue com a mensagem acima.\n' "$conteiner" >&2
    return 1
  fi
  unset chave
}
