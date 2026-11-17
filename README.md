# CRM ALQUIM(IA)

CRM com WhatsApp por QR e agentes de IA, de código aberto, que roda inteiro no seu computador com um comando. Sem mensalidade e sem servidor de e-mail: você instala, cria a conta e conecta o seu WhatsApp.

Nasceu de um fork do DeskcommCRM (MIT).

Veja [NOTICE.md](NOTICE.md) e [LICENSE](LICENSE).

## Do zero ao primeiro login

### O que você precisa

| Item | Versão | Para quê |
|---|---|---|
| Docker Desktop (ou Docker Engine + Compose) | recente, **aberto e rodando** (no Windows, com o WSL 2 ligado: o Docker Desktop pede na instalação) | sobe o banco, o login, o WhatsApp e o CRM |
| Node.js | **22** ou mais novo | gera os segredos e roda a CLI do Supabase |
| Git | qualquer | baixar o código |
| Memória e disco | **4,5 GB de RAM livres** na hora da instalação (com `CRM_ALQUIMIA_BUILD_CPUS=1` e `CRM_ALQUIMIA_HEAP_BUILD_MB=2048`), 15 GB de disco | a primeira instalação baixa e compila bastante coisa (veja "Pouca memória" logo abaixo) |

> **Pouca memória.** Compilar o app é a parte mais pesada da instalação. Medido numa instalação real (Windows, Docker Desktop), com `CRM_ALQUIMIA_BUILD_CPUS=1` e `CRM_ALQUIMIA_HEAP_BUILD_MB=2048`: o build do app levou a memória da máquina virtual do Docker de 1,6 GB a 5,7 GB (**cerca de +4,1 GB**) e a RAM livre do computador de 3,7 GB a 0,5 GB, em 2 min 18 s. Essa medida foi feita com o cache da máquina virtual do Docker limpo a cada poucos segundos (um ajudante da prova); sem isso, pode precisar de mais. Então deixe **pelo menos 4,5 GB de RAM livres** só para o build, além do que o sistema e os seus programas já usam, e feche o que for pesado. Isso já com as duas economias que o instalador faz sozinho: as imagens saem antes de o Supabase subir, e a imagem não roda o type-check do TypeScript (`CRM_ALQUIMIA_BUILD_TYPECHECK`, padrão `0`; quem cobra os tipos é o CI). Com o type-check ligado, ou com o Supabase de pé ao lado, 4,5 GB livres não bastaram na mesma máquina. As alavancas são as CPUs do build (`CRM_ALQUIMIA_BUILD_CPUS`, padrão 2: o Next usa uma thread e um processo por CPU) e o heap do Node (`CRM_ALQUIMIA_HEAP_BUILD_MB`, padrão 4096). O padrão (2 CPUs, 4096) pede mais memória que a medida acima e não foi medido: com pouca memória (menos livre que `CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB`, padrão 6144 MB), o instalador já usa sozinho 1 CPU e 2048 MB, a combinação medida (mais lento), e diz isso na tela, desde que você não tenha escolhido nenhuma das duas variáveis: o valor que você escolher sempre vence. Com RAM de sobra (16 GB livres ou mais), `CRM_ALQUIMIA_BUILD_CPUS=8` compila mais rápido. As variáveis valem na linha do instalador ou escritas no `.env.local`. Numa máquina de 12 CPUs sem o limite de CPUs, a RAM livre caiu de 2,2 GB para 382 MB em 16 segundos.

> **Aviso de segurança: rede.** O Supabase local (API na porta 54321, banco na 54322) aceita conexões de **qualquer computador da sua rede local**: a CLI do Supabase não permite restringi-lo ao seu computador. O banco usa a senha padrão da CLI (`postgres`/`postgres`), conhecida por todo mundo. Numa rede que não é só sua (Wi-Fi de café, coworking, rede da empresa), **qualquer pessoa nela lê e altera todos os dados do CRM, sem senha nem conta**: contatos, conversas, mídias. Use em rede confiável ou bloqueie as portas 54321 e 54322 para conexões de entrada no firewall (o instalador mostra o comando no fim; detalhes no [SECURITY.md](SECURITY.md)). As chaves da API e a chave que assina as sessões são geradas para a sua instalação, não as de demonstração da CLI (veja "Chaves desta instalação", abaixo).

### 1. Baixe e rode UM comando

Linux, Mac ou Git Bash no Windows:

```bash
git clone <URL-DESTE-REPOSITORIO> crm-alquimia
cd crm-alquimia
bash scripts/instalar.sh
```

Windows (PowerShell):

```powershell
git clone <URL-DESTE-REPOSITORIO> crm-alquimia
cd crm-alquimia
powershell -ExecutionPolicy Bypass -File scripts\instalar.ps1
```

O instalador, nesta ordem:

1. confere o Docker, o Node 22 e a CLI do Supabase (usa `npx supabase@2.120.0`, a versão testada);
2. gera os segredos aleatórios no `.env.local`, **sem imprimir nenhum na tela**, e constrói as imagens do app, do worker e do agendador, uma por vez, ANTES de subir o Supabase (assim a compilação não divide a memória com o banco; numa reinstalação com o Supabase deste CRM de pé, ele só para durante o build se a memória livre (a menor entre a do computador e a da VM do Docker) for menor que uns 6 GB: aí **o CRM fica fora do ar até o fim do build**, sem perder dados, e o instalador o religa se o build falhar ou se você interromper com Ctrl+C. Se o instalador for morto à força (`kill -9`, fechar o processo pelo gerenciador de tarefas, queda de energia), ninguém religa o banco: rode o instalador de novo, que ele sobe o Supabase e termina o trabalho. `CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD` escolhe: `auto` (padrão), `sempre` ou `nunca`; o limiar é `CRM_ALQUIMIA_MEMORIA_MINIMA_BUILD_MB`, padrão 6144);
3. sobe o Supabase local (banco, login e arquivos) e aplica o schema (`supabase/baseline.sql`);
4. grava no `.env.local` as chaves do Supabase;
5. sobe o app, o worker, o agendador de tarefas, a Evolution (WhatsApp), o Redis e o banco da Evolution, espera o app e o worker responderem e abre `http://localhost:3000/signup`.

A primeira vez leva de 10 a 25 minutos (imagens e compilação). Rodar de novo é seguro: não apaga banco, conexões nem segredos.

### 2. Crie a conta

Em `http://localhost:3000/signup` informe o nome da empresa, seu e-mail e uma senha. **Não existe e-mail de confirmação**: a conta nasce pronta, com a sua organização, e você cai direto no onboarding. A **primeira** conta criada numa instalação nova é a dona do servidor: só ela vê Configurações › Atualização (que diz se há versão nova) e o console de plataforma (`/admin`). As contas seguintes não ganham isso.

> **Crie a sua conta antes de expor o CRM na internet.** A primeira conta vira dona do servidor. O instalador publica o app só em `127.0.0.1`, então, no padrão, só quem está na sua máquina chega ao cadastro. Se você abrir o CRM para fora (proxy, túnel, porta pública) antes de criar a sua conta, quem se cadastrar primeiro fica com o servidor. Depois de criar a conta, confira em `/admin` que é você quem está lá.

**A conta que devia ser a dona não ficou dona?** (por exemplo, um banco restaurado de antes do cadastro). A promoção acontece no cadastro, então quem já tinha conta não a ganha sozinho. Rode o instalador de novo (ele atualiza o banco) e depois, trocando o e-mail pelo da sua conta (e `crm-alquimia` pelo `CRM_ALQUIMIA_PROJETO` do seu `.env.local`, se você mudou):

```bash
docker exec supabase_db_crm-alquimia psql -U postgres -d postgres -c \
  "select public.fn_promover_primeiro_dono_da_instalacao(u.user_id, u.organization_id) from public.user_organizations u join auth.users a on a.id = u.user_id where a.email = 'voce@exemplo.com' and u.role = 'admin' and u.revoked_at is null;"
```

No Windows PowerShell, o mesmo comando numa linha só (a barra invertida do bloco acima é do bash):

```powershell
docker exec supabase_db_crm-alquimia psql -U postgres -d postgres -c "select public.fn_promover_primeiro_dono_da_instalacao(u.user_id, u.organization_id) from public.user_organizations u join auth.users a on a.id = u.user_id where a.email = 'voce@exemplo.com' and u.role = 'admin' and u.revoked_at is null;"
```

É a mesma regra do cadastro: devolve `t` e faz de você o dono do servidor só se a instalação nunca teve um e tem uma organização só; senão devolve `f` e não muda nada. Depois disso, Configurações › Atualização aparece.

### 3. Conecte o WhatsApp

Em **Conexões**, clique em **Conectar novo WhatsApp** e leia o QR com o aparelho (WhatsApp, Aparelhos conectados). A Evolution local fica em `127.0.0.1:8080`, só acessível da sua máquina.

### 4. Ligar o envio real (vem DESLIGADO)

O CRM nasce em **modo simulado**: monta fila, mostra prévia e nada sai para o WhatsApp. O envio real exige **duas chaves**, e as duas precisam estar ligadas:

1. **Na tela**, em Disparo, o botão "Ligar o envio real" grava `disparo_config.modo = 'real'` para a organização. Só quem é **admin** da organização pode ligá-lo (os outros papéis veem o pedido para chamar um administrador).
2. **No servidor**, `DISPARO_REAL_LIBERADO=sim` no `.env.local` (só o valor exato `sim` libera; vazio é tudo simulado). Esta fica fora da tela de propósito: quem mexe no servidor decide.

```bash
# edite a linha no .env.local:  DISPARO_REAL_LIBERADO=sim
docker compose -p crm-alquimia --env-file .env.local up -d app worker
```

Teste antes com o seu próprio número. Para voltar ao simulado, deixe a variável vazia e suba de novo.

## No dia a dia

| Quero | Comando |
|---|---|
| Parar tudo (sem apagar nada) | `bash scripts/parar.sh` · `powershell -ExecutionPolicy Bypass -File scripts\parar.ps1` |
| Subir de novo | o mesmo `instalar` de antes (é rápido na segunda vez) |
| Subir só o Supabase, sem o instalador | Prefira o `instalar`. Se subir à mão, a CLI lê as chaves desta instalação do `supabase/.env` e da `supabase/signing_keys.json`, que o instalador grava; sem a `supabase/signing_keys.json`, o `start` falha (rode o `instalar`, que gera outra). |
| Atualizar para uma versão nova | baixe a versão nova (`git checkout main && git pull` na pasta do projeto; o `checkout` vale para quem tinha voltado de versão) e rode o mesmo `instalar` de antes. Ele mantém banco, conexões e segredos. Instalou por zip, sem git? Baixe o zip novo, troque os arquivos e mantenha o seu `.env.local`, o `supabase/.env` e a `supabase/signing_keys.json` (sem a chave, o instalador gera outra e as sessões abertas caem; os dados ficam). A tela Configurações › Atualização não atualiza sozinha nesta versão. |
| Ver o log do app | `docker compose -p crm-alquimia --env-file .env.local logs -f app` |

Onde ficam os dados: o banco no volume do Supabase local (o volume `supabase_db_...` do projeto), as conexões do WhatsApp no volume `..._evolution_instances` do mesmo projeto. `parar` não toca em nenhum dos dois.

### Trocar as portas

Se a 3000 (ou outra) já está em uso, defina antes de rodar o instalador:

| Variável | Padrão |
|---|---|
| `CRM_ALQUIMIA_PORTA_APP` | 3000 |
| `CRM_ALQUIMIA_PORTA_WORKER` | 8787 |
| `CRM_ALQUIMIA_PORTA_EVOLUTION` | 8080 |
| `CRM_ALQUIMIA_PORTA_SUPABASE_API` / `_DB` | 54321 / 54322 |

As portas escolhidas ficam gravadas no `.env.local`: rodar o instalador de novo, sem a variável, as mantém. Exemplo: `CRM_ALQUIMIA_PORTA_APP=3100 bash scripts/instalar.sh`. No PowerShell: `$env:CRM_ALQUIMIA_PORTA_APP = "3100"` antes do comando.

### Instalar ao lado de outro sistema

Numa máquina que já roda outra coisa (outro Supabase local, outro app na 3000), o instalador confere **antes de mexer em qualquer coisa** se cada porta está livre; se uma estiver ocupada por outro programa, ele para e diz qual variável trocar (tabela acima). Todo comando usa o nome de projeto explícito (`crm-alquimia`, ou o que você der em `CRM_ALQUIMIA_PROJETO` para ter duas instalações lado a lado), então um `COMPOSE_PROJECT_NAME` de outro sistema na sua janela não desvia `parar`, `backup` nem `restaurar`. As imagens são construídas uma por vez; com pouca memória, rode com `CRM_ALQUIMIA_BUILD_CPUS=1` e `CRM_ALQUIMIA_HEAP_BUILD_MB=2048` (veja "Pouca memória" nos requisitos). A CLI do Supabase usada é a versão testada (`npx supabase@2.120.0`), não a mais nova.

### Ligar o e-mail (opcional)

A instalação sai com `enable_confirmations = false` em `supabase/config.toml`, para o cadastro funcionar sem servidor de e-mail. Para exigir confirmação: configure `[auth.email.smtp]` nesse arquivo, troque para `true` e recrie o Supabase (`bash scripts/parar.sh` e rode o instalador). Os e-mails de confirmação e de nova senha usam os modelos em `supabase/templates/`: para saírem com o nome e a cor da sua marca, troque à mão os marcadores `__APP_NAME__`, `__ACCENT__` e `__ACCENT_FG__` nos dois arquivos (o cabeçalho de cada um explica) e recrie o Supabase do mesmo jeito. O Studio e o Inbucket (e-mails de teste) do Supabase vêm desligados por segurança; para ligá-los, veja os comentários em `supabase/config.toml`. Convites de equipe, exportações LGPD e alarmes usam o Resend (`RESEND_API_KEY` e `RESEND_FROM_EMAIL`, veja `.env.example`); sem isso o convite mostra o link na tela.

### IA de atendimento (opcional, desligada)

Nenhuma API paga é usada por padrão. A IA só liga com uma chave sua, colocada na tela de IA ou no `.env.local` (veja `.env.example`).

## Chaves desta instalação

O Supabase local que a CLI sobe vem com chaves de demonstração, públicas e iguais em toda instalação. O instalador troca todas por chaves só suas, geradas uma vez e mantidas nas reinstalações:

| Chave | Onde fica | Para que serve |
|---|---|---|
| Chave de assinatura das sessões (ES256) | `supabase/signing_keys.json`, gerada pela própria CLI | Assina as sessões de quem entra e as chaves anon e service_role do app. Sem ela, a CLI usaria a chave que vem dentro dela, e qualquer pessoa montaria uma chave de serviço válida. |
| Segredo do JWT | `CRM_ALQUIMIA_JWT_SECRET` no `.env.local` | O segredo HS256 que o Auth ainda aceita. |
| Chaves novas da API | `CRM_ALQUIMIA_PUBLISHABLE_KEY` e `CRM_ALQUIMIA_SECRET_KEY` no `.env.local` | As `sb_publishable_` e `sb_secret_` que o gateway troca pelas chaves anon e service_role. A secreta padrão da CLI abriria tudo. |

O instalador copia os três valores do `.env.local` para o `supabase/.env`, que a CLI lê sozinha. Os arquivos ficam só para o seu usuário, fora do git e fora da imagem Docker, e nada deles aparece na tela. A `supabase/signing_keys.json` **não entra no backup** (veja abaixo). Se ela se perder, rode o `instalar`: ele gera outra, as sessões caem, todo mundo entra de novo e os dados ficam. Na primeira reinstalação de quem instalou antes desta versão, o instalador gera a chave, reinicia o Supabase e avisa que as sessões caem.

## Backup e restauração

Um comando faz a cópia de segurança; outro volta a ela. O CRM precisa estar no ar (a cópia é tirada de dentro do Supabase local).

| Quero | Comando |
|---|---|
| Fazer um backup agora | `bash scripts/backup.sh` · `powershell -ExecutionPolicy Bypass -File scripts\backup.ps1` |
| Voltar a um backup | `bash scripts/restaurar.sh` · `powershell -ExecutionPolicy Bypass -File scripts\restaurar.ps1` |

**O que o backup guarda**, na pasta `backups/` (só o seu usuário acessa):

- `AAAA-MM-DD-HHMM.sql.gz`: os dados do banco (contatos, conversas, contas, funis, configurações).
- `AAAA-MM-DD-HHMM-storage/`: os arquivos (mídias, logos, exportações).
- `AAAA-MM-DD-HHMM-versao.txt`: em que versão do CRM e do schema do banco o backup foi feito.

A pasta (padrão `backups/`, ou a que você der em `CRM_ALQUIMIA_BACKUP_DIR`) tem de ser **só dos backups**: o comando a deixa acessível apenas ao seu usuário (e os arquivos de dentro herdam isso). Por isso recusa, sem mexer nela, uma `CRM_ALQUIMIA_BACKUP_DIR` que já tenha outros arquivos; na pasta padrão, só avisa. Um backup por vez: se outro (ou uma restauração) estiver rodando, o segundo recusa.

Ficam só os **14 backups mais novos**: ao fazer um novo, os mais velhos são apagados (o que acabou de ser criado nunca é). Para ter backup todo dia, agende o comando no `cron` (Linux e Mac) ou no Agendador de Tarefas (Windows).

**O que o backup NÃO guarda:**

- As conexões do WhatsApp: depois de restaurar numa máquina nova, leia o QR de novo.
- A `supabase/signing_keys.json`, a chave que assina as sessões, de propósito: uma cópia dela num backup seria uma credencial viva da sua instalação. Se ela se perder (máquina nova, pasta apagada), o `instalar` gera outra: as sessões caem e todo mundo entra de novo, e os dados ficam.
- O `.env.local`, que tem os segredos (chaves de criptografia, tokens). Guarde o `.env.local` e o `supabase/.env` juntos, numa cópia sua num lugar seguro (o segundo repete três valores do primeiro, e os dois têm de bater): sem as mesmas chaves, dados cifrados do backup (por exemplo CPF, credenciais de IA e os segredos de webhook e de integrações, cifrados com a `NUVEMSHOP_OAUTH_ENCRYPTION_KEY`, a chave de cifra do banco) não abrem.
- O código do CRM e o schema do banco: eles vêm do instalador.

O backup tem dados pessoais dos seus contatos (LGPD): não o deixe em pasta compartilhada, nuvem aberta nem o envie por e-mail. Guarde uma cópia fora do computador, por exemplo num disco externo.

**Para restaurar**, rode o comando de restaurar. Ele lista os backups, você escolhe um, e então precisa **digitar exatamente `RESTAURAR`**; qualquer outra coisa cancela sem mexer em nada. Antes de trocar qualquer dado ele faz um **backup de segurança** do estado de agora e, no fim, diz qual é, para você poder voltar (`bash scripts/restaurar.sh AAAA-MM-DD-HHMM`). Se o backup de segurança falhar, a restauração não roda. O banco é restaurado numa transação só: se a carga falhar, ele fica como estava. Os arquivos (Storage) não são transação: os de agora são **apagados** e os do backup copiados no lugar; se essa cópia falhar, os arquivos de antes estão no backup de segurança, e o comando diz como voltar a ele.

**Depois de restaurar, só o app volta sozinho.** O worker (a fila de mensagens e follow-ups) e o agendador ficam **parados de propósito**: a fila voltou a ser a do momento do backup, então mensagens e follow-ups que estavam pendentes naquela hora podem ser enviados **de novo**, mesmo que já tenham saído depois. Abra o CRM, confira as mensagens agendadas, as campanhas e os follow-ups pendentes, cancele o que já foi enviado e só então religue:

```bash
docker compose -p crm-alquimia --env-file .env.local start worker scheduler
```

Se der erro antes da carga do banco (nada mudou), os três sobem de novo sozinhos.

Restaure na **mesma versão** do CRM em que o backup foi feito: o comando confere o `AAAA-MM-DD-HHMM-versao.txt` e recusa, sem mexer em nada, um backup de outra versão (ou um backup antigo, sem esse arquivo), explicando o que fazer. Ele também não roda sem o `.env.local` na pasta do CRM. Para passar tudo para outra máquina: copie o `.env.local` para a pasta do CRM nela **antes** de instalar (o instalador grava no banco novo a chave de cifra que está nele; instalado antes, o banco ganha uma chave nova e os segredos cifrados do backup não abrem), rode o `instalar`, copie a pasta `backups/` e rode o comando de restaurar.

Erros comuns: "O Docker não está rodando" (abra o Docker Desktop) e "O Supabase local não está no ar" (rode o `instalar`, que é seguro repetir).

**Permissões:** no Linux e no Mac a pasta é `700` e os arquivos `600`. No Windows (PowerShell, e também no Git Bash) a pasta recebe uma ACL só do seu usuário, via `icacls`; se o `icacls` falhar o comando avisa na tela. O mesmo vale para o `.env.local` criado pelo instalador.

## O que sobe

| Serviço | Para quê | Porta no seu computador |
|---|---|---|
| `app` | o CRM | `localhost:3000` |
| `worker` | agente 24h (fila, follow-up) | `127.0.0.1:8787` (healthz) |
| `scheduler` | tarefas agendadas | nenhuma |
| `evolution` + `evolution-db` | WhatsApp por QR (Evolution 2.3.7, versão travada, com patch do Baileys) | `127.0.0.1:8080` |
| `redis` + `srh` | limite de taxa | nenhuma |
| Supabase (pela CLI) | banco, login, arquivos | `54321` e `54322` (veja o aviso de rede acima) |

A Evolution entrega as mensagens ao CRM por um webhook global com segredo no caminho. Detalhes do patch e do que ele resolve em [`docker/evolution/LEIA-ME.md`](docker/evolution/LEIA-ME.md).

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "O Docker não está rodando" | Abra o Docker Desktop e espere ele ficar pronto. |
| O app não responde 200 no fim | `docker compose -p crm-alquimia --env-file .env.local logs app`. A primeira compilação pode estourar a memória: feche programas e rode de novo com `CRM_ALQUIMIA_BUILD_CPUS=1` e `CRM_ALQUIMIA_HEAP_BUILD_MB=2048` (veja "Pouca memória"). |
| Erro de porta em uso | Troque a porta (tabela acima). |
| Depois de subir o Supabase à mão, o app não entra (erro 401) | O Supabase subiu com segredos que não são os do `.env.local` (por exemplo, o `supabase/.env` foi apagado ou trocado). Rode `parar` e depois o `instalar` de novo: ele regrava o `supabase/.env`, confere as chaves do Supabase de pé e o reinicia se não forem as desta instalação. |
| O `supabase start` à mão para com `failed to read signing keys` | A chave que assina as sessões sumiu. Rode o `instalar`: ele gera outra (as sessões abertas caem; os dados ficam). |
| Quero recomeçar do zero | `bash scripts/parar.sh`, depois `docker volume ls` e apague à mão os volumes `supabase_*_<projeto>` e `<projeto>_*` (o projeto é o `CRM_ALQUIMIA_PROJETO` do seu `.env.local`; o padrão é `crm-alquimia`). **Isso apaga seus dados.** |

## Segurança, contribuição e licença

- Vulnerabilidades: [SECURITY.md](SECURITY.md).
- Contribuir: [CONTRIBUTING.md](CONTRIBUTING.md).
- Mudanças: [CHANGELOG.md](CHANGELOG.md).
- Licença: MIT, em [LICENSE](LICENSE).
