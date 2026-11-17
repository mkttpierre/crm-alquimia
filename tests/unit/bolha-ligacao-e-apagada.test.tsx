import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { Message } from "@/lib/types/messaging";

/**
 * A CONVERSA DESENHA A LIGAÇÃO E A MENSAGEM APAGADA (decisão de 13/11/2026).
 *
 *  - Ligação (nota `type=system` com `metadata.ligacao`, gravada por
 *    `lib/channels/evolution/ligacoes.ts`): rótulo e ícone de telefone próprios,
 *    hora no fuso de São Paulo — nunca o "Nota interna" das outras notas.
 *  - Apagada pelo cliente: o operador vê o texto original, esmaecido, com a marca
 *    "apagada pelo cliente" (antes a bolha escondia o texto).
 *
 * Prova pelo que aparece na tela, não pelo fonte.
 */

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "o1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    error_code: null,
    error_message: null,
    body: "pode mandar o boleto de 300",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: null,
    sent_by_user_id: null,
    sent_at: "2026-11-13T17:05:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: null,
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-11-13T17:05:00.000Z",
    ...over,
  } as Message;
}

const ligacao = (desfecho: string, inicio = "2026-11-13T17:05:00.000Z") =>
  msg({
    type: "system",
    direction: "outbound",
    sent_via: "system",
    status: "sent",
    external_id: "ligacao:CALL-1",
    body: `Ligação ${desfecho} às 14:05`,
    metadata: { ligacao: { id: "CALL-1", desfecho, inicio, estados: ["offer"], feita: false, video: false } } as never,
  });

describe("ligação na conversa", () => {
  it.each([
    ["recebida", "Ligação recebida às 14:05"],
    ["perdida", "Ligação perdida às 14:05"],
    ["feita", "Ligação feita às 14:05"],
  ])("%s: rótulo próprio com a hora de São Paulo, ícone de telefone, nunca 'Nota interna'", (desfecho, texto) => {
    const { container } = render(<MessageBubble message={ligacao(desfecho)} />);
    expect(screen.getByText(texto)).toBeInTheDocument();
    expect(screen.queryByText("Nota interna")).toBeNull();
    expect(container.querySelector(`[data-ligacao="${desfecho}"] svg`)).not.toBeNull();
  });

  it("a hora é a de São Paulo, não a do navegador nem UTC", () => {
    render(<MessageBubble message={ligacao("perdida", "2026-11-14T02:30:00.000Z")} />);
    expect(screen.getByText("Ligação perdida às 23:30")).toBeInTheDocument();
  });

  it("em espanhol o rótulo é traduzido", () => {
    render(
      <IdiomaProvider locale="es">
        <MessageBubble message={ligacao("perdida")} />
      </IdiomaProvider>,
    );
    expect(screen.getByText("Llamada perdida a las 14:05")).toBeInTheDocument();
  });

  it("CONTROLE: nota de sistema que não é ligação segue como 'Nota interna'", () => {
    render(<MessageBubble message={msg({ type: "system", direction: "outbound", body: "transferida para Ana" })} />);
    expect(screen.getByText("Nota interna")).toBeInTheDocument();
    expect(screen.getByText("transferida para Ana")).toBeInTheDocument();
  });
});

describe("mensagem apagada pelo cliente", () => {
  it("o operador vê o texto original esmaecido, com a marca 'apagada pelo cliente'", () => {
    render(<MessageBubble message={msg({ revoked_at: "2026-11-13T17:06:00.000Z" })} />);
    const texto = screen.getByText("pode mandar o boleto de 300");
    expect(texto).toBeInTheDocument();
    expect(texto.closest(".opacity-60")).not.toBeNull();
    expect(screen.getByText("apagada pelo cliente")).toBeInTheDocument();
    expect(screen.queryByText("Esta mensagem foi apagada")).toBeNull();
  });

  it("em espanhol a marca é traduzida", () => {
    render(
      <IdiomaProvider locale="es">
        <MessageBubble message={msg({ revoked_at: "2026-11-13T17:06:00.000Z" })} />
      </IdiomaProvider>,
    );
    expect(screen.getByText("eliminado por el cliente")).toBeInTheDocument();
  });

  it("apagada sem conteúdo nenhum ainda diz que foi apagada", () => {
    render(<MessageBubble message={msg({ body: null, revoked_at: "2026-11-13T17:06:00.000Z" })} />);
    expect(screen.getByText("Esta mensagem foi apagada")).toBeInTheDocument();
  });

  it("CONTROLE: mensagem viva não ganha marca nem esmaecimento", () => {
    render(<MessageBubble message={msg()} />);
    expect(screen.queryByText("apagada pelo cliente")).toBeNull();
    expect(screen.getByText("pode mandar o boleto de 300").closest(".opacity-60")).toBeNull();
  });
});
