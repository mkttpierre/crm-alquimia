# Política de segurança

## Versões suportadas

Só a versão mais recente recebe correção de segurança. Mantenha a sua instalação atualizada
(veja o [CHANGELOG](CHANGELOG.md) antes de atualizar).

| Versão | Suportada |
|---|---|
| 1.x (mais recente) | sim |
| anteriores | não |

## Como reportar uma vulnerabilidade

**Não abra issue pública.** Relate de forma privada pelo GitHub: no repositório, aba **Security** →
**Report a vulnerability** (relato privado de vulnerabilidade, "Private vulnerability reporting"). Só os
mantenedores veem o relato. Inclua:

- o que você encontrou e onde (tela, rota ou arquivo);
- como reproduzir, em passos curtos;
- o impacto que você enxerga.

O que você pode esperar:

- confirmação de recebimento em até 7 dias;
- avaliação e plano de correção em até 30 dias, quando confirmada;
- crédito no aviso publicado, se você quiser.

## O que interessa especialmente

- Vazamento entre organizações (burla de RLS ou do filtro `organization_id`).
- Burla de login ou de papéis (visualizador, agente, gerente, administrador).
- Exposição de dados pessoais (contatos, conversas, mídia do WhatsApp).
- Injeção por payload de webhook ou pela API `/api/v1`.
- Vazamento de segredos (chaves, tokens, cookies de sessão).

## Rede: o Supabase local fica exposto na sua rede local

A CLI do Supabase publica a API (porta 54321) e o banco (porta 54322) em **todas as interfaces** da
máquina, e não oferece como restringi-las ao seu computador. O banco usa a **senha padrão da CLI**
(`postgres`/`postgres`) e o CRM se conecta a ele como `postgres` (o único papel que a CLI entrega
localmente; por isso `SUPABASE_DB_URL` usa `postgres`).

**O que isso quer dizer:** numa rede que não é só sua (Wi-Fi de café, coworking, empresa),
qualquer pessoa nela abre o banco pela porta 54322 com essa senha pública e **lê e altera todos os dados do CRM, sem conta**:
contatos, conversas, mídias e a tabela de segredos cifrados (a chave que os abre também está no banco).

A API (54321) já não abre com chave conhecida. A CLI do Supabase vem com chaves de demonstração, públicas e
iguais em toda instalação, e o instalador troca todas por chaves só desta instalação (geradas uma vez,
mantidas nas reinstalações, nunca impressas):

- **Chave de assinatura das sessões** (`supabase/signing_keys.json`, ES256, gerada pela própria CLI com
  `gen signing-key`). O `supabase/config.toml` aponta para ela em `[auth] signing_keys_path`. Ela assina as
  sessões e as chaves anon e service_role, e é a única chave assimétrica que o PostgREST e o Auth aceitam.
  Sem ela, a CLI usa a chave que vem dentro do próprio binário: qualquer pessoa que alcance a porta montaria
  um token service_role válido. Sem o arquivo, o `supabase start` falha, em vez de voltar à chave pública.
- **Segredo do JWT** (`CRM_ALQUIMIA_JWT_SECRET`): o segredo HS256 que o Auth ainda aceita para tokens sem `kid`.
- **Chaves novas da API** (`CRM_ALQUIMIA_PUBLISHABLE_KEY`, `CRM_ALQUIMIA_SECRET_KEY`): as `sb_publishable_` e
  `sb_secret_` que o gateway da CLI troca pelas chaves anon e service_role. A `sb_secret_` padrão da CLI é
  pública e daria acesso de serviço.

Os três valores ficam no `.env.local` e são copiados para o `supabase/.env`, que a CLI lê sozinha (subir o
Supabase à mão continua com as chaves desta instalação). Os arquivos ficam só para o seu usuário, fora do git e
fora da imagem Docker.

**O que fica no backup:** os dados do banco e os arquivos. A `supabase/signing_keys.json` **não entra no
backup**, como o `.env.local`: uma cópia dela junto dos dados seria uma credencial viva da instalação. Perdê-la
custa pouco: o instalador gera outra, as sessões caem (todo mundo entra de novo) e os dados ficam. O mesmo
acontece na primeira reinstalação de quem instalou antes desta versão: o instalador gera a chave, reinicia o
Supabase com aviso e regrava as chaves do app. O que precisa da sua cópia é outra coisa: guarde o `.env.local` e o
`supabase/.env` juntos, num lugar seguro (o backup não guarda nenhum dos dois; o segundo repete três valores do primeiro). Sem o
`.env.local`, os dados cifrados do backup não abrem.

O CI (`.github/workflows/e2e.yml`) é a única exceção: num ambiente descartável, ele tira essas linhas do config e
sobe com as chaves de demonstração da CLI.

Use esta instalação em rede confiável ou **bloqueie as portas 54321 e 54322 no firewall** (de entrada, para
tudo que não seja a própria máquina):

- **Windows** (PowerShell como administrador):
  `New-NetFirewallRule -DisplayName 'CRM ALQUIM(IA) Supabase' -Direction Inbound -Protocol TCP -LocalPort 54321,54322 -Action Block`
- **Mac:** Ajustes do Sistema › Rede › Firewall: ligue e bloqueie conexões de entrada para o Docker.
- **Linux:** regras do `ufw` não valem para portas publicadas pelo Docker. Use a cadeia `DOCKER-USER`, por
  exemplo `sudo iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 54322 -j DROP` (e o mesmo para
  54321). Essa regra não foi provada nesta versão; confira com um teste de outra máquina da rede. O Studio e o Inbucket do Supabase vêm desligados em `supabase/config.toml`
por isso: só os ligue em rede confiável. Os serviços do `docker-compose.yml` (app, worker, Evolution)
publicam apenas em `127.0.0.1`.

Ao lado de outro sistema na mesma máquina: o instalador recusa porta já ocupada por outro programa (assim o
CRM nunca fala, sem perceber, com o banco de outro Supabase local, que usa as mesmas chaves de demonstração
da CLI) e todo comando leva o nome de projeto explícito (`crm-alquimia` ou `CRM_ALQUIMIA_PROJETO`).

Para uso em servidor ou fora de uma rede confiável, use um Supabase com senha própria (projeto na nuvem
ou Postgres seu) e não esta instalação local.

## Fora do escopo

A instalação local é do seu computador: firewall, disco e o próprio sistema operacional são
responsabilidade de quem instala. O instalador gera os segredos aleatórios e não os imprime; o
arquivo `.env.local` fica só na sua máquina e nunca deve ser versionado nem compartilhado.
