# Motor de disparo: ritmo por organização (exemplo com duas organizações)

O ritmo de cada organização vive em `disparo_config.ritmo` (jsonb, lido só por
`lib/disparo/config.ts`). Os valores abaixo são **exemplos** de dois regimes possíveis: venda para pessoa
(organização A, perto do padrão do motor) e prospecção para empresa (organização B). Ajuste à sua operação;
nenhum número aqui é medição ou recomendação.

| Parâmetro | Organização A (padrão do motor) | Organização B |
|---|---|---|
| Janela de mensagem nova | seg–sáb 8h–19h, dom 8h–12h, sem almoço | seg–sex 8h–12h e 13h–16h (almoço livre); fim de semana não |
| Feriados | lista nacional, com exceções configuráveis | lista nacional completa |
| Intervalo entre novas | dia 1 da rampa 20–40 min, dia 2 15–30, depois 10–18 (maduro 10–15), domingo 10–13; 1 em 6 vezes +5–15 min | 19–23 min sempre, sem extra |
| Piso entre novas | 10 min | 4 min (a vez do chip já impõe 19–23) |
| Piso entre quaisquer envios | 90 s | 3 min |
| Máximo por hora | 12 envios / 6 aberturas | 20 envios / 6 aberturas (não limita na prática) |
| **Pausa longa** | **20–40 min a cada 5–9 novas**; chip maduro (dia ≥ 12) **15–30 a cada 7–12**; domingo **12–20 a cada 10–14** | **15–30 min a cada 10–15**, sem fase (`pausaMaduro`/`pausaDomingo` nulos) |
| Rampa (aberturas/chip/dia) | 10, 12, 14, 17, 20, 23, 26, 29, 32, 34, 36 | 5, 7, 9, 11, 13, 15, com `teto_diario` 10 |
| Teto total do chip | aberturas × 2,2 + 10 | aberturas × 4 |
| Primeiro envio do dia | 0–25 min depois da abertura do dia | 0–1 min |
| Cadência | `reativacao_3_toques` (abertura, toque 2 em D+2 dias de envio, toque 3 em D+5 e ≥3 após o 2) | `prospeccao_14_dias` (D1, D2, D4 lembrete de áudio, D7, D10 lembrete de ligação, D14) |
| Lembretes | — | teto 20/dia para D4 e para D10; só leads com `porta = acessivel` |
| "golpe" é parada dura | não (na organização A é objeção) | sim (B2B) |

## Abertura com imagem e legenda

`disparo_config.ritmo.aberturaMidiaId` permite escolher uma imagem da biblioteca da organização para a abertura.
O motor grava um único envio `abertura` com `midia_id` e o modelo de texto como legenda. As regras de `escolha`
continuam selecionando a legenda para cada lead. A imagem precisa existir no armazenamento e pertencer à organização;
imagem inválida cancela a abertura inteira. Não há envio de texto avulso como alternativa.

O padrão `null` preserva a abertura textual e a prévia em partes configurada por lead. Quando definida, a imagem da
organização vence essa prévia. A cadência, a deduplicação, os limites do chip, as travas e a prioridade das respostas
continuam as mesmas. Alterar essa configuração não modifica envios que já estejam na fila nem ativa uma campanha.

## Atendimento: o que acontece quando o lead responde

- **Parada.** Pedido de parar, xingamento, ameaça de denúncia e pergunta de onde veio o número encerram a cadência e movem o card para "não contatar". Conta como pedido de parar tanto "me tira da lista" quanto "tira meu número da lista" e "remove meu contato". O contato e a conversa continuam no Inbox; só o disparo para. A regra mora em `lib/opt-out/deteccao.ts` (ingestão) e em `lib/disparo/regras.ts` (motor).
- **Recusa educada.** "Não tenho interesse" encerra a cadência sem ser parada dura; na prospecção o motor pergunta o motivo uma vez.
- **Card do funil.** A etapa da conversa (qualificando, pronto para fechar, fechado, perdido, não contatar) vira a etapa do card pelo mapa `disparo_config.atendimento.funil` de cada organização, e cada movimento grava uma atividade `stage_changed`.
- **Limite.** No máximo 2 respostas automáticas seguidas; a terceira vai para o operador.
- **Mídia.** Áudio e imagem saem na ordem do passo e com a pausa planejada, atrás da mesma trava dupla do texto.
- **Eco do próprio motor não é humano.** O espelho do envio em `messages` só é gravado depois que o canal
  responde; se o eco `fromMe` do WhatsApp chegar antes, a ingestão confere a fila do motor (`lib/disparo/eco-do-motor.ts`):
  envio para um lead daquele contato em `enviando` ou recém-`enviado` (3 min) com o mesmo corpo é eco, grava a linha e
  NÃO pausa a IA (senão o motor cancelaria a fila do lead como "humano no comando"). Digitação real no celular segue
  pausando.
- **Teste A/B da abertura.** Lead com `custom_fields.ab_teste` preenchido não é cliente para o atendimento
  (`ehCliente`, `lib/disparo/atendimento/venda.ts`) nem para a conferência do motor na hora de mandar o toque do kit
  (`situacaoDoKit`), mesmo com classe P1–P4, `produto_origem` ou trilha de cliente. O braço (`ab_braco`) e o grupo
  (`ab_grupo`) são dados do lead; a escolha do texto da abertura por braço é configuração (`escolha`), não código.
- **Opções de queixa.** `atendimento.queixas` (lista de `{ id, gatilho, resposta, operador, motivo }`,
  vazia por padrão): o lead do braço A (`ab_braco = "A"`) que responde à pergunta da abertura com uma das opções recebe a
  resposta daquela opção, uma vez por conversa e só antes da tabela; a escolha fica em `disparo_conversas.dados.queixa`.
  A primeira opção da lista que bate vence. Vem logo depois da parada dura e antes do Método, da recusa e dos desvios;
  pergunta de preço, escolha de kit, "quero fechar", pedido de desconto, reclamação e relato de saúde vencem a queixa.
  Com `operador: true`, responde e passa a conversa ao operador. Não conta como objeção.
- **Lembretes do kit depois do funil do operador.** Com `atendimento.followupKit.aposFunilDoOperador.ligado`
  (padrão desligado), o funil da lista `funis` (padrão `funil_valores`) mandado pela caixa de conversa, em envio real,
  planeja os toques do `followupKit` a partir da chegada da última parte, pelo chip da conversa. Antes cancela os toques
  e a oferta do Método pendentes (repetir o funil não duplica), marca a conversa com a tabela enviada e, com
  `liberaOperador` (padrão ligado), dá a pendência do operador como atendida. Não planeja para cliente, lead em não
  contatar, humano no comando, conversa pronta para fechar ou no funil do Método. Cancelar a sequência cancela também
  os toques. Falha no planejamento não derruba o agendamento: vira aviso na Central.
- **Campanha por nome.** Todo tipo `campanha_<nome>` (minúsculas, dígitos e `_`, até 30; `campanha_kit` e
  `campanha_kit_l` continuam valendo) sai como abertura: janela, vez do chip, piso entre novas, máximo por hora e teto
  de aberturas do dia, que passam a contar essas campanhas pelo prefixo. Fica fora da cadência (não planeja toque).
  As janelas da base (só `campanha_j<DDMM>` e os lembretes `_l<n>`, ex.: `campanha_j0101_l1`) são o último recado da
  vez: o verificador libera o proibido `excetoUltimo` (o brinde extra da organização A). Qualquer outra campanha segue barrada.
- **"Compro dia X".** Com `atendimento.retornoReserva.ligado`, a lead que já viu a tabela e marca o dia da
  compra ("compro dia 20", "fecho sexta", "pago mês que vem") não é compra agora: recebe a resposta
  `compro_dia_confirma`, se a casa tiver, e o retorno no dia, com `retornoPedido.motivo = "compra"` e o texto de
  `disparo_config.modelos.retorno_compra`. **Sem esse modelo, nada é agendado** (o texto da reserva fala de pedido
  reservado, e o bot não prometeu reserva) e o operador é avisado na Central. Quando a frase é lida como "quero fechar"
  ("vou comprar dia 20"), o evento `quer_fechar` sai (o operador é avisado) e o retorno agendado por essa mesma
  mensagem fica de pé, porque a confirmação promete chamar no dia. Mensagem seguinte que fecha a compra o cancela. Escolher o kit, perguntar o preço e a falta de dinheiro seguem os caminhos de antes.
- **Teste A/B e compra aprovada (ponto de extensão).** O lead do teste volta a ser cliente quando tem compra aprovada
  em `custom_fields.compras_aprovadas`: um objeto `{ "<id da transação>": "<situação>" }`, em que só o valor
  `aprovada` conta (reembolso troca o valor e deixa de contar). **Nenhum código do produto grava esse campo**: quem
  integra um meio de pagamento (webhook próprio, automação) grava a situação de cada transação no lead. Sem
  integração, o campo fica vazio e o lead do teste segue como não cliente. A conferência do retorno no dia
  (`conferirRetornoReserva`) segue a mesma regra de `ehCliente`.

## Freios de saúde do chip (migration 0243)

O motor calcula a saúde de cada chip por dia, sobre as aberturas do dia, a cada volta do cron (no máximo a cada
15 minutos por chip; não há cron novo). A conta é pura (`lib/disparo/saude.ts`), o job está em
`lib/disparo/saude-job.ts` e os limiares vivem em `disparo_config.ritmo.saude`.

| Indicador | Verde | Amarelo (segura a rampa) | Vermelho (para 48 h, dia 1) |
|---|---|---|---|
| Bloqueio provável (1 tique sem entrega depois de 6 h) | até 2% | 2% a 4% | acima de 4% |
| "Não quero" + "pare" | até 3% | 3% a 5% | acima de 5% |
| Irritação, spam, denúncia, Procon | 0 | 1 no dia | 2 ou mais |
| Taxa de resposta (depois de 30 aberturas, janela de 7 dias) | 5% ou mais | entre 3% e 5% | abaixo de 3% |
| Conexão | open | 1 reconexão no dia | close, 428 ou logout |

- **Amarelo** segura a rampa (`abrirDia` só sobe o degrau com saúde verde) e a pior cor do dia vence: um amarelo
  gravado de manhã não some à tarde porque o denominador cresceu.
- **Vermelho** pausa o chip por `vermelhoHoras` (48), volta ao dia 1 da rampa e fica vermelho: o cálculo nunca o
  desfaz. Só a mão do operador devolve o chip (saúde verde, `pausado_ate` nulo, estado conforme a decisão dele). Depois
  de devolvido no mesmo dia, a conta só olha o que aconteceu depois do vermelho gravado, para o evento antigo não
  derrubar o chip de novo. O "desce 2 degraus" do plano para "não quero" alto fica contido na volta ao dia 1; o dia
  que o chip tinha antes continua no histórico (`disparo_saude_dia`) para o operador escolher onde retomar.
- **Erro de envio com sinal de restrição** (o freio que já existia) agora também volta o chip ao dia 1 e grava o
  motivo.
- Os percentuais só são avaliados com amostra: `amostraMinima` (5) aberturas no dia para "não quero" e 5 aberturas com
  mais de 6 h para o bloqueio provável. Irritação não tem amostra mínima (uma denúncia basta).
- Painel diário: aba **Chips** da tela Disparo, uma linha por chip (saúde, dia da rampa, aberturas, respostas, taxa,
  bloqueio provável, não quero, irritação, estado) com o motivo do amarelo ou do vermelho. Lê `disparo_saude_dia` por
  `GET /api/v1/disparo/chips`.

### Chip mudo: envios seguidos sem nenhuma confirmação

A Evolution aceita o envio (2xx com `key.id`) mesmo quando o chip parou de entregar; sem freio, o motor gravava
`enviado` e seguia mandando. Regra, em
`lib/disparo/sem-confirmacao.ts`, conferida a cada volta do chip antes de qualquer envio:

- **8 envios reais seguidos** do chip sem NENHUMA confirmação (nem o 1 tique do servidor, nem entrega, nem leitura),
  o mais antigo deles com **pelo menos 30 min**. Simulado não conta. Um único ack no meio quebra a sequência.
- **Com `ritmo.saude.ligado`**: o chip para pelo freio de saúde de sempre — saúde vermelha e `pausado_ate` por
  `vermelhoHoras` (48 h). O dia da rampa não é mexido nesta hora; a volta é a regra de saúde que já existe (depois da
  pausa, com a conexão de pé, volta amarelo no dia 1; ou quando o operador devolve o chip).
- **Com a saúde desligada**: nada muda sozinho. Só o aviso, que diz que os envios NÃO foram pausados.
- **Aviso na Central**: um só aberto por chip (`Disparo: chip sem confirmação de entrega (<chip>)…`), atualizado no
  lugar; fecha sozinho quando um envio feito depois dele é confirmado. Com o freio ligado, os envios anteriores ao
  último aviso do chip não contam de novo — é o que deixa o operador devolver o chip sem o histórico o parar outra vez.

### Fila presa em chip parado: só aviso

A fila é buscada POR CHIP, então o envio vencido de um chip que não manda fica parado para sempre (conexão
`STOPPED` ou saúde vermelha). O motor **não** move fila entre chips — cada lead tem o seu
chip e a regra de `chip_origem` vale; decidir é do dono. A cada volta da organização (`lib/disparo/fila-presa.ts`):

- chip parado = saúde vermelha, estado `pausado`/`desligado`, ou (só no modo real) sem conexão ligada ou com a
  conexão fora de `WORKING`/`OPEN` (arquivada inclusive). A pausa curta de 10 min depois de uma falha não conta;
- conta, por chip parado, os envios `pendente` já vencidos (fora lembretes) e o mais antigo; só entra o chip cujo
  envio mais antigo venceu há pelo menos 30 min;
- **um aviso por organização** na Central (`Disparo: envios vencidos presos em chip parado (N no total)`), com uma
  linha por chip (nome, por que está parado, quantos, desde quando), regravado só quando o texto muda e fechado
  sozinho quando nenhum chip parado tem fila vencida.

### Nova tentativa só depois de conferir se a anterior saiu

O canal pode estourar o tempo (30 s texto, 120 s mídia), dar 5xx ou cair a conexão DEPOIS de a mensagem sair. A nova
tentativa (10 min depois, até 3 vezes; a abertura ganha uma 4ª 24 h depois) não muda, mas antes de chamar o canal de
novo o motor confere na conversa (`messages` da organização) se já há saída para o contato com o mesmo corpo desde a
criação do envio (mídia sem legenda: qualquer mídia que saiu depois):

- **achou**: o envio fica `enviado` com o id achado e o motivo "a tentativa anterior deu erro, mas a mensagem saiu";
  nada é reenviado e a cadência segue como num envio;
- **a conferência falhou**: não reenvia nesta volta (volta à fila em 10 min, sem gastar tentativa);
- **respondeu e não achou**: reenvia, como antes.
- Erro que prova que nada saiu (`evolution_4xx`, sem WhatsApp, erro antes do canal) reenvia sem conferir, como antes.
- Limite: a conferência depende do eco do WhatsApp ter chegado ao CRM; se o webhook também falhou, ela não acha e o
  motor reenvia.

### De onde vêm os dados, e a limitação

- **Aberturas, respostas, não quero e irritação** vêm de `disparo_envios` e das mensagens recebidas (`messages`,
  direção de entrada, sem as automáticas), classificadas pelas mesmas regras de parada do motor
  (`lib/disparo/regras.ts`).
- **Status de entrega (1 tique, entregue, lido)**: a Evolution manda `messages.update`; a tradução do webhook já a
  convertia em `message.ack` para `messages`, mas `disparo_envios` não era atualizado. Agora o ingest da Evolution
  também grava `disparo_envios.ack/ack_em/entregue_em/lido_em`, casando por `external_id` (o `key.id` que o envio
  devolve). O que a ingestão já fazia não mudou.
- **Conexão**: `connection.update` (com `statusReason`) e `logout.instance` viram linhas de
  `disparo_eventos_conexao`. Close, 428 e 401 são queda; `connecting` seguido de `open` sem queda é reconexão.
- **Limitação**: só chega o que a Evolution manda. Se a instância não assina `MESSAGES_UPDATE`, `ack` fica nulo e o
  bloqueio provável aparece como "sem dado" (cobertura mínima de 50% das aberturas com status), nunca como vermelho.
  Em modo simulado não há entrega nenhuma: o indicador também fica sem dado. O ack só sobe (um 1 atrasado não rebaixa
  um 3). A taxa de resposta usa uma janela de 7 dias porque um dia só da rampa (10 a 36 aberturas) quase nunca chega
  a 30. Sem prova em chip real nesta etapa: a conta e o recebimento estão cobertos por teste, o envio real continua
  parado.

## Quarentena e frequência por lead (`ritmo.quarentena`)

- Lead que recebeu **todos os toques** (o passo marcado como último da cadência) **sem responder** entra em
  quarentena de **45 dias** (`disparo_quarentena`) e não é aberto de novo.
- **No máximo 1 abordagem fria por lead a cada 30 dias** e **3 mensagens do motor sem resposta** nessa janela. A busca
  da próxima abertura (`proximoLeadParaAbertura`) pula quem estiver em quarentena, tiver abertura recente ou já tiver 3
  mensagens sem resposta; cada toque também confere o limite antes de sair.
- Respondeu = sai da cadência (o motor já cancelava os pendentes). Opt-out e parada continuam **permanentes**
  (`contacts.is_blocked`, `nao_contatar`) e valem antes de tudo.
- Hoje a abertura continua sendo única por lead (índice `disparo_envios_passo_unico`); a quarentena e a janela de 30
  dias são a regra explícita para quando uma segunda abordagem (template pelo trilho B, anúncio) for permitida.
- **Atenção na organização B**: a cadência `prospeccao_14_dias` manda 4 mensagens automáticas (abertura, D2, D7, D14). Com o
  default de 3 sem resposta por mês, o D14 seria barrado. Ao ligar essa organização, gravar
  `ritmo.quarentena.maxSemRespostaMes = 4` no jsonb dela. A organização A (3 toques) não é
  afetado.
- Tudo desliga por organização com `ritmo.saude.ligado = false` e `ritmo.quarentena.ligado = false`.
