// @vitest-environment node
/**
 * Resposta automática do negócio: a Forneria Exemplo respondeu a D1 com a saudação automática do
 * WhatsApp Business (cupom, link do app, "Das 18:00 às 22:30"). O horário bateu na regra de horário da prospecção,
 * virou lead quente, mandou dois avisos ao operador e cancelou o D2. Mensagem de robô não é resposta do lead.
 */
import { describe, expect, it } from "vitest";

import { CONFIG_PROSPECCAO_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./atendimento/apoio-de-teste";
import { atenderMensagem } from "./atendimento/atendimento";
import { criarJulgar } from "./atendimento/jev";
import { ehRespostaAutomatica } from "./resposta-automatica";

const SAUDACAO_ROBO = `‎Forneria Exemplo agradece seu contato.

Você pode fazer o seu pedido com muito mais praticidade pelo nosso aplicativo 😍

📲https://exemplo.com/pedido/

É tão prático que nem precisa instalar, é só clicar no link e montar a seu pedido.

Para agradecer a sua visita, pegue esse super desconto na primeira compra 🍕 15% off.

Cupon : CUPOM10

Endereço: Rua Exemplo, 100
Horário de Funcionamento:
Terça a Domingo
Das 18:00 às 22:30
Sexta e Sábado até as 23:00

Obrigado e  volte sempre.`;

describe("ehRespostaAutomatica", () => {
  it.each([
    SAUDACAO_ROBO,
    "Olá! Agradecemos o seu contato. Em breve retornaremos sua mensagem.",
    "*Resposta Automática* Estamos fora do horário de atendimento.",
    "Olá, tudo bem? No momento não estamos disponíveis. Deixe sua mensagem que responderemos assim que possível.",
    "Seja bem-vindo à Barbearia X! Digite 1 para agendar, 2 para preços, 3 para falar com atendente.",
    "Oi! Sou a assistente virtual da Clínica Sorriso. Como posso ajudar?",
    "Obrigado por entrar em contato com a Padaria Bela Vista! Nosso horário de atendimento é de segunda a sábado, das 7h às 20h. Confira nosso cardápio: https://bit.ly/x",
    // Escaparam numa semana do relatório da organização B: saudação de boas-vindas sem as frases "fortes".
    "Olá! 🥰 Seja muito bem-vinda à Clínica Exemplo! 💕\n\nSerá um prazer cuidar de você! ✨",
    "🇮🇹 Ciao! Benvenuto alla Cantina Exemplo!\n\nQue prazer receber sua mensagem! Será um prazer receber você em nossa casa. 🍷\n\nNossa equipe verificará a disponibilidade e retornará assim que possível com a confirmação.\n\nSe tiver qualquer dúvida, pode nos escrever por aqui! Em breve, nossa equipe retornará para atender.",
    "Bom dia, Pedro! Aqui é o Beto, assistente virtual de IA da Barbearia Exemplo. Vou encaminhar para a nossa equipe, que entrará em contato em breve.",
  ])("reconhece mensagem de robô: %s", (texto) => {
    expect(ehRespostaAutomatica(texto)).toBe(true);
  });

  it.each([
    "quero ver",
    "Opa, pode mandar!",
    "Obrigado pelo contato, mas não temos interesse",
    "quanto custa?",
    "pode ser amanhã às 15h",
    "Quem é?",
    "Nosso horário é corrido, me chama à noite",
    "Ficou lindo! Manda o link https://exemplo.com",
    "não tenho interesse, obrigado",
    "Seja bem-vindo, pode mandar sim",
    "Será um prazer ver, manda aí",
    "Nossa equipe vai olhar e eu te retorno amanhã",
  ])("não confunde resposta de pessoa: %s", (texto) => {
    expect(ehRespostaAutomatica(texto)).toBe(false);
  });
});

describe("atendimento com resposta automática do negócio", () => {
  const ORG = "44444444-4444-4444-8444-444444444444";
  const AGORA = new Date("2026-10-30T12:59:38Z");

  it("só registra: sem lead quente, sem aviso e sem cancelar a cadência", async () => {
    const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG), { ...CONFIG_PROSPECCAO_EXEMPLO, diagnostico: null } as typeof CONFIG_PROSPECCAO_EXEMPLO);
    const lead = repo.novoLead("forneria-exemplo", { campos: {} });
    repo.pendentesDoMotor.push({ leadId: lead.id, estado: "pendente" });
    const r = await atenderMensagem({ repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave: null }) }, ORG, lead.id, {
      chave: "robo-1",
      messageId: null,
      texto: SAUDACAO_ROBO,
      midia: false,
    });
    expect(r.resultado).toBe("registrada");
    expect(r.resumo).toContain("resposta automática");
    expect(repo.avisos).toHaveLength(0);
    expect(repo.conversas.get(lead.id)?.quente ?? false).toBe(false);
    expect(repo.pendentesDoMotor[0]!.estado).toBe("pendente");
    expect(repo.enviosDo(lead.id)).toHaveLength(0);
  });
});
