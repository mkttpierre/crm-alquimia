#!/usr/bin/env bash
#
# CRM ALQUIM(IA): instalação local de UM comando (Linux, Mac e Git Bash no Windows).
#
#   bash scripts/instalar.sh
#
# Faz, nesta ordem: confere Docker, Node 22 e a CLI do Supabase (usa `npx supabase` se faltar)
# -> gera os segredos aleatórios do .env.local (SEM imprimir nenhum) -> constrói as imagens uma por vez
# -> sobe o Supabase local -> aplica supabase/baseline.sql -> grava as chaves do `supabase status` no
# .env.local -> docker compose up -d -> espera o app e o worker responderem -> abre http://localhost:3000/signup.
#
# É IDEMPOTENTE: rodar de novo não apaga banco, volume nem segredo. Os segredos que já existem no
# .env.local são mantidos; o baseline é reaplicado em modo de atualização.
#
# Variáveis (todas opcionais):
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
#   CRM_ALQUIMIA_ESPERA_FIM_DO_BUILD_S (30)  build interrompido (Ctrl+C, TERM): quanto esperar o
#                                        `docker compose build` do projeto sair antes de religar o Supabase
#
# Se o `supabase start` falhar (por exemplo, depois de um instalador interrompido no meio dele), o instalador
# tenta UMA vez `supabase stop --project-id <projeto>` (guarda os dados) e um novo `start`.
#
# Ao lado de outro sistema: antes de tocar em qualquer coisa, confere que cada porta está livre (ou é do
# próprio CRM); ocupada, para e diz qual variável trocar. Todo `docker compose` leva `-p <projeto>`.
set -euo pipefail

# Tudo o que este script cria (principalmente o .env.local, com segredos) nasce só para o dono: 600/700.
umask 077

# Git Bash converte argumentos que parecem caminho Unix (`container:/tmp/x`); isto desliga. Inofensivo fora dele.
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
ENV_LOCAL=".env.local"

# shellcheck source=lib/instalar-env.sh
source scripts/lib/instalar-env.sh

log()   { printf '==> %s\n' "$*"; }
falha() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

# Portas e projeto: variável do ambiente > o que já está no .env.local > padrão. Só LÊ: nada é gravado
# antes de conferir que as portas estão livres.
PROJETO="$(projeto_resolvido "$ENV_LOCAL")" || falha "Escolha outro nome em CRM_ALQUIMIA_PROJETO. Nada foi alterado."
HEAP_BUILD_MB="$(heap_do_build "$ENV_LOCAL")" || falha "Nada foi alterado."
BUILD_CPUS="$(cpus_do_build "$ENV_LOCAL")" || falha "Nada foi alterado."
MODO_PARAR_BANCO="$(modo_parar_banco "$ENV_LOCAL")" || falha "Nada foi alterado."
LIMIAR_PARAR_BANCO_MB="$(limiar_parar_banco_mb "$ENV_LOCAL")" || falha "Nada foi alterado."
PORTA_APP="$(porta_resolvida "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_APP 3000)"
PORTA_WORKER="$(porta_resolvida "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_WORKER 8787)"
PORTA_EVOLUTION="$(porta_resolvida "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_EVOLUTION 8080)"
PORTA_API="$(porta_resolvida "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_SUPABASE_API 54321)"
PORTA_DB="$(porta_resolvida "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_SUPABASE_DB 54322)"

# --- 0. Se uma execução anterior morreu com as migrations fora do lugar, devolve ------------------
restaurar_migracoes() {
  if [ -d supabase/.migracoes-fora ]; then
    rm -rf supabase/migrations
    mv supabase/.migracoes-fora supabase/migrations
  fi
}
restaurar_migracoes

# Onde o erro do último `supabase start` fica guardado: o stderr (o progresso) e, do stdout, só as linhas de erro
# da CLI, sem nada com forma de chave (o resto do stdout, com as chaves, não).
ERRO_DO_START="$(mktemp)"

# Sobe o Supabase deste CRM. A cadeia de migrations não sobe num banco novo: o que se aplica é o
# baseline.sql. A pasta sai do caminho só durante o `start` e volta ao lugar logo depois (e no trap).
# A saída do `start` traz as chaves do banco: dela, só as linhas de erro passam. O progresso fica no stderr.
# -x: sobe só o que o CRM usa (sem painel, e-mail de teste e redimensionador de imagens).
subir_supabase() {
  local codigo=0
  if [ -d supabase/migrations ]; then
    mv supabase/migrations supabase/.migracoes-fora
  fi
  mkdir -p supabase/migrations
  # O stderr (o progresso e o erro) segue para a tela E fica guardado: se o start falhar, as últimas linhas
  # vão na mensagem final. Do stdout passa só o erro (a CLI 2.120 o escreve ali, em JSON); o resto, com as
  # chaves, vai fora.
  : > "$ERRO_DO_START"
  rm -f "$ERRO_DO_START.codigo"
  { { supabase_crm start -x "$SUPABASE_SERVICOS_FORA" 2>&3 | linhas_de_erro_da_cli >&3 || echo "${PIPESTATUS[0]}" > "$ERRO_DO_START.codigo"; } 3>&1; } | tee -a "$ERRO_DO_START" >&2
  if [ -f "$ERRO_DO_START.codigo" ]; then codigo="$(cat "$ERRO_DO_START.codigo")"; rm -f "$ERRO_DO_START.codigo"; fi
  restaurar_migracoes
  return "$codigo"
}

# Um instalador morto no meio do `supabase start` deixa o contêiner do banco em
# `Created`, e o `start` seguinte sai com 1 sem mensagem nenhuma. O que destrava é `supabase stop
# --project-id <projeto>` (guarda os dados; nunca `--no-backup`). Tenta isso UMA vez e um novo `start`; se
# falhar de novo, diz o que fazer e mostra as últimas linhas do erro.
subir_supabase_com_recuperacao() {
  if subir_supabase; then return 0; fi
  log "O 'supabase start' falhou. Tentando destravar uma vez: 'supabase stop --project-id ${PROJETO}' (guarda os dados) e um novo 'start'."
  # O erro da primeira tentativa fica guardado: se a segunda falhar por outro motivo, a mensagem mostra os dois.
  cp "$ERRO_DO_START" "$ERRO_DO_START.primeira" 2>/dev/null || : > "$ERRO_DO_START.primeira"
  $SUPABASE stop --project-id "$PROJETO" --workdir . >/dev/null || true
  if subir_supabase; then rm -f "$ERRO_DO_START.primeira"; return 0; fi
  printf 'ERRO: %s\n' "O 'supabase start' falhou duas vezes, a segunda depois de um 'supabase stop' (os dados ficam). Rode 'bash scripts/parar.sh' (no Windows, scripts\\parar.ps1) e depois este instalador de novo. Últimas linhas do erro do 'supabase start':" >&2
  local tentativa arquivo linhas
  for tentativa in primeira segunda; do
    if [ "$tentativa" = primeira ]; then arquivo="$ERRO_DO_START.primeira"; else arquivo="$ERRO_DO_START"; fi
    printf '  %s\n' "Na $tentativa tentativa:" >&2
    # O progresso da CLI vem com \r de spinner: cada quadro vira linha, e as vazias saem. O aviso da seção
    # [inbucket] obsoleta sai em toda execução e não diz nada da falha: fica de fora.
    linhas=""
    if [ -s "$arquivo" ]; then
      linhas="$(tr '\r' '\n' < "$arquivo" | sed -e '/^[[:space:]]*$/d' -e '/\[inbucket\]/d' | mascarar_segredos | tail -n 15)"
    fi
    if [ -n "$linhas" ]; then
      printf '%s\n' "$linhas" | sed 's/^/    /' >&2
    else
      printf '    %s\n' "(o 'supabase start' não escreveu nenhuma mensagem)" >&2
    fi
  done
  rm -f "$ERRO_DO_START.primeira"
  return 1
}

# O build roda em segundo plano (BUILD_PID) para que um Ctrl+C ou um TERM no
# instalador chegue ao trap na hora, e não só depois do fim da compilação. Antes de religar o banco, o trap
# pede o fim do build DESTE projeto: encerra o `docker compose build` filho e o que ele abriu (o buildx) e
# espera ele sair, com teto (CRM_ALQUIMIA_ESPERA_FIM_DO_BUILD_S, 30 s). Nada de `builder prune` nem de
# comando que atinja outros projetos. O que já está dentro do Docker sem cliente não tem como ser parado só
# deste projeto: aí o aviso diz como conferir.
BUILD_PID=""
BUILD_INTERROMPIDO=0
encerrar_build_do_projeto() {
  [ -n "$BUILD_PID" ] || return 0
  local pid="$BUILD_PID" teto="${CRM_ALQUIMIA_ESPERA_FIM_DO_BUILD_S:-30}" i=0
  BUILD_PID=""
  BUILD_INTERROMPIDO=1
  if kill -0 "$pid" 2>/dev/null; then
    log "Pedindo o fim do build deste CRM (o 'docker compose build' do projeto ${PROJETO}) antes de seguir"
    if [ -r "/proc/$pid/winpid" ] && command -v taskkill >/dev/null 2>&1; then
      # Git Bash: o docker é um programa do Windows; o taskkill /T leva junto o que ele abriu.
      taskkill /T /F /PID "$(cat "/proc/$pid/winpid")" >/dev/null 2>&1 || true
    fi
    if command -v pkill >/dev/null 2>&1; then pkill -TERM -P "$pid" 2>/dev/null || true; fi
    kill -TERM "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$teto" ]; do sleep 1; i=$((i + 1)); done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  fi
}
aviso_build_pode_seguir() {
  log "ATENÇÃO: um build interrompido pode seguir compilando dentro do Docker por alguns minutos (e usando memória). Confira com 'docker buildx history ls' (o que está 'Running') ou na aba Builds do Docker Desktop, e espere ele acabar antes de rodar o instalador de novo."
}

# Se o instalador parou o Supabase para o build e saiu antes de religá-lo (build que falhou,
# Ctrl+C, erro qualquer), ele sobe de novo aqui. O CRM antigo volta a ter banco.
PAREI_O_SUPABASE=0
ao_sair() {
  local codigo=$?
  restaurar_migracoes
  encerrar_build_do_projeto
  if [ "$BUILD_INTERROMPIDO" = "1" ]; then aviso_build_pode_seguir; fi
  if [ "$PAREI_O_SUPABASE" = "1" ]; then
    PAREI_O_SUPABASE=0
    log "Religando o Supabase deste CRM, que o instalador tinha parado para o build"
    if subir_supabase_com_recuperacao; then
      if [ "${CREDENCIAIS_NOVAS:-0}" = "1" ]; then
        # O Supabase voltou com as chaves novas, e o .env.local do app ainda tem as de antes (só a etapa 6 as regrava).
        log "Supabase de volta, já com as chaves novas desta instalação. O app ainda tem as chaves de antes e não entra: rode o instalador de novo para regravá-las."
      else
        log "Supabase de volta: o CRM que já estava instalado tem banco de novo."
      fi
    else
      printf 'ERRO: %s\n' "Não consegui religar o Supabase. O CRM está sem banco: siga a mensagem acima." >&2
    fi
  fi
  rm -f "$ERRO_DO_START" "$ERRO_DO_START.codigo" "$ERRO_DO_START.primeira"
  exit "$codigo"
}
trap ao_sair EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- 1. Confere o ambiente ------------------------------------------------------------------------
log "Conferindo Docker, Node e a CLI do Supabase"
command -v docker >/dev/null 2>&1 || falha "Docker não encontrado. Instale o Docker Desktop (https://www.docker.com/products/docker-desktop) e abra-o."
docker info >/dev/null 2>&1 || falha "O Docker está instalado mas não está rodando. Abra o Docker Desktop, espere ele ficar verde e rode de novo."
docker compose version >/dev/null 2>&1 || falha "O plugin 'docker compose' não foi encontrado. Atualize o Docker Desktop."

command -v node >/dev/null 2>&1 || falha "Node não encontrado. Instale o Node 22 (https://nodejs.org)."
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 22 ] || falha "Node $NODE_MAJOR encontrado; este projeto pede o Node 22 ou mais novo (https://nodejs.org)."

# A CLI do Supabase na versão testada (o npx baixa na primeira vez), sempre apontada para ESTA pasta.
if [ -z "${CRM_ALQUIMIA_SUPABASE_CLI:-}" ]; then
  command -v npx >/dev/null 2>&1 || falha "O 'npx' não foi encontrado. Instale o Node 22 (vem com o npx)."
fi
SUPABASE="$(supabase_cli)"
supabase_crm() { $SUPABASE "$@" --workdir .; }

# --- 2. As portas estão livres? (antes de tocar em qualquer coisa) ---------------------------------
log "Conferindo se as portas estão livres"
EXTRAS=()
while IFS= read -r extra; do
  if [ -n "$extra" ]; then EXTRAS+=("$extra"); fi
done < <(portas_extras_do_config supabase/config.toml "$PORTA_DB")
RECUSA_POR_PORTA=0
RECUSA_POR_DOCKER=0
if ! conferir_portas_livres "$PROJETO" \
  "CRM_ALQUIMIA_PORTA_APP=$PORTA_APP" "CRM_ALQUIMIA_PORTA_WORKER=$PORTA_WORKER" \
  "CRM_ALQUIMIA_PORTA_EVOLUTION=$PORTA_EVOLUTION" "CRM_ALQUIMIA_PORTA_SUPABASE_API=$PORTA_API" \
  "CRM_ALQUIMIA_PORTA_SUPABASE_DB=$PORTA_DB" ${EXTRAS[@]+"${EXTRAS[@]}"}; then
  # A última linha segue o motivo. Recusa só pelo nome do projeto não manda "escolher portas".
  if [ "$RECUSA_POR_DOCKER" -eq 1 ]; then
    falha "Nada foi alterado. O Docker não respondeu a uma listagem (a mensagem dele está acima): confira com 'docker ps' e 'docker volume ls' e rode de novo bash scripts/instalar.sh."
  fi
  if [ "$RECUSA_POR_PORTA" -eq 1 ]; then
    falha "Nada foi alterado. Escolha portas livres (as sugestões estão acima; por exemplo CRM_ALQUIMIA_PORTA_APP=<porta> bash scripts/instalar.sh) e rode de novo (as escolhidas ficam gravadas no .env.local)."
  fi
  falha "Nada foi alterado. Corrija o que está acima (por exemplo, outro nome em CRM_ALQUIMIA_PROJETO) e rode de novo bash scripts/instalar.sh."
fi

# Agora sim: portas e projeto ficam gravados no .env.local (rodar de novo sem as variáveis os mantém).
[ -f "$ENV_LOCAL" ] || : > "$ENV_LOCAL"
definir_env "$ENV_LOCAL" CRM_ALQUIMIA_PROJETO "$PROJETO" sempre
definir_env "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_APP "$PORTA_APP" sempre
definir_env "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_WORKER "$PORTA_WORKER" sempre
definir_env "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_EVOLUTION "$PORTA_EVOLUTION" sempre
definir_env "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_SUPABASE_API "$PORTA_API" sempre
definir_env "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_SUPABASE_DB "$PORTA_DB" sempre
# O docker-compose.yml lê as portas do host e o heap do build do ambiente do próprio compose.
export CRM_ALQUIMIA_PORTA_APP="$PORTA_APP" CRM_ALQUIMIA_PORTA_WORKER="$PORTA_WORKER" CRM_ALQUIMIA_PORTA_EVOLUTION="$PORTA_EVOLUTION"
# Pouca memória (modo auto, abaixo do limiar) e nada escolhido para o build: a combinação medida que cabe.
# Memória que não deu para medir não troca nada. A escolha não vai para o .env.local.
if [ "$MODO_PARAR_BANCO" = "auto" ] && ! build_definido_pelo_usuario "$ENV_LOCAL"; then
  MEMORIA_DO_BUILD_MB="$(memoria_para_build_mb)"
  if [ -n "$MEMORIA_DO_BUILD_MB" ] && [ "$MEMORIA_DO_BUILD_MB" -lt "$LIMIAR_PARAR_BANCO_MB" ]; then
    BUILD_CPUS=1
    HEAP_BUILD_MB=2048
    log "Pouca memória livre (${MEMORIA_DO_BUILD_MB} MB, abaixo de ${LIMIAR_PARAR_BANCO_MB} MB): o app vai compilar com 1 CPU e 2048 MB (mais lento, mas cabe). Para escolher outro valor, defina CRM_ALQUIMIA_BUILD_CPUS e CRM_ALQUIMIA_HEAP_BUILD_MB."
  fi
  unset MEMORIA_DO_BUILD_MB
fi
export CRM_ALQUIMIA_HEAP_BUILD_MB="$HEAP_BUILD_MB" CRM_ALQUIMIA_BUILD_CPUS="$BUILD_CPUS"

# A versão da imagem é a do package.json desta pasta: o compose a passa ao build (APP_VERSION), e ela fica no
# .env.local para um `docker compose up --build` manual responder o mesmo. Rodar o instalador de novo (atualizar)
# a renova. Só uma versão de forma conhecida entra; sem package.json, a imagem fica sem versão e o app usa a do
# código com que foi construído.
VERSAO_DO_PACOTE="$(node -e "try{const v=require('./package.json').version;if(typeof v==='string')process.stdout.write(v)}catch(e){}" 2>/dev/null || true)"
FORMA_DE_VERSAO='^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$'
if [[ "$VERSAO_DO_PACOTE" =~ $FORMA_DE_VERSAO ]]; then
  definir_env "$ENV_LOCAL" APP_VERSION "$VERSAO_DO_PACOTE" sempre
  export APP_VERSION="$VERSAO_DO_PACOTE"
else
  VERSAO_DO_PACOTE=""
fi

# Portas do Supabase, URLs de retorno do login e nome do projeto no supabase/config.toml.
ajustar_config_toml supabase/config.toml "$PORTA_API" "$PORTA_DB" "$PORTA_APP" "$PROJETO"
# Sem as quatro linhas do [auth] (por exemplo, um conflito de `git pull` resolvido com a versão antiga), a CLI
# usaria chaves públicas sem avisar ninguém: para antes do primeiro comando dela.
FALTAM_NO_CONFIG="$(conferir_config_das_chaves supabase/config.toml)" \
  || falha "O supabase/config.toml não aponta para as chaves desta instalação: falta, na seção [auth], ${FALTAM_NO_CONFIG}. Sem isso o Supabase subiria com chaves públicas. Volte essas linhas ao que está no repositório (git checkout -- supabase/config.toml, ou copie a seção [auth] da versão baixada) e rode o instalador de novo."
unset FALTAM_NO_CONFIG

# --- 3. Segredos e imagens (ANTES do Supabase) --------------------------------------------------
# O build do app pede cerca de 4 GB na VM do Docker, e com o Supabase de pé ao lado (mais
# ~1,1 GB) a instalação limpa não coube numa máquina de 8 GB. As imagens não dependem do banco: o compose
# só precisa dos segredos gerados aqui. Então elas saem primeiro, e o Supabase sobe depois. Numa
# reinstalação com o Supabase deste CRM já de pé, ele para durante o build (os dados ficam) e volta logo.
segredo_hex()    { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"; }
segredo_base64() { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"; }

# O .env.local já existe (criado no começo, sob umask 077).
definir() { definir_env "$ENV_LOCAL" "$@"; }

if ! grep -q "^# CRM ALQUIM(IA)" "$ENV_LOCAL"; then
  { printf '# CRM ALQUIM(IA): gerado por scripts/instalar.sh. NUNCA commitar. Referencia: .env.example\n'; cat "$ENV_LOCAL"; } > "$ENV_LOCAL.novo"
  mv "$ENV_LOCAL.novo" "$ENV_LOCAL"
fi

# Segredos (gerados uma vez; mantidos nas reinstalações)
definir INTERNAL_SECRET "$(segredo_hex)" se_vazio
definir EVOLUTION_API_KEY "$(segredo_hex)" se_vazio
definir EVOLUTION_WEBHOOK_TOKEN "$(segredo_hex)" se_vazio
definir EVOLUTION_DB_PASSWORD "$(segredo_hex)" se_vazio
definir SRH_TOKEN "$(segredo_hex)" se_vazio
definir WAHA_HMAC_SECRET "$(segredo_hex)" se_vazio
definir IMPERSONATE_COOKIE_SECRET "$(segredo_hex)" se_vazio
definir LGPD_SIGNING_KEY "$(segredo_hex)" se_vazio
definir CPF_ENCRYPTION_KEY "$(segredo_base64)" se_vazio
definir WAHA_BYO_ENCRYPTION_KEY "$(segredo_base64)" se_vazio
definir AI_CRED_AES_KEY "$(segredo_base64)" se_vazio
# As chaves desta instalação, que o supabase/config.toml lê (detalhe no SECURITY.md): o segredo do JWT
# (`env(CRM_ALQUIMIA_JWT_SECRET)`), as chaves novas da API (sb_publishable_, sb_secret_; as padrão da CLI são
# públicas, e a secreta padrão abriria tudo) e a chave ES256 que assina as sessões e as chaves anon e service_role
# (supabase/signing_keys.json). Geradas uma vez, mantidas nas reinstalações, exportadas para todo comando da CLI.
# CREDENCIAIS_NOVAS: alguma delas nasce nesta execução (instalação de antes delas, ou linha/arquivo apagado), ou
# uma execução anterior as gerou e não chegou a reiniciar o Supabase (o marcador abaixo). Um Supabase de pé ainda
# usa as de antes.
MARCADOR_REINICIO=supabase/.env.pendente
CREDENCIAIS_NOVAS=0
if [ -f "$MARCADOR_REINICIO" ]; then CREDENCIAIS_NOVAS=1; fi
[ -n "$(valor_do_env "$ENV_LOCAL" CRM_ALQUIMIA_JWT_SECRET)" ] || CREDENCIAIS_NOVAS=1
[ -n "$(valor_do_env "$ENV_LOCAL" CRM_ALQUIMIA_SECRET_KEY)" ] || CREDENCIAIS_NOVAS=1
ESTADO_DA_CHAVE="$(estado_da_chave_de_assinatura supabase/signing_keys.json)"
case "$ESTADO_DA_CHAVE" in
  valida) ;;
  invalida)
    falha "A supabase/signing_keys.json existe, mas não é uma lista de chaves que a CLI do Supabase entenda. Não apago chave sua: mova o arquivo para fora da pasta supabase (ou conserte-o) e rode o instalador de novo. Ele gera outra chave, e as sessões abertas podem pedir novo login; os dados ficam." ;;
  *) CREDENCIAIS_NOVAS=1 ;;
esac
# A pendência vai para o disco ANTES de qualquer credencial nova: se esta execução for interrompida (Ctrl+C,
# queda do PC, `supabase stop` que falha) antes de o Supabase subir com elas, a próxima o reinicia em vez de
# confiar no que está de pé. Sai só depois de o Supabase subir com as chaves desta instalação (etapa 4).
if [ "$CREDENCIAIS_NOVAS" = "1" ]; then ( umask 077; : > "$MARCADOR_REINICIO" ); fi
definir CRM_ALQUIMIA_JWT_SECRET "$(segredo_hex)" se_vazio
definir CRM_ALQUIMIA_PUBLISHABLE_KEY "sb_publishable_$(segredo_hex | cut -c1-32)" se_vazio
definir CRM_ALQUIMIA_SECRET_KEY "sb_secret_$(segredo_hex)" se_vazio
exportar_segredos_da_cli "$ENV_LOCAL"
# O supabase/.env, que a CLI lê sozinha: quem subir o Supabase à mão fica com as chaves desta instalação.
gravar_env_da_cli "$ENV_LOCAL" supabase/.env
# A chave de assinatura vem ANTES do primeiro comando da CLI que lê o config (o `status` e o `start` falham sem
# ela). Uma chave privada que já existe nunca é trocada nem apagada.
if [ "$ESTADO_DA_CHAVE" != "valida" ]; then
  log "Gerando a chave de assinatura das sessões desta instalação (supabase/signing_keys.json, só o seu usuário a lê; nada dela é impresso)"
  gerar_chave_de_assinatura supabase/signing_keys.json supabase_crm \
    || falha "Não consegui gerar a chave de assinatura das sessões com a CLI do Supabase (a mensagem dela está acima). Rode o instalador de novo."
fi
unset ESTADO_DA_CHAVE
# O UPSTASH_REDIS_REST_TOKEN é o mesmo SRH_TOKEN.
SRH_ATUAL="$(valor_do_env "$ENV_LOCAL" SRH_TOKEN)"
definir UPSTASH_REDIS_REST_TOKEN "$SRH_ATUAL" sempre
unset SRH_ATUAL

# Com o Supabase deste CRM de pé (reinstalação, atualização), parar só se falta memória
# (CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=auto, o padrão; ou sempre/nunca). Parado, o CRM fica fora do ar
# durante o build, e o trap garante que ele sobe de novo se o build falhar ou for interrompido.
if supabase_crm status >/dev/null 2>&1; then
  LIVRE_MB="$(memoria_para_build_mb)"
  if [ "$CREDENCIAIS_NOVAS" = "1" ]; then
    # Os contêineres de pé validam com as chaves antigas; as chaves gravadas no fim sairão das novas.
    log "ATENÇÃO: esta instalação ganhou agora chaves só dela (a que assina as sessões e as da API). O Supabase deste CRM vai parar e subir de novo com elas, para as chaves do app baterem. As sessões abertas podem pedir novo login (o token de renovação antigo costuma renovar com a chave nova, mas não conte com isso). Os dados ficam, e o CRM fica fora do ar até o fim do build."
    PAREI_O_SUPABASE=1
    $SUPABASE stop --project-id "$PROJETO" --workdir . || falha "O 'supabase stop' falhou antes da construção das imagens. Veja a mensagem acima."
  elif deve_parar_banco "$MODO_PARAR_BANCO" "$LIVRE_MB" "$LIMIAR_PARAR_BANCO_MB"; then
    log "ATENÇÃO: o Supabase deste CRM vai parar durante a construção das imagens (memória livre, a menor entre o computador e a VM do Docker: ${LIVRE_MB:-não medida} MB; limiar ${LIMIAR_PARAR_BANCO_MB} MB; CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=${MODO_PARAR_BANCO}). O CRM fica fora do ar até o fim do build; os dados ficam, e ele volta se o build falhar ou for interrompido com Ctrl+C. Se este instalador for morto à força, rode-o de novo para subir o Supabase."
    PAREI_O_SUPABASE=1
    $SUPABASE stop --project-id "$PROJETO" --workdir . || falha "O 'supabase stop' falhou antes da construção das imagens. Veja a mensagem acima."
  else
    log "O Supabase deste CRM continua de pé durante o build (memória livre, a menor entre o computador e a VM do Docker: ${LIVRE_MB:-não medida} MB; CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=${MODO_PARAR_BANCO})."
  fi
fi
# UMA imagem por vez: em paralelo, o build do app (até CRM_ALQUIMIA_HEAP_BUILD_MB de memória só para o
# Node) somado ao do worker pode esgotar a memória do Docker e derrubar o que mais estiver rodando nele.
log "Construindo as imagens do CRM, uma por vez (a primeira vez demora: compila o app)"
log "$(aviso_do_build "$HEAP_BUILD_MB" "$BUILD_CPUS")"
for servico in app worker scheduler; do
  compose_crm "$PROJETO" build "$servico" &
  BUILD_PID=$!
  codigo_build=0
  wait "$BUILD_PID" || codigo_build=$?
  BUILD_PID=""
  if [ "$codigo_build" != "0" ]; then
    # O cliente do build saiu com erro (falta de memória, ou ele foi morto por fora): o que ele abriu pode
    # seguir compilando dentro do Docker.
    BUILD_INTERROMPIDO=1
    falha "A construção da imagem '$servico' falhou. Veja a mensagem acima (falta de memória aparece como 'killed' ou 'heap out of memory')."
  fi
done
unset codigo_build

# --- 4. Supabase local ----------------------------------------------------------------------------
log "Subindo o Supabase local (a primeira vez baixa as imagens e leva alguns minutos)"
SUBI_AGORA=0
if supabase_crm status >/dev/null 2>&1; then
  # De pé não quer dizer com as chaves desta instalação: uma execução interrompida, ou um `supabase start` à
  # mão sem o supabase/.env, deixa a chave da CLI (pública) no ar.
  MOTIVO_REINICIO=""
  if [ -f "$MARCADOR_REINICIO" ]; then
    MOTIVO_REINICIO="uma execução anterior deste instalador gerou chaves novas e não chegou a reiniciar o Supabase"
  else
    codigo_vivo=0
    conferir_supabase_vivo "$PORTA_API" "$PROJETO" || codigo_vivo=$?
    if [ "$codigo_vivo" = "1" ]; then
      MOTIVO_REINICIO="o Supabase de pé não usa as chaves desta instalação (a que assina as sessões, o segredo do JWT ou as da API)"
    elif [ "$codigo_vivo" = "2" ]; then
      log "AVISO: não consegui conferir pelo JWKS do Supabase (http://127.0.0.1:${PORTA_API}/auth/v1/.well-known/jwks.json) a chave que assina as sessões. Se o app não entrar, rode o parar e este instalador de novo."
    fi
  fi
  if [ -n "$MOTIVO_REINICIO" ]; then
    log "ATENÇÃO: ${MOTIVO_REINICIO}. Ele vai parar e subir de novo com as chaves desta instalação. As sessões abertas podem pedir novo login (o token de renovação antigo costuma renovar com a chave nova, mas não conte com isso); os dados ficam."
    $SUPABASE stop --project-id "$PROJETO" --workdir . || falha "O 'supabase stop' falhou. Veja a mensagem acima, rode o parar (bash scripts/parar.sh) e este instalador de novo."
    subir_supabase_com_recuperacao || exit 1
    SUBI_AGORA=1
  else
    log "Supabase já está rodando"
  fi
  unset MOTIVO_REINICIO
else
  # Quem sobe agora é a etapa 4: o trap não tenta de novo se este start falhar.
  ESTAVA_PARADO_PELO_INSTALADOR="$PAREI_O_SUPABASE"
  PAREI_O_SUPABASE=0
  subir_supabase_com_recuperacao || exit 1
  if [ "$ESTAVA_PARADO_PELO_INSTALADOR" = "1" ]; then log "Supabase de volta depois do build."; fi
  SUBI_AGORA=1
fi
if [ "$SUBI_AGORA" = "1" ]; then
  codigo_vivo=0
  conferir_supabase_vivo "$PORTA_API" "$PROJETO" || codigo_vivo=$?
  if [ "$codigo_vivo" = "1" ]; then
    falha "O Supabase subiu, mas não com as chaves desta instalação (a que assina as sessões, o segredo do JWT ou as da API): o JWKS ou os contêineres do Auth e do Kong mostram outras. Confira se o supabase/config.toml e o supabase/.env são os que o instalador gravou, rode o parar e este instalador de novo."
  elif [ "$codigo_vivo" = "2" ]; then
    log "AVISO: não consegui conferir pelo JWKS do Supabase (http://127.0.0.1:${PORTA_API}/auth/v1/.well-known/jwks.json) a chave que assina as sessões. Se o app não entrar, rode o parar e este instalador de novo."
  fi
fi
# O Supabase está de pé com as chaves desta instalação: nada pendente para a próxima execução.
rm -f "$MARCADOR_REINICIO"
unset SUBI_AGORA codigo_vivo

DB_CONTAINER="supabase_db_${PROJETO}"
docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || falha "Não achei o contêiner $DB_CONTAINER depois do 'supabase start'. Rode '$SUPABASE status --workdir .' para ver o que houve."

# --- 5. Schema (baseline.sql) ---------------------------------------------------------------------
log "Aplicando o schema (supabase/baseline.sql)"
docker cp scripts/instalar-extensoes.sql "$DB_CONTAINER:/tmp/instalar-extensoes.sql"
docker cp supabase/baseline.sql "$DB_CONTAINER:/tmp/baseline.sql"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/instalar-extensoes.sql
JA_TEM_SCHEMA="$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -At -c "select to_regclass('public.organizations') is not null")"
if [ "$JA_TEM_SCHEMA" = "t" ]; then
  # Banco que já tem o schema: reaplica em modo de atualização (sem ON_ERROR_STOP; o baseline é idempotente).
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -q -f /tmp/baseline.sql >/dev/null
else
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/baseline.sql >/dev/null
fi
docker exec "$DB_CONTAINER" rm -f /tmp/baseline.sql /tmp/instalar-extensoes.sql

# A versão instalada vai para o banco. A tela de Atualização a mostra, e nesta
# versão não há agente do host para gravá-la (a coluna nascia vazia: "Versão instalada: ."). Só uma versão
# de forma conhecida entra no SQL; sem package.json ou com versão estranha, nada é gravado e a tela usa a
# versão da imagem.
VERSAO_INSTALADA="$VERSAO_DO_PACOTE"
if [[ "$VERSAO_INSTALADA" =~ $FORMA_DE_VERSAO ]]; then
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -q -c "update public.system_version set current_version = '${VERSAO_INSTALADA}', updated_at = now() where id = 1" >/dev/null \
    || log "Aviso: não consegui gravar a versão instalada (${VERSAO_INSTALADA}) no banco; a tela de Atualização mostra a versão da imagem."
fi

# O Realtime só enxerga as tabelas que o baseline pôs na publication se reiniciar depois dele.
# Pelo nome EXATO (o filtro `name=` do docker casa por pedaço do nome).
if docker inspect "supabase_realtime_${PROJETO}" >/dev/null 2>&1; then
  docker restart "supabase_realtime_${PROJETO}" >/dev/null
fi

# --- 6. .env.local ---------------------------------------------------------------------------------
log "Gravando o .env.local (nenhum segredo é impresso)"
STATUS_ENV="$(supabase_crm status -o env 2>/dev/null)" || falha "Não consegui ler o 'supabase status'."
ler_status() { printf '%s\n' "$STATUS_ENV" | grep "^$1=" | head -1 | cut -d= -f2- | tr -d '"'; }
CHAVE_ANON="$(ler_status ANON_KEY)"
CHAVE_SERVICO="$(ler_status SERVICE_ROLE_KEY)"
unset STATUS_ENV
if [ -z "$CHAVE_ANON" ] || [ -z "$CHAVE_SERVICO" ]; then
  falha "O 'supabase status' não devolveu as chaves (ANON_KEY, SERVICE_ROLE_KEY). Atualize a CLI do Supabase."
fi



# Derivados (sempre atualizados). O NAVEGADOR usa localhost; os CONTÊINERES usam host.docker.internal
# (SUPABASE_URL_INTERNA, lida só pelo servidor).
definir NEXT_PUBLIC_SUPABASE_URL "http://localhost:${PORTA_API}" sempre
definir SUPABASE_URL_INTERNA "http://host.docker.internal:${PORTA_API}" sempre
definir NEXT_PUBLIC_SUPABASE_ANON_KEY "$CHAVE_ANON" sempre
definir SUPABASE_SERVICE_ROLE_KEY "$CHAVE_SERVICO" sempre
definir SUPABASE_DB_URL "postgresql://postgres:postgres@host.docker.internal:${PORTA_DB}/postgres" sempre
definir NEXT_PUBLIC_APP_URL "http://localhost:${PORTA_APP}" sempre
definir NEXT_PUBLIC_ADMIN_URL "http://localhost:${PORTA_APP}" sempre
definir UPSTASH_REDIS_REST_URL "http://srh:80" sempre
definir EVOLUTION_API_BASE_URL "http://evolution:8080" sempre
definir EVOLUTION_WEBHOOK_GLOBAL "true" sempre
definir WAHA_HEALTH_CHECK "off" sempre
definir SENTRY_DSN "off" sempre
definir NEXT_TELEMETRY_DISABLED "1" sempre
unset CHAVE_ANON CHAVE_SERVICO

# Chave de cifra do banco (segredos de webhook, token de canal oficial, credencial do Google): gerada uma
# vez, gravada em private.app_secrets e guardada no .env.local. Se o banco já tem uma, ela fica (e o
# .env.local passa a guardar a mesma): trocar tornaria ilegível o que já foi cifrado.
ativar_chave_de_cifra "$ENV_LOCAL" "$DB_CONTAINER" || falha "Não consegui ativar a chave de cifra do banco. Veja a mensagem acima."
# Envio real DESLIGADO: a linha existe, vazia. Quem a liga é você (README, "Ligar o envio real").
if ! grep -qE '^DISPARO_REAL_LIBERADO=' "$ENV_LOCAL"; then printf 'DISPARO_REAL_LIBERADO=\n' >> "$ENV_LOCAL"; fi
# Depois da ÚLTIMA escrita (cada reescrita cria um arquivo novo, que herda a pasta): só o dono lê.
# No Git Bash do Windows o chmod não muda a ACL do NTFS; a função chama o icacls (ou avisa se falhar).
chmod 600 "$ENV_LOCAL"
restringir_acl_windows "$ENV_LOCAL"

# --- 7. Aplicação ---------------------------------------------------------------------------------
log "Subindo o CRM"
compose_crm "$PROJETO" up -d || falha "O 'docker compose up' falhou. Veja a mensagem acima."

log "Esperando o app e o worker responderem"
esperar_http() {  # esperar_http URL CODIGO_ESPERADO TENTATIVAS (5 s entre elas)
  local url="$1" esperado="$2" tentativas="$3" i codigo
  for i in $(seq 1 "$tentativas"); do
    codigo="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
    if [ "$codigo" = "$esperado" ]; then return 0; fi
    sleep 5
  done
  return 1
}
esperar_http "http://localhost:${PORTA_APP}/login" 200 120 \
  || falha "O app não respondeu 200 em http://localhost:${PORTA_APP}/login. Veja: docker compose -p ${PROJETO} --env-file .env.local logs app"
esperar_http "http://127.0.0.1:${PORTA_WORKER}/healthz" 200 60 \
  || falha "O worker não respondeu em http://127.0.0.1:${PORTA_WORKER}/healthz. Veja: docker compose -p ${PROJETO} --env-file .env.local logs worker"

URL="http://localhost:${PORTA_APP}/signup"
log "Pronto. Crie sua conta em: ${URL}"
log "Crie a SUA conta antes de abrir o CRM para a internet (proxy, túnel, porta pública): a primeira conta vira a dona do servidor, com o console de plataforma."
log "Portas usadas (projeto ${PROJETO}): app ${PORTA_APP}, worker ${PORTA_WORKER}, Evolution ${PORTA_EVOLUTION}, Supabase API ${PORTA_API}, banco ${PORTA_DB}"
log "O envio real de mensagens está DESLIGADO (modo simulado). Veja o README, seção \"Ligar o envio real\"."
log "ATENÇÃO, REDE: o banco do Supabase (porta ${PORTA_DB}) aceita conexões da sua rede local com a senha padrão da CLI. Numa rede que não é só sua (Wi-Fi de café, coworking, empresa), qualquer pessoa nela lê e altera todos os dados do CRM, sem conta. Use em rede confiável ou bloqueie as portas ${PORTA_API} e ${PORTA_DB} para conexões de entrada (veja o SECURITY.md)."
if [ "$(uname -s 2>/dev/null)" = "Linux" ]; then
  log "Linux: regras do ufw NÃO valem para portas publicadas pelo Docker. O SECURITY.md mostra a regra na cadeia DOCKER-USER do iptables."
elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  log "Mac: em Ajustes do Sistema > Rede > Firewall, ligue o firewall e bloqueie conexões de entrada para o Docker."
else
  log "Windows (PowerShell como administrador): New-NetFirewallRule -DisplayName 'CRM ALQUIM(IA) Supabase' -Direction Inbound -Protocol TCP -LocalPort ${PORTA_API},${PORTA_DB} -Action Block"
fi
if [ "${CRM_ALQUIMIA_NAO_ABRIR:-}" != "1" ]; then
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
  elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$URL" >/dev/null 2>&1 || true
  fi
fi
