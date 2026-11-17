// @vitest-environment node
/**
 * O operador exige que ao lead vá SÓ o conteúdo da mensagem, nunca instrução escrita para ele
 * (roteiro do áudio D4, lembrete da ligação D10, "o CRM percebe sozinho"). O motor já manda esses lembretes
 * para `crm_tasks`; esta trava é a segunda barreira: se um texto assim chegar a qualquer envio, não sai.
 */
import { describe, expect, it } from "vitest";

import { verificarTexto } from "./textos";

const ROTEIRO_D4 = `Áudio do D4 (30 a 60s, sua voz, do WhatsApp do chip). Fale com as suas palavras; o roteiro é só a espinha:

Oi, Dra. Luana, tudo bem? Aqui é o Pedro, te mandei mensagem esses dias.

Enviou pelo chip, o CRM percebe sozinho e segue a cadência.`;

const LIGACAO_D10 = `Ligação do D10: ligue do celular do chip (o número que já apareceu nas mensagens) pra 5511900000003. Se não atender, mande pelo WhatsApp do chip logo depois:

Dra. Luana, tentei te ligar agora há pouco.

Enviou, o CRM percebe sozinho e agenda o encerramento. Se atender, mude a etapa no card e anote como foi.`;

describe("verificarTexto: instrução ao operador nunca sai ao lead", () => {
  it.each([
    ["roteiro do áudio D4", ROTEIRO_D4],
    ["lembrete da ligação D10", LIGACAO_D10],
    ["só o título do lembrete", "Ligação do D10: ligue para a Dra. Luana"],
    ["frase solta do roteiro", "Oi! Fale com as suas palavras; o roteiro é só a espinha."],
    ["aviso de que o CRM acompanha", "Mandei. O CRM percebe sozinho."],
    ["pedido de mudar a etapa", "Se atender, mude a etapa no card."],
  ])("barra: %s", (_nome, texto) => {
    const p = verificarTexto(texto);
    expect(p).toContain("tem instrução ao operador");
  });

  it.each([
    "Dra. Luana, tentei te ligar agora há pouco. Se preferir, me diga um horário bom que eu ligo de novo, ou seguimos por aqui mesmo.",
    "Oi, Dra. Luana, tudo bem? Aqui é o Pedro, te mandei mensagem esses dias. Resolvi gravar porque por texto fica tudo um pouco frio.",
    "Posso ligar amanhã às 15h? Se não der, a gente combina outro dia e outra etapa do projeto.",
    "Qual dia é melhor pra você?",
  ])("deixa passar mensagem de pessoa: %s", (texto) => {
    expect(verificarTexto(texto)).not.toContain("tem instrução ao operador");
  });
});
