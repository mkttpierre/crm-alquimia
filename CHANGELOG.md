# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue o
[SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

## [1.0.0] — data: na publicação

Primeira versão aberta do CRM ALQUIM(IA).

### Adicionado

- Instalação local de um comando: `scripts/instalar.sh` (Linux, Mac, Git Bash) e `scripts/instalar.ps1`
  (Windows PowerShell). Sobe o Supabase local, aplica o schema, gera o `.env.local` com segredos
  aleatórios (sem imprimir nenhum) e sobe o CRM em `http://localhost:3000`. É idempotente.
  `scripts/parar.sh` e `scripts/parar.ps1` param tudo sem apagar dados.
- `docker-compose.yml` novo: app, worker, agendador, Evolution API 2.3.7 (travada por digest, com o patch
  do Baileys que confirma a stanza `<status>`), banco da Evolution, Redis e `serverless-redis-http`.
- Webhook global da Evolution com segredo no caminho e a lista completa de eventos do CRM.
- Cadastro sem servidor de e-mail: a conta nasce pronta e a organização é criada no próprio cadastro.
- Portas configuráveis por variáveis `CRM_ALQUIMIA_PORTA_*`.
- Instalar ao lado de outro sistema: o instalador recusa porta já ocupada por outro programa e todo comando
  leva o nome de projeto explícito (`CRM_ALQUIMIA_PROJETO`).
- Instalação em pouca memória: as imagens saem antes de o Supabase subir, a imagem não roda o type-check
  (`CRM_ALQUIMIA_BUILD_TYPECHECK`, padrão 0), e as CPUs e o heap do build são ajustáveis
  (`CRM_ALQUIMIA_BUILD_CPUS`, `CRM_ALQUIMIA_HEAP_BUILD_MB`). Numa reinstalação, o Supabase só para durante o
  build se faltar memória (`CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD`, padrão `auto`).
- Se o `supabase start` falhar, o instalador tenta uma vez `supabase stop --project-id <projeto>` (guarda os
  dados) e um novo `start`, e mostra o erro das duas tentativas se falhar de novo.
- A primeira conta de uma instalação nova vira dona do servidor; a tela de Atualização mostra a versão
  instalada (a do `package.json`, gravada pelo instalador).

### Alterado

- `supabase/config.toml`: `project_id` agora é `crm-alquimia` e `enable_confirmations = false` (com o
  passo a passo para ligar a confirmação por e-mail no README).
- As variáveis `WAHA_*` deixam de ser obrigatórias em produção: o WhatsApp padrão é a Evolution.

### Segurança

- As chaves do Supabase local são geradas por instalação, nunca as de demonstração da CLI (públicas e iguais
  em toda instalação): a chave ES256 que assina as sessões e as chaves anon e service_role
  (`supabase/signing_keys.json`, gerada pela própria CLI), o segredo do JWT (`CRM_ALQUIMIA_JWT_SECRET`) e as
  chaves novas da API (`sb_publishable_`/`sb_secret_`). O instalador confere o `supabase/config.toml` e o
  Supabase de pé (o JWKS e os contêineres do Auth e do Kong) e o reinicia se ele não usar as chaves desta
  instalação. O banco local segue com a senha padrão
  da CLI e aberto na rede local; o README e o SECURITY.md dizem o risco e como bloquear as portas.
- O envio real de mensagens vem **desligado**: exige o modo real na tela **e** `DISPARO_REAL_LIBERADO=sim`.
