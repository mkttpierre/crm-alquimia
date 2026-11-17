# Evolution API desta instalação: versão travada e patch do Baileys

O CRM conecta o WhatsApp pela **Evolution API** (código aberto, API não oficial). Esta pasta guarda o que o `docker-compose.yml` monta por cima da imagem dela.

## Versão travada

A imagem é referenciada por **digest**, não por tag:

```
evoapicloud/evolution-api@sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252
```

É a Evolution **2.3.7** com o Baileys **7.0.0-rc.9**. Tag móvel (`latest`, `v2`) fica de fora de propósito: uma versão nova da Evolution pode trazer outro Baileys, e o patch abaixo só vale para este.

## O patch (`baileys-messages-recv.js`)

Monta-se por volume, somente leitura, no lugar de `/evolution/node_modules/baileys/lib/Socket/messages-recv.js`.

**Problema que resolve ("chip surdo").** O WhatsApp passou a entregar posts de canal, stories e reações em grupo numa stanza `<status>`. O Baileys 7.0.0-rc.9 não tem handler para ela e nunca devolve o `ack`. O servidor do WhatsApp segura a fila offline atrás desse item: as mensagens novas e os tiques de entrega chegam **horas** depois, em lote. De tempos em tempos o servidor derruba a conexão (`stream:error <ack class="status">`) e, na reconexão, reentrega o mesmo item.

**O que o patch faz.** Acrescenta `ws.on('CB:status', ...)`, que só chama `sendMessageAck(node)`. O conteúdo é descartado (o CRM não usa canal, story nem reação de grupo). Procure `PATCH LOCAL` no arquivo.

## Arquivos

| Arquivo | O que é | sha256 |
|---|---|---|
| `baileys-messages-recv.original.js` | cópia intacta tirada da imagem acima | `8b9329ddf95fa7a1785826d8861af236f5f055ff22a5ed1ce52afdf9565d873e` |
| `baileys-messages-recv.js` | a mesma cópia com o handler `CB:status` acrescentado (só um comentário e o handler de diferença) | `04805e9787527e87a056808e27efd9dad88475f9eadae2ddb36963bce874a5e6` |

Para ver exatamente o que mudou: `diff baileys-messages-recv.original.js baileys-messages-recv.js`.

## Conferir que o patch está montado

```bash
docker compose exec evolution grep -c "PATCH LOCAL" /evolution/node_modules/baileys/lib/Socket/messages-recv.js
# deve imprimir 1
```

No Git Bash do Windows, prefixe com `MSYS_NO_PATHCONV=1`, senão o caminho vira `C:/Program Files/Git/...`.

## Webhook global

O compose liga o webhook **global** da Evolution: uma URL só, para todas as conexões, apontando para o app (`/api/v1/webhooks/evolution/<segredo>`). O segredo é o `EVOLUTION_WEBHOOK_TOKEN` que o instalador gera. A lista de eventos é a mesma que o app consome (`EVENTOS_DO_WEBHOOK` em `lib/channels/evolution/client.ts`); um teste confere que as duas listas não se afastam.

## Desfazer o patch

Tire a linha do volume `baileys-messages-recv.js` do `docker-compose.yml` e recrie o serviço: `docker compose up -d evolution`. Sem o patch, volta o "chip surdo".

## Trocar a versão da Evolution

1. Rode a imagem nova sem o patch e olhe o log com `LOG_BAILEYS=debug` por poucos minutos (nunca deixe ligado: derruba a conexão a cada poucos minutos e enche o disco).
2. Se o Baileys novo já trata `<status>`, o patch deixa de ser necessário: retire o volume.
3. Se não trata, gere um patch novo a partir do `messages-recv.js` **da imagem nova**. Montar o arquivo desta pasta numa versão diferente quebra a Evolution.
4. Atualize o digest no `docker-compose.yml` e o teste `tests/unit/instalador-compose.test.ts`.
