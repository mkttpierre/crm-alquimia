# Motor de disparo: atendimento e agente de objeções (etapa 2, só simulado)

O que acontece quando o lead responde a uma mensagem do motor. Código em
`lib/disparo/atendimento/`; dados da casa em `disparo_config.atendimento`
(migration 0241, lido só por `lib/disparo/atendimento/config.ts`). Mapa vivo:
`docs/architecture/motor-de-disparo.architecture.json` (nós `entrada`,
`atendimento`, `conversas`, `jev`, `central`).

## Caminho

1. A ingestão do canal dos chips grava a mensagem em `messages` (como sempre).
2. O gancho (`gancho.ts`) acha o lead aberto do contato e chama
   `atenderMensagem`. Erro aqui vira log; o webhook segue 200.
3. `disparo_leituras` reserva a leitura pela chave (external_id): reentrega do
   webhook não decide duas vezes.
4. A fila pendente do lead é cancelada ("o lead escreveu"), preservando o retorno de reserva até compra, recusa, opt-out, remarcação ou tomada humana.
5. Leitura: regras (`lib/disparo/leitura.ts`, parada de `lib/disparo/regras.ts`)
   e, com `OPENROUTER_API_KEY`, o Jev. Parada e número errado pelas regras
   nem chamam o Jev; com o Jev discordando, vale parar (`combinar`).
6. Decisão pura por perfil (`venda.ts` ou `prospeccao.ts`) devolve ações.
7. Ações: resposta vira linha em `disparo_envios` (`origem = auto`); aviso vira
   item da Central (`agent_inbox_items`, kind `other`, `ref_kind = lead`, título
   começando por "Atendimento"); encerrar cancela a fila e resolve os avisos.

## Trava

O atendimento não importa `lib/channels` (teste
`trava-atendimento.test.ts`). Com a trava fechada (`lib/disparo/trava.ts`), a
resposta nasce `simulado`; aberta, nasce `pendente` e quem leva ao canal é o
motor, que confere a trava de novo. O aviso ao operador nunca sai por
WhatsApp.

## Perfil venda (porta de um atendimento anterior)

| Lead disse | O que acontece |
|---|---|
| parar, número errado, xingamento, spam | encerra (`nao_contatar`), nada sai, sem aviso; irritação pesa no chip (1 = amarelo, 2+ no dia = vermelho 48h) |
| "não, obrigada" | encerra (`perdido`), nada sai |
| reclamação, assunto de `desvios`, áudio | operador |
| "quero sim"/"pode" ANTES da tabela | explicação (`explicacao`) e depois o funil (`escada[0]`); **não** é compra |
| preço ou interesse | funil de valores (com a explicação antes, se for interesse); já viu a tabela = operador |
| entrega | resposta `entrega` |
| caro | desce UM degrau da `escada`; acabou a escada = operador |
| kit em meses | pacote de `fechamento`, `pronto_fechar`, quente, aviso de compra |
| quer fechar SEM dizer a quantidade | **não** é compra nem ponto de parada: sem aviso, sem pausa, sem esquentar. Ainda não viu os valores = funil de valores (`escada[0]`); já viu = `perguntaKit` (etapa `qualificando`). Sem `perguntaKit` = operador |
| kit em unidades (quantidade dita, mas não vira meses) | `perguntaKit` e aviso de compra (a quantidade foi dita; o operador resolve) |
| pede o site | links do kit e do de cima (o de cima primeiro), aviso de compra |
| objeção com gatilho (ou escolhida pelo Jev com confiança ≥ `confiancaObjecaoJev`) | áudio da objeção + pergunta de retorno, uma vez cada |
| já está quente | nada automático; kit novo atualiza o aviso |

Limites: `ritmo.limiteAutomaticasSeguidas` respostas automáticas seguidas (a
mesma regra do motor; uma decisão conta uma, mesmo com várias partes; o
operador escrevendo zera) e `limiteObjecoes` tipos de objeção por conversa (a
escada de preço conta uma). Mídia sem `id` na `media_library` barra a resposta.
Resposta nova nunca fura a fila: espera a última parte já agendada.

## Perfil prospecção (porta de um atendimento anterior, sem agenda)

Recusa educada → pergunta do motivo uma vez; "não" de novo encerra. Objeção →
resposta `objecao_<id>` uma vez cada; quem decide junto (`objecaoDecisor`)
ganha resposta e aviso. Interesse claro (topou, saber mais, como funciona,
ligação) → convite do diagnóstico + link `?c=<codigo>`, se nada impede
(`motivoSemConvite`). Preço, horário, "quem é" → operador com o lead quente.
Oferecer, escolher e confirmar horário é da Fase 6 (Google Agenda).

## Quem está no comando (etapa 3)

Antes de decidir, `atenderMensagem` pergunta `situacaoHumana` (`humano.ts`):
`contacts.force_human`, e nas conversas ABERTAS do contato (mais a da mensagem)
`bot_silenced_until` (futuro ou `infinity`) e dono humano (`assignee_kind = user`
ou `assigned_to_user_id`). A regra é `decidirElegibilidade` em modo `open`, a
mesma do drain e do handoff. Qualquer veto: nada sai, a fila automática do lead é
cancelada e a leitura fica registrada ("humano no comando"). Vale para os dois
perfis.

**O motor também respeita** (`lib/disparo/motor.ts`, a mesma regra de `humano.ts`,
lida por `humano-supabase.ts`): antes de sair, toda abertura, toque de cadência e
resposta automática pendente confere `force_human`, `bot_silenced_until` (futuro ou
`infinity`) e dono humano. Veto: o envio é cancelado com o motivo "humano no comando
(...)" e o resto da fila do lead também. Lembretes (viram tarefa, não vão ao lead)
não passam por aqui.

**Exceção: o pacote da parada.** As respostas decididas junto com um ponto de parada
que pausa a conversa (pacote de fechamento, links do site) saem marcadas
(`disparo_envios.da_parada`). A pausa que o próprio ponto de parada põe logo depois de
enfileirá-las NÃO as cancela, nem no motor nem quando a lead escreve no meio do
pacote ("ok", "pode ser?"): o atendimento só registra. Quem assume de fato
(`force_human`, dono humano) cala também o pacote, e opt-out/lead bloqueado cancela
tudo, como sempre.

**Interruptor por conversa**: o par que a tela já tem, `pause-ai`
(`bot_silenced_until = infinity`) e `reactivate-bot` (solta as três travas). Não
existe campo "atendimento ligado" próprio: seria o quarto lugar a consultar e o
único que o botão da tela não conhece.

## Desconto e piso de preço (D5)

O atendimento nunca oferece desconto nem valor fora da tabela; só o operador
negocia.

- Pedido de desconto/negociação ("tem desconto?", "faz por 500", "tem cupom",
  "baixa o valor") lê `pede_desconto` (`lib/disparo/leitura.ts`, regra
  determinística que vale mesmo se o Jev ler outra coisa e que vence "quero o de
  12 meses"). A decisão (`venda.ts`) não responde: avisa o operador na Central e
  emite o evento `pede_desconto`. "Tem mais barato?" e "achei caro" continuam
  objeção de preço (a escada só desce para preços da tabela).
- Piso em código (`parada.ts`, `motivoForaDaTabela`): todo texto automático do
  perfil venda só cita dinheiro que seja `pixCents` ou `parcelaCents` de um kit, e
  não pode falar de desconto/cupom/preço especial. Barrou, a resposta não sai e a
  conversa vai para o operador. O brinde extra continua só no último toque
  (`proibidos`).

## Pontos de parada (D4)

`disparo_config.atendimento.parada`: `celular` (WhatsApp pessoal do operador),
`aviso` (formato do aviso, `{titulo} {nome} {telefone} {disse}`) e `pontos`. Cada
ponto tem gatilho `evento` (`EVENTOS_DE_PARADA`: escolheu_kit, quer_fechar,
pediu_site, pede_desconto, excedeu_limite, lead_quente, horario,
diagnostico_enviado) e/ou `padrao` (regex sobre o texto normalizado, ex.: CEP/rua)
e as ações: `parar` (pausa a conversa como o `pause-ai`), `notificar` (celular),
`etapa`/`pipeline` (move o card; no mesmo funil não recua) e `tag` (lead e
conversa). A decisão que já abriu aviso na Central não abre um segundo.

**"Quero fechar" sem a quantidade NÃO é ponto de parada** (decisão de produto):
o atendimento conscientiza, quebra objeção e qualifica; só quando a lead diz
QUANTOS meses/unidades quer (`escolheu_kit`) sai o pacote de fechamento e, depois dele,
a parada. Antes, "quero fechar" pausava a conversa e, se a lead respondesse "12 meses",
o pacote não saía (já estava com o operador). O evento `quer_fechar` continua no
vocabulário só para não invalidar config já gravada, mas `venda.ts` não o emite mais
(com a quantidade dita o evento é sempre `escolheu_kit`); o exemplo não tem mais o ponto
`quer_fechar`. Seguem como pontos de parada: pedido do site, endereço dado, desconto e limite
de respostas.

**Ordem** (provada em `atendimento/parada-ordem.test.ts`): o que a decisão manda ao
lead (pacote de fechamento: PT1, PT2 e o pedido de nome, endereço e pagamento, com a
pausa de cada parte pela duração do áudio ou tempo de leitura, `pausaApos`) entra na
fila PRIMEIRO; só então a conversa é pausada, o card e a etiqueta mudam e o aviso ao
celular é gravado, com `enviar_apos` depois do último envio agendado. O motor ainda
segura o aviso enquanto o lead tiver resposta automática por sair.

**Aviso ao celular do operador**: sai pelo MESMO chip em que a lead
conversa (a sessão de canal da conversa de origem aponta para o chip), nunca por
outro. Fica em `disparo_avisos_operador` (migration 0242) e na timeline do lead
(atividade `note`). Com a trava fechada (qualquer combinação que não seja modo real +
`DISPARO_REAL_LIBERADO=sim`) a linha nasce `simulado` e nada fala com canal. Com a
trava aberta nasce `pendente` e o motor entrega: um por volta e por chip, dentro do
ritmo do chip (intervalo mínimo entre quaisquer envios, máximo por hora, teto do dia;
o aviso entra na contagem do chip), pelo mesmo `enviarPeloChip` e pelas mesmas travas
do envio real, mais a allowlist `DISPARO_SO_PARA` (o número do operador também precisa
estar nela). Falha: nova tentativa em 10 min, três falhas viram `falhou`; sinal de
restrição para o chip. Parado há mais de 6 h, é cancelado (a Central já avisou). O
número vem de `parada.celular` (configuração de cada organização; os testes usam um número fictício).

## Diferenças conhecidas em relação aos CRMs antigos

- A etapa do atendimento fica em `disparo_conversas` e move o card pelo mapa
  `atendimento.funil` (`funil.ts`).
- "Seguidas" conta uma por decisão: numa organização, explicação + tabela gastavam duas.
- O aviso de compra vai para a Central; o aviso do ponto de parada vai ao WhatsApp do operador pelo chip da conversa (acima).
- Prospecção: sem Jev, sem nota PDCM, sem alertas com resposta do operador por
  WhatsApp, sem horários.
- O motor ainda não envia mídia (`enviarReal` manda texto). Antes de ligar o
  real, o envio de áudio e imagem tem de existir — senão o funil sai pela metade.

## Config e ensaio

A config do atendimento de cada organização é gravada em `disparo_config.atendimento` (objeções com áudio, kits, escada,
fechamento), resolvendo cada mídia pela `media_library` da org e conferindo com o schema antes. Nasce com `ligado: false`.
O ensaio roda no banco local e apaga só o que criou.

Bloco `metodo` (Oferta de Entrada) incompleto, por exemplo sem os valores: só o Método fica desligado, o resto do
atendimento segue e o log avisa uma vez por bloco quais campos faltam (com `ligado: false` não avisa). Com o Método
desligado, à mão ou por config incompleta, a conversa que estava em `ofertado`, `escolhendo` ou `aguardando_pix` cai no
fluxo genérico do atendimento, sem o aviso ao operador de quem escreveu enquanto espera o Pix.

## Retorno de reserva por falta de dinheiro

**CONFIRMADO no código:** recurso de venda opt-in, `atendimento.retornoReserva.ligado` (padrão false). A primeira objeção continua com sua resposta pronta e a segunda com os kits de entrada; a promessa soma um único `disparo_envios.tipo=retorno_reserva`, `origem=auto`, `estado=pendente`. Nenhuma alteração de preço, escada ou Método.

- **Data:** `data-do-retorno.ts` recebe o relógio e interpreta dia do mês, semana, amanhã e mês seguinte no fuso de São Paulo, às 9h. Dia já passado vai ao próximo mês; data impossível retorna null. "Sexta que vem" significa a próxima sexta; "sexta da semana que vem" explicita a semana seguinte. "Semana que vem" sem dia soma sete dias. "Mês que vem" sem dia usa `DIA_PADRAO_MES_SEGUINTE=5`. Domingo aberto permanece domingo; fechado/feriado usa o helper de janela do motor. Às 9h é o planejamento, sujeito ao ritmo do chip.
- **Estado:** `disparo_conversas.dados.retornoEm` e `retornoPedido={kit,condicao}`; condição é o id do último degrau/oferta de entrada. `retornoEnviadoId` evita duplicar os avisos do pós-envio.
- **Modelo:** `disparo_config.modelos.retorno_reserva` (lista de versões); padrão no código. Usa o substituidor de slots existente, primeiro nome e `{linha_do_pedido}`. Sem nome, o padrão vira "Olá, tudo bem?"; sem kit, usa as condições já passadas. Slots faltando ou texto proibido barram a fila e abrem aviso na Central.
- **Remarcação/cancelamento:** a trava existente por lead serializa leitura e envio. Nova promessa cancela o anterior com motivo de remarcação. Conversa comum preserva o retorno e não atrasa respostas imediatas. Compra/fechamento, Pix de kit pago, recusa, opt-out e tomada humana cancelam. O motor revisa também as reservas futuras (até 1.000 pendentes por organização por ciclo); quem estiver além desse lote ainda é conferido antes de enviar. Motor desligado não faz varredura; ao religar, confere antes do envio.
- **Saída:** janela do chip, saúde, quarentena e limite de automáticas são conferidos de novo. Só depois de enviado/simulado marca quente e pronto para fechar, abre aviso de compra na Central, registra atividade `note` com `payload.evento=retorno_reserva_enviado` e aciona o ponto novo; sem ponto próprio herda o destino do ponto de compra. O aviso de celular usa `parada.celular` e a fila existente de avisos. Falha do canal não marca quente.
- **Operação:** a ativação é por organização, via configuração, sem aplicação automática e sem backfill de mensagens antigas. Nenhum schema/migration novo.

**Living System:** entrada = mensagem recebida + decisão de venda; saída = fila do motor, timeline do lead, Central e celular. Próximo passo = reserva até a data, depois fechamento humano. Retorno do erro = cancelamento com motivo visível na fila e aviso na Central quando montagem/gravação falha; nova promessa remarca, compra/recusa encerram. Superfície de configuração permanece SQL (dívida explícita deste recorte, sem tela nova); os resultados aparecem nas telas existentes. Cobertura em memória: parser, atendimento inteiro e motor. Envio real e prova visual não foram executados neste recorte.
