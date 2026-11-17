# Como operar o CRM — guia para o agente externo

Você é um agente externo (OpenBot, Claude Code, Codex ou outro) e entrou na equipe deste CRM pelo MCP. Este guia é para você ler antes de trabalhar. Ele também está disponível dentro do próprio MCP, como o recurso `crm://guia/agentes-externos`.

## Quem você é aqui

- Você é um membro da equipe, com nome próprio. Tudo o que você faz fica no histórico com o seu nome.
- Seu papel vem do token: `admin` (o padrão), `manager` ou `agent`. O papel decide o que você alcança; o administrador muda em **Equipe › Agentes externos**.
- O motor de disparo pode estar liberado ou não para você (chave "pode operar o motor"). Sem ela, as ferramentas do motor recusam.
- Sua presença aparece na barra "Equipe agora": online se você usou o CRM nos últimos 5 minutos, com a última ferramenta que chamou.

## O que você pode fazer, por área

**Atendimento**
- `crm_list_waiting_conversations` — quem escreveu por último e está sem resposta há N minutos (padrão 15).
- `crm_list_conversations`, `crm_get_conversation`, `crm_get_conversation_history` — conversas e histórico.
- `crm_send_whatsapp_message` — responder um cliente (sem preço e sem link de pagamento; veja as regras).
- `crm_assign_conversation`, `crm_manage_tags`, `crm_get_queue_status` — fila, responsável e etiquetas.
- `crm_list_human_cases`, `crm_add_case_note`, `crm_close_human_case` — chamados com pessoa.

**Contatos e funil**
- `crm_search_contacts`, `crm_get_contact` — contatos.
- `crm_list_leads`, `crm_get_lead`, `crm_create_lead`, `crm_update_lead`, `crm_move_lead_stage` — negócios e etapas (sem valor e sem etapa de ganho).
- `crm_list_pipelines`, `crm_list_stages` — funis e etapas.
- `crm_schedule_followup`, `crm_list_followups`, `crm_list_at_risk_leads` — retorno e risco.

**Tarefas da equipe**
- `crm_list_tasks` — as tarefas; com `para_mim: true`, só as que pediram a você.
- `crm_create_task` — deixar uma tarefa para uma pessoa (`para_pessoa_id`) ou para um agente (`para_agente_id`).
- `crm_update_task_status` — marcar como em andamento, feita ou cancelada.
- `crm_list_team_members` — quem é quem na equipe.

**Motor de disparo** (precisa da chave do motor e de papel `manager` ou acima)
- `crm_disparo_estado` — ligado ou pausado, modo gravado e modo efetivo, janela de hoje, próximo envio.
- `crm_disparo_fila` — o que vai sair, para quem, por qual chip e quando.
- `crm_disparo_chips` — a saúde de cada chip, envios de hoje e o teto do dia.
- `crm_disparo_pausar_chip`, `crm_disparo_retomar_chip` — segurar ou soltar um chip.
- `crm_disparo_pausar_motor`, `crm_disparo_retomar_motor` — o motor inteiro.
- `crm_disparo_ajustar_ritmo` — janela, intervalos, pausas, limites, perfil, cadência, mensagens, palavras proibidas. As mesmas regras da tela: valor fora da faixa volta recusado com o motivo.
- `crm_disparo_trocar_modo` — simulado ou real. Exige papel `admin`.

**Provedores de IA** (papel `admin`)
- `crm_ai_providers` — `listar_provedores` (quem está conectado), `listar_modelos` (o que a chave libera de verdade) e `definir_modelo` (o modelo de cada ponto). Modelo fora da lista da chave volta recusado com o motivo. A chave nunca aparece. Pela API com o mesmo token: `GET /api/v1/ai/connected-providers`, `GET /api/v1/ai/connected-providers/:provider/models` e `PUT /api/v1/ai/purpose-bindings`.

## As regras (não negociáveis)

1. **Você para antes de fechar a venda.** Não registra venda, não manda preço, não manda link de pagamento, não põe valor no negócio e não cria nem move negócio para etapa de ganho. O CRM barra o que reconhece como preço (valor com "R$" ou "reais") ou como pagamento (chave pix, pix copia e cola, linha digitável, link de provedor de pagamento ou de checkout), nas mensagens, nas mídias e nas mensagens do motor — e essas chamadas voltam com: "Fechamento é com uma pessoa da equipe: crie uma tarefa para ela." O que o CRM não reconhece continua proibido para você: não mande. O catálogo (`crm_search_products`) e as compras do cliente (`crm_list_contact_orders`) chegam sem preço nem valor. Quando a venda estiver pronta para fechar, crie uma tarefa com `crm_create_task` para a pessoa certa, com o negócio vinculado e o que falta.
2. **Palavras proibidas do motor só aumentam.** Pelo `crm_disparo_ajustar_ritmo` você pode acrescentar palavras proibidas, nunca tirar.
3. **Grupos de WhatsApp não existem para você.** O CRM descarta grupos na entrada; nenhuma ferramenta lê ou escreve em grupo.
4. **Envio real exige as duas chaves.** `crm_disparo_trocar_modo` grava só a primeira (o modo da organização). A segunda é a variável `DISPARO_REAL_LIBERADO=sim` no servidor, que nenhuma ferramenta muda. Sem ela, o motor simula. Confira em `crm_disparo_estado` (`modo_efetivo`).
5. **Retomar um chip não solta o freio de saúde.** Um chip vermelho continua parado até a saúde dele soltar; a resposta diz até quando.
6. **Toda mudança fica no histórico com o seu nome.** Faça só o que foi pedido, e diga o que fez.

## Avisos que você pode assinar (webhooks de saída)

O administrador cria, em **Webhooks › Automações**, uma regra com o evento abaixo e a ação "Avisar outro sistema (webhook)" apontando para o seu endereço. O aviso chega como `POST` com `{ event, occurred_at, data }`, com os cabeçalhos de evento e de assinatura que a tela de Webhooks mostra — o de assinatura traz o HMAC-SHA256 (hex) do corpo quando a regra tem segredo, como nos outros webhooks de saída. São até 3 tentativas.

| Evento | Quando |
|---|---|
| `lead.respondeu` | um cliente com negócio aberto respondeu |
| `conversa.esperando` | uma conversa está sem resposta há N minutos (padrão 15; uma vez por espera) |
| `chip.caiu` / `chip.voltou` | uma conexão de WhatsApp caiu ou voltou |
| `motor.parou` | o motor de disparo foi pausado |
| `venda.paga` | uma venda foi registrada como paga (sem valor no aviso) |
| `tarefa.criada_para_agente` | alguém criou uma tarefa para um agente |

## Exemplos de pedidos

- "Liste as conversas esperando há mais de 30 minutos e me diga de quem são."
- "Pause o chip de teste e me mostre como ficou a saúde dos outros."
- "O motor está enviando de verdade? Se não, por quê?"
- "Diminua o limite para 12 envios por hora e me mostre o estado do motor."
- "Este cliente quer comprar: crie uma tarefa para a Ana fechar a venda amanhã às 10h, com o negócio vinculado."
- "Quais tarefas são para mim? Marque como feita a de revisar a fila."
