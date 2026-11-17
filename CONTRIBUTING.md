# Contribuindo

Obrigado por querer ajudar. Mensagens e documentação em português do Brasil.

## Rodando o projeto

Siga o [README](README.md): `scripts/instalar.sh` (ou `scripts/instalar.ps1` no Windows) sobe tudo. Para
desenvolver com recarga automática, pare o `app` do compose e rode o Next na sua máquina:

```bash
docker compose -p crm-alquimia --env-file .env.local stop app
corepack enable
pnpm install
pnpm dev        # http://localhost:3000
```

O `.env.local` que o instalador gerou serve para os dois jeitos. Fora do Docker, troque
`host.docker.internal` por `127.0.0.1` nas linhas `NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_DB_URL` (e
`http://srh:80` por um Redis HTTP seu, ou deixe o limite de taxa em memória apagando as duas linhas
`UPSTASH_*`).

## Antes de abrir o pull request

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:db        # precisa de Docker; aplica o baseline num Postgres limpo
```

Rode a suíte de unidade inteira (`pnpm test:unit`, sem caminho), não só o arquivo que você tocou.

## Regras que não mudam

- Texto de tela em português do Brasil, passando por `t()`.
- Toda mudança de schema sai como migration em `supabase/migrations/`, **mais** o apêndice idempotente
  em `supabase/baseline.sql` (é ele que o instalador aplica) e a linha em `supabase/migrations/MANIFEST.md`.
  Função nova em `public` termina com `revoke execute ... from public, anon`.
- Tabela com dados de organização leva `organization_id`, RLS e a policy de isolamento. Handler que usa a
  chave de serviço filtra `organization_id` à mão, vindo de fonte confiável (nunca do corpo).
- Entrada externa passa por Zod. Nada de `console.log` (use `lib/logger.ts`).
- Nenhuma API paga no caminho padrão. O envio real de mensagens continua com as duas chaves
  (modo real na tela **e** `DISPARO_REAL_LIBERADO=sim` no servidor).
- Grupos de WhatsApp (`@g.us`) são descartados na entrada; não crie caminho que os grave.
- Nenhum dado de operação real no repositório: telefones, nomes de clientes, chaves e domínios pessoais
  não entram em código, teste ou documento.

## O portão de dados (`tests/unit/sem-dado-de-operacao.test.ts`)

Esse teste varre todo arquivo rastreado e reprova o que não pode ser público: telefone que não é de
fixture (com DDI 55 ou de outro país), LID de WhatsApp com cara de real, chaves de API, caminho do seu
computador, e-mail pessoal. Ele não imprime o trecho achado, só o arquivo, a linha e a regra.

- **Telefone de exemplo:** o padrão fictício fica no **fim** do número: um dígito repetido 3 vezes nos 4
  últimos (`5511999990001`), uma sequência de 4 no fim (`…1234`), um dígito repetido 4 vezes nos 8
  últimos (`+55 11 9 0000-1102`) ou a faixa 555 da América do Norte (`+1 202 555 0137`). Um DDD que não
  existe (20, 23) serve para o exemplo que precisa parecer real.
- **LID de exemplo:** `70000000000001@lid` (zeros e o índice no fim).
- **Falso positivo** (um id de run, um timestamp, um número que não é telefone): primeiro tente mudar o
  texto para não colar dígitos (um número entre parênteses logo depois de um telefone vira parte dele:
  separe com vírgula e palavras). Se não der, registre a isenção em `REGRAS_ISENTAS_POR_ARQUIVO`, no próprio
  teste, por regra e por arquivo (nunca para o arquivo inteiro), com um comentário dizendo por quê. Quem
  revisa confere cada isenção.

## Segurança

Vulnerabilidade não vira issue pública: veja [SECURITY.md](SECURITY.md).

## Roteiro (o que está aberto)

- Generalizar o perfil "venda" do atendimento por WhatsApp: hoje ele é experimental, só por JSON, e ainda tem o formato de uma oferta de entrada com bônus e kits em meses (`lib/disparo/atendimento/`).
