/**
 * Capacidades do MOTOR DE DISPARO — ler e operar as aberturas automáticas pelo WhatsApp.
 *
 * Feitas para os agentes EXTERNOS da equipe (OpenBot, Claude Code, Codex), que entram com papel de gestor. TODAS são
 * `apenasHumano` para o assistente nativo: a régua é a da tela `/app/disparo`, que exige `manager` — o assistente que
 * atende cliente não opera o motor. Quem trava é `requiresRole` (`manager`; trocar o modo, `admin`); a marca só diz
 * isso à tela de capacidades.
 *
 * Pacote: `escalar` ("passar para um humano"), e NÃO `organizar`. O pacote só serve à tela de
 * capacidades do assistente nativo, que nunca monta estas nove (`apenasHumano`): em `organizar`
 * elas somavam 30 vagas contra o teto de `TETO_TOOLS_POR_AGENTE` e tornavam o pacote inteiro
 * inatingível (`tests/unit/pacote-reserva-vaga-da-critica.test.ts`). O agente externo as alcança
 * pelo MCP, sem passar por pacote.
 *
 * Risco das escritas: `critico` — pausar, retomar e mudar o ritmo mudam o que sai da empresa sem ninguém olhando.
 */
import { declararTools } from "./tipos";

export const TOOLS_DISPARO = declararTools([
  {
    name: "crm_disparo_estado",
    category: "read",
    rotulo: "Ver como está o motor de disparo",
    explicacao:
      "Mostra se o motor de mensagens automáticas está ligado, se envia de verdade ou só simula, a janela de hoje e o que está na fila.",
    oQueToca: "Motor de disparo",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disparo_fila",
    category: "read",
    rotulo: "Ver a fila do motor de disparo",
    explicacao:
      "Mostra as mensagens automáticas que vão sair, para quem, por qual número e a que horas, e as que já saíram ou falharam.",
    oQueToca: "Motor de disparo",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disparo_chips",
    category: "read",
    rotulo: "Ver a saúde dos números do motor",
    explicacao:
      "Mostra cada número de WhatsApp usado pelo motor, se está saudável, quanto enviou hoje, o limite do dia e por que está amarelo ou vermelho.",
    oQueToca: "Números do motor de disparo",
    risco: "seguro",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disparo_pausar_chip",
    category: "write",
    rotulo: "Pausar um número do motor",
    explicacao: "Faz um número parar de enviar mensagens automáticas até alguém retomar. Nada é apagado.",
    oQueToca: "Números do motor de disparo",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disparo_retomar_chip",
    category: "write",
    rotulo: "Retomar um número do motor",
    explicacao:
      "Faz um número pausado voltar a enviar mensagens automáticas, sem passar por cima do freio de saúde dele.",
    oQueToca: "Números do motor de disparo",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disparo_pausar_motor",
    category: "write",
    rotulo: "Pausar o motor de disparo",
    explicacao: "Para todas as mensagens automáticas da empresa até alguém retomar, e avisa quem acompanha o motor.",
    oQueToca: "Motor de disparo",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disparo_retomar_motor",
    category: "write",
    rotulo: "Retomar o motor de disparo",
    explicacao:
      "Liga de novo as mensagens automáticas da empresa, sempre sob a trava que separa o envio de verdade da simulação.",
    oQueToca: "Motor de disparo",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disparo_ajustar_ritmo",
    category: "write",
    rotulo: "Ajustar o ritmo do motor de disparo",
    explicacao:
      "Muda horários, intervalos, pausas, limites por hora e por dia, mensagens e palavras proibidas do motor, com as mesmas regras da tela.",
    oQueToca: "Motor de disparo",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
  {
    name: "crm_disparo_trocar_modo",
    category: "write",
    rotulo: "Trocar o motor entre simulação e envio de verdade",
    explicacao:
      "Liga a primeira das duas chaves do envio de verdade. A segunda fica no servidor da empresa e só quem cuida dele muda.",
    oQueToca: "Motor de disparo",
    risco: "critico",
    pacotes: ["escalar"],
    apenasHumano: true,
  },
]);
