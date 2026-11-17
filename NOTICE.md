# Avisos e atribuições

## CRM ALQUIM(IA)

Copyright (c) 2026 ALQUIM(IA) Performance. Distribuído sob a licença MIT (veja [LICENSE](LICENSE)).

## Origem do código

Este projeto parte do **DeskcommCRM**, de Rafael Melgaço, também sob licença MIT:
Copyright (c) 2026 Rafael Melgaço. O aviso de copyright original é mantido no [LICENSE](LICENSE),
como a licença exige. As mudanças feitas aqui (instalação local de um comando, WhatsApp pela
Evolution API, motor de disparo, marca) são de ALQUIM(IA) Performance.

## Componentes de terceiros que o `docker-compose.yml` baixa

Nenhum deles é redistribuído neste repositório (exceto o arquivo de patch descrito abaixo); cada um
segue a licença do seu projeto.

| Componente | Uso | Observação |
|---|---|---|
| Evolution API 2.3.7 (`evoapicloud/evolution-api`) | WhatsApp por QR | imagem travada por digest |
| Baileys 7.0.0-rc.9 | biblioteca de WhatsApp dentro da Evolution | veja o patch abaixo |
| Supabase (CLI e imagens locais) | banco, login, arquivos | |
| PostgreSQL, Redis | bancos | |
| `serverless-redis-http` (hiett) | ponte REST do Redis | imagem travada por digest |

### Patch do Baileys

`docker/evolution/baileys-messages-recv.js` é o arquivo `messages-recv.js` do Baileys 7.0.0-rc.9
com UM handler acrescentado (`CB:status`, que só confirma o recebimento da stanza `<status>`). O
arquivo original, sem o handler, está ao lado, em `docker/evolution/baileys-messages-recv.original.js`,
e o que mudou está descrito em [`docker/evolution/LEIA-ME.md`](docker/evolution/LEIA-ME.md).

### Licença do Baileys (MIT)

O `docker/evolution/baileys-messages-recv.js` contém código do Baileys. A licença MIT do Baileys exige
que o aviso de copyright e o texto abaixo acompanhem as cópias do código:

```
MIT License

Copyright (c) 2025 Rajeh Taher/WhiskeySockets

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> Texto e copyright conferidos no arquivo `LICENSE` do pacote do Baileys 7.0.0-rc.9, dentro da imagem
> da Evolution (`/evolution/node_modules/baileys/LICENSE`).

## Aviso sobre o WhatsApp

A Evolution API conecta ao WhatsApp por uma API **não oficial**. O uso de automação pode violar os
termos do WhatsApp e levar ao bloqueio do número. Este projeto não é afiliado ao WhatsApp nem à
Meta. O envio real de mensagens vem desligado por padrão: ligá-lo e o que se envia são decisão e
responsabilidade de quem opera a instalação.
