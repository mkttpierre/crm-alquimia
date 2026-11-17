#!/usr/bin/env bash
# Funções de backup e restauração do CRM ALQUIM(IA), separadas de `scripts/backup.sh` e
# `scripts/restaurar.sh` para poderem ser EXECUTADAS por teste (tests/unit/backup-restauracao-executavel.test.ts)
# com um `docker` falso. Só define funções: `source` não faz nada. Exige umask 077 do chamador.
#
# O que entra no backup (e o que não entra):
#   - os DADOS do banco do Supabase local (schemas public, auth e storage), por pg_dump DENTRO do contêiner
#     do banco (usa o socket local: nenhuma senha, nenhuma porta, nada de segredo em argumento de processo);
#   - os ARQUIVOS do Storage (mídias, logos, exportações), copiados do contêiner do Storage.
#   Fora: as conexões do WhatsApp (volume da Evolution; é só reconectar o QR) e o `.env.local` (segredos:
#   guarde por conta própria, num lugar seguro).

# shellcheck source=instalar-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/instalar-env.sh"

# O projeto vem do .env.local DESTA pasta (quem chama já fez `cd` para a raiz do CRM).
BACKUP_PROJETO="$(projeto_da_instalacao .env.local)"
BACKUP_DB="supabase_db_${BACKUP_PROJETO}"
BACKUP_STORAGE="supabase_storage_${BACKUP_PROJETO}"
BACKUP_STORAGE_DIR="${CRM_ALQUIMIA_STORAGE_DIR:-/mnt}"
BACKUP_DIR="${CRM_ALQUIMIA_BACKUP_DIR:-backups}"
BACKUP_MANTER=14
BACKUP_NOME_REGEX='^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}(-[0-9]+)?$'
BACKUP_BASELINE="supabase/baseline.sql"
BACKUP_CRIADO=""

backup_log()  { printf '==> %s\n' "$*"; }
backup_erro() { printf 'ERRO: %s\n' "$*" >&2; }

# --- Avisos do Postgres: para o log, não para a tela --------------------------------------
# O pg_dump avisa de chaves estrangeiras circulares e a carga da restauração solta um NOTICE por tabela
# esvaziada: centenas de linhas que, na tela, parecem erro e não são. Elas vão para logs/backup.log e
# logs/restaurar.log (na raiz do CRM); na tela ficam o resumo e as linhas de erro de verdade.
BACKUP_LOG_DIR="logs"
BACKUP_AVISOS=0

# erros_do_postgres: lê a saída de erro de um comando e imprime só o que é erro de verdade (ERROR, FATAL,
# PANIC, "error:" das ferramentas e "Error" do docker), com o DETAIL/HINT/CONTEXT que vem logo depois.
erros_do_postgres() {
  tr -d '\r' | awk '
    /(ERROR|FATAL|PANIC):/ || /(^|[^A-Za-z])error:/ || /^Error/ { print; segue = 1; next }
    segue && /^(DETAIL|HINT|CONTEXT|LINE [0-9]+):/ { print; next }
    { segue = 0 }
  '
}

# sem_dados_da_linha: tira do texto os VALORES que o Postgres cita num erro, que podem ser dados pessoais de
# um contato. Ficam a coluna, a tabela, a linha e a causa. Cobre:
#   DETAIL  Key (email)=(...) / Key (lower(email::text))=(...) already exists | is not present | ...
#   DETAIL  Failing row contains (...)
#   CONTEXT COPY tabela, line N[, column c]: "..."   (a carga do backup é COPY: é a linha do contato)
#   ERROR   invalid input syntax for type integer: "..."  /  invalid input value for enum x: "..."
#   ERROR   date/time field value out of range: "..."  /  value "..." is out of range for type integer
#   DETAIL  Token "..." is invalid.  /  CONTEXT JSON data, line N: ...  
# O valor de um Key vai até o ")" seguido da causa; sem causa conhecida, até o primeiro ")" (os dois lados de
# "conflicts with existing key (c)=(b)" saem mascarados).
sem_dados_da_linha() {
  sed -E \
    -e 's/\)=\(.*\) (already exists|is not present in table|is still referenced from table)/)=(omitido) \1/' \
    -e 's/\)=\([^)]*\)/)=(omitido)/g' \
    -e 's/(Failing row contains )\(.*\)/\1(omitido)/' \
    -e 's/(COPY [^,]+, line [0-9]+(, column [^:]+)?): .*/\1: (omitido)/' \
    -e 's/(invalid input (syntax|value)[^:]*): ".*"/\1: "(omitido)"/' \
    -e 's/(out of range[^:]*): ".*"/\1: "(omitido)"/' \
    -e 's/(value )".*"( is out of range)/\1"(omitido)"\2/' \
    -e 's/(Token )".*"( is invalid)/\1"(omitido)"\2/' \
    -e 's/(JSON data, line [0-9]+): .*/\1: (omitido)/'
}

# Logs: só do dono (como backups/ e o .env.local) a CADA execução, também se a pasta já existia e nos
# girados; girados quando passam de 256 KB (guardo os 3 anteriores).
BACKUP_LOG_MAX_BYTES=262144
preparar_log() {
  local log="$1" pasta tam n f
  pasta="$(dirname "$log")"
  mkdir -p "$pasta"
  restringir_pasta_ao_dono "$pasta"
  if [ -f "$log" ]; then
    tam="$(wc -c < "$log" | tr -d ' ')"
    if [ "$tam" -gt "$BACKUP_LOG_MAX_BYTES" ]; then
      rm -f "$log.3"
      for n in 2 1; do if [ -f "$log.$n" ]; then mv -f "$log.$n" "$log.$((n + 1))"; fi; done
      mv -f "$log" "$log.1"
    fi
  fi
  for f in "$log" "$log.1" "$log.2" "$log.3"; do
    if [ -f "$f" ]; then restringir_ao_dono "$f"; fi
  done
}

# rodar_com_log LOG ROTULO COMANDO...: roda o comando com a saída de erro no LOG (acrescenta, com data e
# rótulo) e mostra na tela só os erros. BACKUP_AVISOS fica com o número de linhas que foram só para o log.
# Falhou sem nenhuma linha reconhecível (o docker sem conseguir rodar o programa, ou ele morto por falta de
# memória, código 137): mostra as últimas linhas da saída de erro, ou diz que não houve mensagem.
rodar_com_log() {
  local log="$1" rotulo="$2" err rc=0 erros
  shift 2
  preparar_log "$log"
  err="$(mktemp "${TMPDIR:-/tmp}/crm-postgres.XXXXXX")"
  "$@" 2>"$err" || rc=$?
  { printf '### %s %s (código %s)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$rotulo" "$rc"; tr -d '\r' < "$err" | sem_dados_da_linha; } >> "$log" || true
  chmod 600 "$log" 2>/dev/null || true
  erros="$(erros_do_postgres < "$err" || true)"
  if [ -n "$erros" ]; then
    printf '%s\n' "$erros" >&2
  elif [ "$rc" -ne 0 ]; then
    if grep -q . "$err"; then
      printf 'O comando saiu com o código %s. As últimas linhas da saída de erro:\n' "$rc" >&2
      tr -d '\r' < "$err" | grep . | tail -n 15 >&2 || true
    else
      printf 'O comando saiu com o código %s, sem nenhuma mensagem (o código 137 costuma ser falta de memória: o processo foi morto).\n' "$rc" >&2
    fi
  fi
  BACKUP_AVISOS="$(tr -d '\r' < "$err" | grep -c . || true)"
  rm -f "$err"
  return "$rc"
}

# caminho_para_docker CAMINHO: no Git Bash do Windows o docker.exe não entende o caminho MSYS (/c/...) (e o
# MSYS_NO_PATHCONV=1 desliga a conversão automática); cygpath -m vira C:/... Fora do Windows, igual.
caminho_para_docker() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) cygpath -m "$1" 2>/dev/null || printf '%s' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# --- Impressão da chave de cifra ----------------------------------------------------
# O backup não leva private.app_secrets: os segredos cifrados dele só abrem com a chave da instalação em que
# foi feito. O registro de versão guarda uma IMPRESSÃO da chave (12 hex do sha256, nunca a chave), e a
# restauração compara com a do banco e a do .env.local. Pasta e projeto iguais não provam chave igual
# (migração para outra máquina no mesmo caminho, ou recomeçar do zero na mesma pasta).

# impressao TEXTO: 12 hex do sha256 do texto (vazio se o texto for vazio). A chave chega por argumento de
# FUNÇÃO e vai ao sha256 pela entrada padrão (printf é embutido): nunca é argumento de um processo.
impressao() {
  local h
  [ -n "$1" ] || return 0
  if command -v sha256sum >/dev/null 2>&1; then h="$(printf '%s' "$1" | sha256sum)"; else h="$(printf '%s' "$1" | shasum -a 256)"; fi
  printf '%s' "${h:0:12}"
}

# impressao_da_chave_do_banco: a impressão da chave de cifra que o banco usa (vazio se não der para ler).
impressao_da_chave_do_banco() {
  local k
  k="$(docker exec "$BACKUP_DB" psql -U postgres -d postgres -At \
        -c "select value from private.app_secrets where name = 'nuvemshop_oauth_key'" 2>/dev/null | tr -d '\r' | head -n 1 || true)"
  impressao "$k"
  unset k
}

# chave_do_env_local ARQUIVO: só a linha NUVEMSHOP_OAUTH_ENCRYPTION_KEY, sem CR, espaços das pontas e um
# par de aspas (como o instalador grava no banco). Não é o leitor geral do .env.local.
chave_do_env_local() {
  sed -n 's/^NUVEMSHOP_OAUTH_ENCRYPTION_KEY=//p' "$1" 2>/dev/null | tr -d '\r' | tail -n 1 \
    | sed -E -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'\$/\1/" || true
}

# chave_do_backup_difere NOME [PASTA]: verdadeiro se a impressão da chave gravada no backup falta (backup
# antigo) ou é diferente da do banco ou da do .env.local desta instalação. Decide o lembrete final.
chave_do_backup_difere() {
  local nome="$1" dir="${2:-$BACKUP_DIR}" b d e
  b="$(sed -n 's/^chave=//p' "$dir/$nome-versao.txt" 2>/dev/null | tr -d '\r' | head -n 1 || true)"
  [ -n "$b" ] || return 0
  d="$(impressao_da_chave_do_banco)"
  # só a linha da chave, como no avisar_chave_de_cifra_divergente (o backup não lê o resto do .env.local)
  e="$(impressao "$(chave_do_env_local .env.local)")"
  if [ -n "$d" ] && [ "$d" != "$b" ]; then return 0; fi
  if [ -n "$e" ] && [ "$e" != "$b" ]; then return 0; fi
  if [ -z "$d" ] && [ -z "$e" ]; then return 0; fi
  return 1
}

# hash_do_schema: sha256 do supabase/baseline.sql SEM os \r (o mesmo arquivo dá o mesmo hash num checkout
# do Windows e no Linux). "ausente" se o arquivo não existir.
hash_do_schema() {
  local h
  [ -f "$BACKUP_BASELINE" ] || { printf 'ausente'; return 0; }
  if command -v sha256sum >/dev/null 2>&1; then
    h="$(tr -d '\r' < "$BACKUP_BASELINE" | sha256sum)"
  else
    h="$(tr -d '\r' < "$BACKUP_BASELINE" | shasum -a 256)"
  fi
  printf '%s' "${h%% *}"
}

# versao_instalada: current_version de public.system_version (vazio se não houver; é só leitura).
versao_instalada() {
  local v
  v="$(docker exec "$BACKUP_DB" psql -U postgres -d postgres -At \
        -c "select current_version from public.system_version where id = 1" 2>/dev/null || true)"
  printf '%s' "$v" | tr -d '\r' | head -n 1
}

# avisar_chave_de_cifra_divergente ARQUIVO_ENV: só AVISA (nunca recusa) quando a chave de cifra do .env.local
# não é a que o banco usa (private.app_secrets) — o caso de quem instalou antes de copiar o .env.local antigo.
# Nenhuma das duas chaves é impressa nem vai no argv: o valor do banco chega pela saída do psql.
avisar_chave_de_cifra_divergente() {
  local do_env do_banco
  do_env="$(chave_do_env_local "$1")"
  [ -n "$do_env" ] || return 0
  do_banco="$(docker exec "$BACKUP_DB" psql -U postgres -d postgres -At \
        -c "select value from private.app_secrets where name = 'nuvemshop_oauth_key'" 2>/dev/null | tr -d '\r' | head -n 1 || true)"
  if [ -n "$do_banco" ] && [ "$do_banco" != "$do_env" ]; then
    printf '%s\n' 'AVISO: a chave de cifra do .env.local (NUVEMSHOP_OAUTH_ENCRYPTION_KEY) é diferente da que este banco usa. Os segredos cifrados do backup (webhooks, tokens de integração, credencial do Google) só abrem com a chave da instalação em que o backup foi feito. Se este backup veio de outra instalação, cancele agora: ponha o .env.local dela na pasta do CRM ANTES de instalar e restaure de novo. Nenhuma das duas chaves é mostrada.' >&2
  fi
  unset do_env do_banco
}

# conferir_versao_do_backup NOME [PASTA]: recusa (return 1) backup sem registro de versão ou de outra versão.
conferir_versao_do_backup() {
  local nome="$1" dir="${2:-$BACKUP_DIR}" arq b_hash b_ver a_hash a_ver
  arq="$dir/$nome-versao.txt"
  if [ ! -f "$arq" ]; then
    backup_erro "O backup $nome não tem o registro de versão ($nome-versao.txt): foi feito por uma versão antiga do comando de backup."
    backup_erro "Sem saber em que versão do CRM ele foi feito, eu não restauro (restaurar em outra versão pode quebrar o CRM). Nada foi alterado."
    backup_erro "O que fazer: escolha um backup mais novo (feito depois desta atualização) ou, se este é o único, peça ajuda antes de restaurar à mão."
    return 1
  fi
  b_hash="$(sed -n 's/^baseline_sha256=//p' "$arq" | tr -d '\r' | head -n 1)"
  b_ver="$(sed -n 's/^current_version=//p' "$arq" | tr -d '\r' | head -n 1)"
  a_hash="$(hash_do_schema)"
  a_ver="$(versao_instalada)"
  if [ -z "$b_hash" ] || [ "$b_hash" = "ausente" ] || [ "$a_hash" = "ausente" ] || [ "$b_hash" != "$a_hash" ] \
     || { [ -n "$b_ver" ] && [ -n "$a_ver" ] && [ "$b_ver" != "$a_ver" ]; }; then
    backup_erro "O backup $nome foi feito com outra versão do CRM (backup: ${b_ver:-sem número}, esquema ${b_hash:0:12}; instalado agora: ${a_ver:-sem número}, esquema ${a_hash:0:12})."
    backup_erro "Restaurar dados de uma versão em outra pode quebrar o CRM, então eu não restauro. Nada foi alterado."
    backup_erro "O que fazer: volte o código do CRM para a versão do backup, rode o instalar (bash scripts/instalar.sh), restaure, e só depois atualize de novo. Ou escolha um backup feito nesta versão."
    return 1
  fi
}

# conferir_ambiente_docker: Docker de pé, contêineres do Supabase no ar e banco aceitando conexão.
# storage_dir_valido: CRM_ALQUIMIA_STORAGE_DIR é um caminho absoluto simples (vai a um `sh -c` dentro do
# contêiner do Storage, na limpeza da restauração): nada de espaço, ; $ ` nem a raiz sozinha.
storage_dir_valido() {
  printf '%s' "$BACKUP_STORAGE_DIR" | grep -Eq '^/[A-Za-z0-9._/-]*[A-Za-z0-9._-][A-Za-z0-9._/-]*$' || return 1
  # nenhum segmento . ou .. (rm -rf '/mnt/..'/* seria rm -rf /* dentro do contêiner)
  ! printf '%s/' "$BACKUP_STORAGE_DIR" | grep -Eq '/\.\.?/'
}

conferir_ambiente_docker() {
  local c
  storage_dir_valido || {
    backup_erro "CRM_ALQUIMIA_STORAGE_DIR=$BACKUP_STORAGE_DIR não é um caminho válido (use um caminho absoluto só com letras, números, . _ - e /, como /mnt). Nada foi alterado."
    return 1
  }
  command -v docker >/dev/null 2>&1 || { backup_erro "Docker não encontrado. Instale o Docker Desktop (https://www.docker.com/products/docker-desktop) e abra-o."; return 1; }
  docker info >/dev/null 2>&1 || { backup_erro "O Docker está instalado mas não está rodando. Abra o Docker Desktop, espere ele ficar verde e rode de novo."; return 1; }
  for c in "$BACKUP_DB" "$BACKUP_STORAGE"; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || true)" != "true" ]; then
      backup_erro "O Supabase local não está no ar (o contêiner $c está parado ou não existe). Suba o CRM com: bash scripts/instalar.sh"
      return 1
    fi
  done
  docker exec "$BACKUP_DB" pg_isready -U postgres >/dev/null 2>&1 || {
    backup_erro "O banco ainda não está aceitando conexões. Espere um minuto e rode de novo; se persistir, rode: bash scripts/instalar.sh"
    return 1
  }
}

# listar_backups [PASTA]: nomes (sem .sql.gz) dos backups completos, do MAIS VELHO ao mais novo.
listar_backups() {
  local dir="${1:-$BACKUP_DIR}"
  [ -d "$dir" ] || return 0
  { ls -1 "$dir" 2>/dev/null | sed -n 's/\.sql\.gz$//p' | grep -E "$BACKUP_NOME_REGEX" || true; } \
    | sort -t- -k1,1 -k2,2 -k3,3 -k4,4 -k5,5n
}

# estranhos_na_pasta PASTA: o que há na pasta e NÃO é peça de backup (backup, -storage, -versao.txt, trabalho
# parcial, a trava). Um por linha.
estranhos_na_pasta() {
  [ -d "$1" ] || return 0
  ls -1A "$1" 2>/dev/null \
    | grep -Ev '^([0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}(-[0-9]+)?(\.sql\.gz|-storage|-versao\.txt)|\.parcial-.*|\.restaurando-.*|\.trava-backup.*)$' \
    | grep -Eiv '^(desktop\.ini|\.ds_store|thumbs\.db|lost\+found)$' \
    || true
}

# so_arquivos_de_sistema PASTA: a pasta existe e não tem nada além de metadados do sistema (desktop.ini...).
so_arquivos_de_sistema() {
  [ -d "$1" ] || return 1
  [ -z "$(ls -1A "$1" 2>/dev/null | grep -Eiv '^(desktop\.ini|\.ds_store|thumbs\.db|lost\+found)$' || true)" ]
}

# preparar_pasta_de_backups PASTA: cria (700) e restringe ao dono; a ACL herdável protege o que nascer dentro.
# A ACL é TROCADA (só o dono, e os arquivos de dentro herdam isso), então a pasta tem de ser só dos backups.
# Pasta escolhida em CRM_ALQUIMIA_BACKUP_DIR (pode ser uma pasta do usuário, compartilhada) com outros
# arquivos: recusa sem mexer nela. Na pasta padrão (backups/, dentro do próprio CRM): avisa e segue.
preparar_pasta_de_backups() {
  local estranhos exemplos
  estranhos="$(estranhos_na_pasta "$1")"
  if [ -n "$estranhos" ]; then
    exemplos="$(printf '%s\n' "$estranhos" | head -3 | tr '\n' ' ')"
    if [ -n "${CRM_ALQUIMIA_BACKUP_DIR:-}" ]; then
      backup_erro "A pasta de backups $1 (CRM_ALQUIMIA_BACKUP_DIR) já tem outros arquivos (por exemplo: ${exemplos% })."
      backup_erro "Ela precisa ser só dos backups: eu deixo a pasta acessível apenas ao seu usuário, e isso mudaria as permissões desses arquivos. Nada foi alterado. Escolha uma pasta vazia (ou nova) em CRM_ALQUIMIA_BACKUP_DIR."
      return 1
    fi
    printf 'AVISO: a pasta %s tem arquivos que não são backups (por exemplo: %s). Ela fica acessível só ao seu usuário; guarde outras coisas em outro lugar.\n' "$1" "${exemplos% }" >&2
  elif [ -n "${CRM_ALQUIMIA_BACKUP_DIR:-}" ] && so_arquivos_de_sistema "$1"; then
    printf 'AVISO: a pasta %s já existia; daqui em diante ela fica acessível só ao seu usuário e deve guardar só os backups.\n' "$1" >&2
  fi
  mkdir -p "$1"
  restringir_pasta_ao_dono "$1"
}

# Um backup por vez na mesma pasta (o de segurança da restauração também): a trava é uma pasta, criada com
# mkdir (atômico). Trava com mais de 2 h é de um backup que morreu no meio: é quebrada.
BACKUP_TRAVA=".trava-backup"
trava_velha() { [ -n "$(find "$1" -maxdepth 0 -mmin +120 2>/dev/null)" ]; }
pegar_trava_de_backup() {
  local trava="$1/$BACKUP_TRAVA" marca="$1/$BACKUP_TRAVA.quebrando"
  if mkdir "$trava" 2>/dev/null; then BACKUP_TRAVA_TOMADA="$trava"; return 0; fi
  if trava_velha "$trava"; then
    # Só um processo por vez quebra a trava: a marca nasce com O_EXCL (set -C), que é atômico. Quem a criou
    # confere a idade de novo (outro pode ter acabado de quebrar e tomar uma trava nova) e só então apaga.
    # Marca abandonada (o processo morreu quebrando) com mais de 10 min sai do caminho.
    if [ -n "$(find "$marca" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rm -f "$marca"; fi
    if ( set -C; : > "$marca" ) 2>/dev/null; then
      if trava_velha "$trava"; then
        rm -rf "$trava"
        backup_log "Achei uma trava de backup com mais de 2 horas (de um backup que não terminou); vou ignorá-la"
        if mkdir "$trava" 2>/dev/null; then
          BACKUP_TRAVA_TOMADA="$trava"
          rm -f "$marca"
          return 0
        fi
      fi
      rm -f "$marca"
    fi
  fi
  backup_erro "Outro backup (ou uma restauração) está rodando agora nesta pasta ($1). Espere ele terminar e rode de novo. Nada foi alterado."
  backup_erro "Se tem certeza de que nenhum backup ou restauração está rodando (por exemplo, o computador desligou no meio de um), apague a pasta $trava e rode de novo. Depois de 2 horas ela é ignorada sozinha."
  return 1
}
soltar_trava_de_backup() { rm -rf "$1/$BACKUP_TRAVA"; }
# renovar_trava PASTA: marca que o backup segue vivo (um backup longo não pode ter a trava tida como velha).
renovar_trava() { touch "$1/$BACKUP_TRAVA" 2>/dev/null || true; }

# O que um backup interrompido (Ctrl+C, kill, erro) tem de desfazer: a trava e o trabalho parcial.
BACKUP_TRAVA_TOMADA=""
BACKUP_PARCIAL=""
soltar_trava_pendente() {
  if [ -n "$BACKUP_PARCIAL" ]; then rm -rf "$BACKUP_PARCIAL"; BACKUP_PARCIAL=""; fi
  if [ -n "$BACKUP_TRAVA_TOMADA" ]; then rm -rf "$BACKUP_TRAVA_TOMADA"; BACKUP_TRAVA_TOMADA=""; fi
}
# BACKUP_AO_SAIR: o que quem chama (o restaurar.sh) precisa rodar na saída, depois de soltar a trava. Uma
# limpeza só, sempre a mesma: nada de ler o trap anterior pela opção -p do trap (no bash 3.2 do macOS, dentro de
# $(...), ele pode voltar vazio e o trap de quem chamou se perderia).
BACKUP_AO_SAIR=""
limpeza_ao_sair() {
  soltar_trava_pendente
  if [ -n "$BACKUP_AO_SAIR" ]; then "$BACKUP_AO_SAIR"; fi
}
# instalar_limpeza: Ctrl+C (INT) e kill (TERM) saem pelo EXIT, que roda a limpeza.
instalar_limpeza() {
  trap limpeza_ao_sair EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# apertar_permissoes_de CAMINHO: pastas 700, arquivos 600 (o `docker cp` pode ter criado 644/755).
apertar_permissoes_de() {
  find "$1" -type d -exec chmod 700 {} + 2>/dev/null || true
  find "$1" -type f -exec chmod 600 {} + 2>/dev/null || true
}

# criar_backup [PASTA]: grava PASTA/AAAA-MM-DD-HHMM.sql.gz, PASTA/AAAA-MM-DD-HHMM-storage/ e
# PASTA/AAAA-MM-DD-HHMM-versao.txt (sha256 do schema e versão instalada). O nome do backup criado fica em
# BACKUP_CRIADO, e SÓ depois de conferir que as três peças existem no lugar final (o .sql.gz é o último a
# ser movido): falha no meio não deixa backup que pareça bom. NÃO aplica retenção (quem decide é o chamador).
criar_backup() {
  local dir="${1:-$BACKUP_DIR}" rc=0
  BACKUP_CRIADO=""
  # A limpeza entra ANTES de tomar a trava (que se registra em BACKUP_TRAVA_TOMADA no mesmo passo em que é
  # criada): Ctrl+C, kill (TERM) ou erro em qualquer ponto soltam a trava, e o BACKUP_AO_SAIR de quem chamou
  # (o restaurar.sh religa os serviços) roda logo depois.
  instalar_limpeza
  if preparar_pasta_de_backups "$dir" && pegar_trava_de_backup "$dir"; then
    criar_backup_com_trava "$dir" || rc=$?
  else
    rc=1
  fi
  soltar_trava_pendente
  return "$rc"
}

# criar_backup_com_trava PASTA: o trabalho do criar_backup, com a pasta pronta e a trava já tomada.
criar_backup_com_trava() {
  local dir="$1" base nome n=1 tmp dump
  base="$(date +%Y-%m-%d-%H%M)"
  nome="$base"
  while [ -e "$dir/$nome.sql.gz" ] || [ -e "$dir/$nome-storage" ] || [ -e "$dir/$nome-versao.txt" ]; do
    n=$((n + 1)); nome="$base-$n"
  done
  tmp="$dir/.parcial-$nome"
  BACKUP_PARCIAL="$tmp"
  # nome único no contêiner: dois backups ao mesmo tempo não se pisam
  dump="/tmp/crm-backup-$nome.sql"
  rm -rf "$tmp"
  mkdir -p "$tmp/storage"

  backup_log "Copiando o banco de dados"
  if ! rodar_com_log "$BACKUP_LOG_DIR/backup.log" "pg_dump $nome" \
        docker exec "$BACKUP_DB" pg_dump -U postgres -d postgres --data-only --no-owner --no-privileges \
        --schema=public --schema=auth --schema=storage \
        --exclude-table-data=auth.schema_migrations --exclude-table-data=storage.migrations \
        -f "$dump"; then
    backup_erro "O pg_dump falhou (veja o erro acima; o registro completo está em $BACKUP_LOG_DIR/backup.log). Nenhum backup foi criado."
    rm -rf "$tmp"; return 1
  fi
  if [ "$BACKUP_AVISOS" -gt 0 ]; then
    backup_log "O pg_dump deixou $BACKUP_AVISOS linhas de aviso (normais, não são erro) em $BACKUP_LOG_DIR/backup.log"
  fi
  if ! docker cp "$BACKUP_DB:$dump" "$(caminho_para_docker "$tmp/banco.sql")"; then
    backup_erro "Não consegui tirar a cópia do banco de dentro do Docker. Nenhum backup foi criado."
    docker exec "$BACKUP_DB" rm -f "$dump" >/dev/null 2>&1 || true
    rm -rf "$tmp"; return 1
  fi
  docker exec "$BACKUP_DB" rm -f "$dump" >/dev/null 2>&1 || true
  if [ ! -s "$tmp/banco.sql" ]; then
    backup_erro "A cópia do banco saiu vazia. Nenhum backup foi criado."
    rm -rf "$tmp"; return 1
  fi

  renovar_trava "$dir"
  backup_log "Copiando os arquivos (Storage)"
  if ! docker cp "$BACKUP_STORAGE:${BACKUP_STORAGE_DIR}/." "$(caminho_para_docker "$tmp/storage")"; then
    backup_erro "Não consegui copiar os arquivos do Storage (${BACKUP_STORAGE_DIR} no contêiner $BACKUP_STORAGE). Nenhum backup foi criado."
    rm -rf "$tmp"; return 1
  fi

  renovar_trava "$dir"
  printf 'baseline_sha256=%s\ncurrent_version=%s\nchave=%s\n' "$(hash_do_schema)" "$(versao_instalada)" "$(impressao_da_chave_do_banco)" > "$tmp/versao.txt" \
    || { backup_erro "Não consegui gravar o registro de versão. Nenhum backup foi criado."; rm -rf "$tmp"; return 1; }
  gzip -c "$tmp/banco.sql" > "$tmp/banco.sql.gz" || { backup_erro "Falha ao compactar o banco. Nenhum backup foi criado."; rm -rf "$tmp"; return 1; }
  rm -f "$tmp/banco.sql"
  apertar_permissoes_de "$tmp"
  if ! mv "$tmp/storage" "$dir/$nome-storage" \
     || ! mv "$tmp/versao.txt" "$dir/$nome-versao.txt" \
     || ! mv "$tmp/banco.sql.gz" "$dir/$nome.sql.gz"; then
    backup_erro "Não consegui pôr o backup no lugar final em $dir/. Nenhum backup foi criado."
    rm -rf "$dir/$nome-storage" "$dir/$nome-versao.txt" "$dir/$nome.sql.gz" "$tmp"
    return 1
  fi
  rm -rf "$tmp"
  BACKUP_PARCIAL=""
  if [ ! -s "$dir/$nome.sql.gz" ] || [ ! -d "$dir/$nome-storage" ] || [ ! -s "$dir/$nome-versao.txt" ]; then
    backup_erro "O backup não ficou completo em $dir/ (falta o banco, os arquivos ou o registro de versão). Nenhum backup foi criado."
    rm -rf "$dir/$nome-storage" "$dir/$nome-versao.txt" "$dir/$nome.sql.gz"
    return 1
  fi
  apertar_permissoes_de "$dir/$nome-storage"
  chmod 600 "$dir/$nome.sql.gz" "$dir/$nome-versao.txt" 2>/dev/null || true
  BACKUP_CRIADO="$nome"
}

# limpar_sobras PASTA: apaga trabalho interrompido (.parcial-*, .restaurando-*) com mais de 1 dia.
# Mais novo que isso pode ser um backup ou uma restauração rodando agora.
limpar_sobras() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -mindepth 1 -maxdepth 1 \( -name '.parcial-*' -o -name '.restaurando-*' \) -mmin +1440 \
    -exec rm -rf {} + 2>/dev/null || true
}

# aplicar_retencao PASTA MANTER ATUAL: apaga os backups mais velhos, deixando só os MANTER mais novos.
# Nunca apaga ATUAL (o recém-criado) nem arquivo que não tenha nome de backup.
aplicar_retencao() {
  local dir="$1" manter="$2" atual="$3" total apagar velho
  limpar_sobras "$dir"
  total="$(listar_backups "$dir" | wc -l | tr -d ' ')"
  [ "$total" -gt "$manter" ] || return 0
  apagar=$((total - manter))
  while IFS= read -r velho; do
    [ -n "$velho" ] || continue
    [ "$velho" != "$atual" ] || continue
    rm -f "$dir/$velho.sql.gz" "$dir/$velho-versao.txt"
    rm -rf "$dir/$velho-storage"
    backup_log "Backup antigo apagado (guardo só os $manter mais novos): $velho"
  done < <(listar_backups "$dir" | head -n "$apagar")
}

# backup_integro NOME [PASTA]: o .sql.gz existe e é um gzip íntegro.
backup_integro() {
  local nome="$1" dir="${2:-$BACKUP_DIR}"
  [ -f "$dir/$nome.sql.gz" ] && gzip -t "$dir/$nome.sql.gz" >/dev/null 2>&1
}

# restaurar_do_backup NOME [PASTA]: carrega o banco (numa transação só: erro = nada muda) e depois os
# arquivos do Storage. Pré-requisitos (Docker de pé, backup íntegro, confirmação, backup do estado atual)
# são do chamador. Retorna 1 se o banco falhou (nada mudou) e 2 se o banco foi restaurado mas o Storage não.
restaurar_do_backup() {
  local nome="$1" dir="${2:-$BACKUP_DIR}" tmp prelude rc=0
  prelude="$(dirname "${BASH_SOURCE[0]}")/../restaurar-preludio.sql"
  tmp="$dir/.restaurando-$$"
  rm -rf "$tmp"; mkdir -p "$tmp"

  backup_log "Restaurando o banco de dados"
  gzip -dc "$dir/$nome.sql.gz" > "$tmp/dados.sql" || { backup_erro "Não consegui descompactar o backup."; rm -rf "$tmp"; return 1; }
  if ! docker cp "$(caminho_para_docker "$prelude")" "$BACKUP_DB:/tmp/crm-prelude.sql" \
     || ! docker cp "$(caminho_para_docker "$tmp/dados.sql")" "$BACKUP_DB:/tmp/crm-restaurar.sql"; then
    backup_erro "Não consegui enviar o backup para dentro do Docker."
    rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"
  # Como supabase_admin (o dono das tabelas e sequências de auth.* e storage.*): como postgres, o TRUNCATE
  # ... RESTART IDENTITY do prelúdio dá "must be owner of sequence refresh_tokens_id_seq" e a restauração
  # nunca acontece. Pelo socket de dentro do contêiner, sem senha.
  rodar_com_log "$BACKUP_LOG_DIR/restaurar.log" "restaurar $nome" \
    docker exec "$BACKUP_DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -q \
    -f /tmp/crm-prelude.sql -f /tmp/crm-restaurar.sql >/dev/null || rc=$?
  docker exec "$BACKUP_DB" rm -f /tmp/crm-prelude.sql /tmp/crm-restaurar.sql >/dev/null 2>&1 || true
  if [ "$rc" -ne 0 ]; then
    backup_erro "A restauração do banco falhou e foi DESFEITA: o banco continua como estava antes. O erro está acima; o registro completo, em $BACKUP_LOG_DIR/restaurar.log."
    return 1
  fi
  if [ "$BACKUP_AVISOS" -gt 0 ]; then
    backup_log "A carga deixou $BACKUP_AVISOS linhas de aviso do Postgres (normais, não são erro) em $BACKUP_LOG_DIR/restaurar.log"
  fi

  if [ -d "$dir/$nome-storage" ]; then
    backup_log "Restaurando os arquivos (Storage): apago os arquivos de agora e copio os do backup"
    case "$BACKUP_STORAGE_DIR" in /?*) ;; *) backup_erro "CRM_ALQUIMIA_STORAGE_DIR inválido: $BACKUP_STORAGE_DIR"; return 2 ;; esac
    docker exec "$BACKUP_STORAGE" sh -c "rm -rf '${BACKUP_STORAGE_DIR}'/* '${BACKUP_STORAGE_DIR}'/.[!.]*" >/dev/null 2>&1 || true
    if ! docker cp "$(caminho_para_docker "$dir/$nome-storage")/." "$BACKUP_STORAGE:${BACKUP_STORAGE_DIR}/"; then
      backup_erro "O banco foi restaurado, mas não consegui devolver os arquivos do Storage."
      return 2
    fi
  else
    backup_log "Este backup não tem pasta de arquivos (Storage): os arquivos atuais ficam como estão"
  fi
}
