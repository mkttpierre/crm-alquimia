/**
 * Capacidades de TRABALHO DA EQUIPE: tarefas e quem está esperando resposta.
 *
 * Tarefas não tinham ferramenta até aqui. Elas são a saída combinada para o que o agente NÃO faz: o agente externo
 * para antes de fechar a venda e cria uma tarefa para uma pessoa da equipe (`lib/mcp/fechamento-humano.ts`). Criar e
 * mudar a situação exigem `agent`, como a rota da tela (`POST /api/v1/tasks`, `PATCH /api/v1/tasks/[id]`).
 */
import { declararTools } from "./tipos";

export const TOOLS_TRABALHO = declararTools([
  {
    name: "crm_list_tasks",
    category: "read",
    rotulo: "Ver as tarefas da equipe",
    explicacao: "Mostra as tarefas da equipe em ordem de prazo, com o negócio e o contato de cada uma e para quem ela é.",
    oQueToca: "Tarefas da equipe",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },
  {
    name: "crm_create_task",
    category: "write",
    rotulo: "Criar tarefa para alguém da equipe",
    explicacao:
      "Deixa uma tarefa com prazo para uma pessoa ou um agente da equipe, por exemplo para fechar uma venda que o assistente conduziu até o fim.",
    oQueToca: "Tarefas da equipe",
    risco: "atencao",
    pacotes: ["organizar", "atender", "vender"],
  },
  {
    name: "crm_update_task_status",
    category: "write",
    rotulo: "Marcar tarefa como feita ou em andamento",
    explicacao: "Muda a situação de uma tarefa da equipe: pendente, em andamento, feita ou cancelada.",
    oQueToca: "Tarefas da equipe",
    risco: "atencao",
    pacotes: ["organizar"],
  },
  {
    name: "crm_list_waiting_conversations",
    category: "read",
    rotulo: "Ver quem está esperando resposta",
    explicacao:
      "Mostra as conversas em que o cliente escreveu por último e ninguém respondeu há alguns minutos, das mais antigas para as mais novas.",
    oQueToca: "Conversas do WhatsApp",
    risco: "seguro",
    pacotes: ["atender"],
  },
]);
